const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth } = require('../auth.postgres');

const router = express.Router();

// "Own sales only" (Sep 1 2026, Sales Rep Access): resolves which rep
// NAME a non-owner request is actually allowed to act as/see, by
// looking up their linked rep record via email — never trusting a
// client-supplied `rep` field, since that's just a string a request
// could put anything in. An owner passes through untouched (keeps
// today's flexibility — backfilling historical sales under any rep
// name, entering a sale for a rep not yet linked, etc). Returns null
// for a rep with no linked record yet, same "nothing shared/allowed
// yet" default used in reps.js, rather than guessing or erroring oddly.
async function resolveRepNameForRequest(req) {
  if(req.user.role === 'owner') return undefined; // undefined = no forced filter
  const repRow = await db.prepare('SELECT name FROM reps WHERE email = ?').get(req.user.email);
  return repRow?.name || null;
}

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { orderRef, rep, customerName, crates, pricePerCrate, deliveryTotal, commission,
          batchId, batchCost, paymentMethod, saleDate, invoiceRef } = req.body;

  // A rep can only ever record a sale as themselves — the client-
  // supplied `rep` field is ignored/overridden for non-owner requests,
  // and rejected outright if this login isn't linked to a rep record
  // at all (see resolveRepNameForRequest). Owners keep full flexibility.
  const forcedRep = await resolveRepNameForRequest(req);
  if(req.user.role !== 'owner' && !forcedRep) {
    return res.status(403).json({ error: 'Your login isn\'t linked to a rep record yet — ask the owner to link it.' });
  }
  const effectiveRep = forcedRep !== undefined ? forcedRep : rep;

  if(!effectiveRep || !customerName || !crates || !pricePerCrate || !paymentMethod) {
    return res.status(400).json({ error: 'rep, customerName, crates, pricePerCrate, and paymentMethod are required.' });
  }

  // Resolve the real customer record so customer_id is a genuine FK link
  // instead of the NULL it's always been — customer_name stays as the
  // immediate display value, customer_id is what lets a sale be traced
  // back to the full customer record (cid, contact, credit history, etc).
  // A customer created after this sale, or a name that doesn't match
  // exactly, still leaves it null rather than blocking the sale.
  const customerRow = await db.prepare('SELECT id FROM customers WHERE name = ?').get(customerName);

  // Verify batchId actually exists before trusting it (Sep 4 2026) —
  // found via a real crash: a sale created weeks ago (Justina Manilla,
  // Gboloba Farms, Aug 22) referencing a batch (B019) that had since
  // been cleaned up kept getting retried by the client's self-healing
  // sync, and every retry 500'd, apparently silently, for weeks —
  // surfaced only once someone was actually watching the Railway logs
  // during unrelated testing. A sale's batch reference going stale
  // over time is normal and expected (batches get depleted, written
  // off, or deleted; sales are permanent history) — it should never
  // be able to crash the whole insert. Falls back to null exactly like
  // "no batch was ever specified" rather than blocking the sale or
  // losing its other fields.
  let safeBatchId = null;
  if(batchId) {
    const batchExists = await db.prepare('SELECT id FROM batches WHERE id = ?').get(batchId);
    safeBatchId = batchExists ? batchId : null;
  }

  const gross = crates * pricePerCrate;
  const info = await db.prepare(`
    INSERT INTO sales (order_ref, rep, customer_id, customer_name, crates, price_per_crate, gross, delivery_total,
      commission, batch_id, batch_cost, payment_method, sale_date, invoice_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderRef || null, effectiveRep, customerRow?.id || null, customerName, crates, pricePerCrate, gross, deliveryTotal || 0,
    commission || 0, safeBatchId, batchCost || null, paymentMethod, saleDate || new Date().toISOString().split('T')[0], invoiceRef || null);

  // Real multi-batch FIFO deduction — same logic verified in the
  // SQLite version, converted to properly-awaited Postgres calls.
  // Uses safeBatchId, not the raw client value — a stale/deleted batch
  // reference should skip deduction cleanly (nothing to draw down),
  // not silently misattribute the draw to whatever batch happens to
  // sort first.
  if(safeBatchId) {
    let remaining = crates;
    const batches = await db.prepare('SELECT * FROM batches WHERE remaining > 0 ORDER BY received_date ASC').all();
    const startIdx = batches.findIndex(b => b.id === safeBatchId);
    const orderedBatches = startIdx >= 0 ? batches.slice(startIdx) : batches;
    for(const b of orderedBatches) {
      if(remaining <= 0) break;
      const take = Math.min(remaining, b.remaining);
      await db.prepare('UPDATE batches SET remaining = remaining - ? WHERE id = ?').run(take, b.id);
      remaining -= take;
    }
  }

  res.status(201).json(await db.prepare('SELECT * FROM sales WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  const { from, to, rep } = req.query;

  // "Own sales only" for reps — same forced-filter approach as POST.
  // A rep with no linked record sees an empty list, not an error or
  // (worse) everyone's sales by accident.
  const forcedRep = await resolveRepNameForRequest(req);
  if(req.user.role !== 'owner' && !forcedRep) {
    return res.json([]);
  }
  const effectiveRepFilter = forcedRep !== undefined ? forcedRep : rep;

  let query = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if(from) { query += ' AND sale_date >= ?'; params.push(from); }
  if(to)   { query += ' AND sale_date <= ?'; params.push(to); }
  if(effectiveRepFilter) { query += ' AND rep = ?'; params.push(effectiveRepFilter); }
  query += ' ORDER BY sale_date DESC, created_at DESC';
  res.json(await db.prepare(query).all(...params));
});

// Narrow, portal-facing — only what checkPriceChangeSinceLastOrder()
// needs (Phase 2A: current vs. last price the customer paid, no
// reasoning about *why* it changed — that needs priceHistory exposed
// too, deferred to a later pass). Never returns anything else about
// the sale or the customer.
router.get('/last-price', requireEitherAuth(), async (req, res) => {
  const customerName = (req.query.customer || '').trim();
  if(!customerName) return res.json(null);
  const row = await db.prepare(
    `SELECT price_per_crate, sale_date FROM sales WHERE customer_name = ? ORDER BY sale_date DESC, created_at DESC LIMIT 1`
  ).get(customerName);
  res.json(row ? { price: row.price_per_crate, date: row.sale_date } : null);
});

module.exports = router;
