const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth, requireRole } = require('../auth.postgres');
const scope = require('../lib/rep-scope');

const router = express.Router();

// Oct 13 2026 — reps tied to logins, customers tied to reps.
//
// WHO MAY RECORD A SALE, AND AS WHOM
//   owner    any rep name (backfilling, entering for a rep not yet linked ...) — as before.
//   manager  on behalf of a rep that exists in the reps table (the sale is stamped with the manager's e-mail
//            in entered_by, so it is always clear who typed it in).
//   rep      only as themselves, and only for their own customers (or customers nobody owns yet). The rep name
//            on the sale is taken from the login, never from what the screen sent.
// Before this, a manager login was refused here with "not linked to a rep record" while the ERP carried on
// as if the sale had been saved (Oct 13: the Ese YB Shop sale was lost that way).
//
// A rep's FIRST sale to a customer nobody owns yet makes that rep the customer's rep ("the rep who pitched
// them"). The Owner can move a customer or a single sale to another rep at any time (see below).

async function activeRepNamed(name) {
  return db.prepare("SELECT name FROM reps WHERE name = ? AND COALESCE(status, 'active') <> 'inactive'").get(name);
}

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { orderRef, rep, customerName, crates, pricePerCrate, deliveryTotal, commission,
          batchId, batchCost, paymentMethod, saleDate, invoiceRef } = req.body;

  const sc = await scope.scopeOf(req);
  if(!sc.all && !sc.rep) return res.status(403).json(scope.NOT_LINKED);

  const effectiveRep = sc.all ? rep : sc.rep;
  if(!effectiveRep || !customerName || !crates || !pricePerCrate || !paymentMethod) {
    return res.status(400).json({ error: 'rep, customerName, crates, pricePerCrate, and paymentMethod are required.' });
  }
  if(sc.role === 'manager' && !(await activeRepNamed(effectiveRep))) {
    return res.status(400).json({ error: `"${effectiveRep}" is not a sales rep on record. Pick one of the listed reps.`, code: 'UNKNOWN_REP' });
  }

  // The same sale arriving twice (a retry after a lost answer) must not be written twice.
  if(invoiceRef) {
    const dup = await db.prepare('SELECT * FROM sales WHERE invoice_ref = ? LIMIT 1').get(invoiceRef);
    if(dup) return res.status(200).json({ ...dup, alreadySaved: true });
  }

  // Resolve the real customer record so customer_id is a genuine FK link
  // (customer_name stays as the immediate display value).
  const customerRow = await db.prepare('SELECT id, owner_rep FROM customers WHERE name = ?').get(customerName);
  if(!sc.all && customerRow && customerRow.owner_rep && customerRow.owner_rep !== sc.rep) {
    return res.status(403).json(scope.NOT_YOURS);
  }

  // Verify batchId / orderRef exist before trusting them (Sep 4-5 2026) — a stale reference must never be
  // able to crash the insert; it falls back to null exactly like "none was specified".
  let safeBatchId = null;
  if(batchId) {
    const batchExists = await db.prepare('SELECT id FROM batches WHERE id = ?').get(batchId);
    safeBatchId = batchExists ? batchId : null;
  }
  let safeOrderRef = null;
  if(orderRef) {
    const orderExists = await db.prepare('SELECT ref FROM orders WHERE ref = ?').get(orderRef);
    safeOrderRef = orderExists ? orderRef : null;
  }

  const gross = crates * pricePerCrate;
  const info = await db.prepare(`
    INSERT INTO sales (order_ref, rep, customer_id, customer_name, crates, price_per_crate, gross, delivery_total,
      commission, batch_id, batch_cost, payment_method, sale_date, invoice_ref, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(safeOrderRef, effectiveRep, customerRow?.id || null, customerName, crates, pricePerCrate, gross, deliveryTotal || 0,
    commission || 0, safeBatchId, batchCost || null, paymentMethod, saleDate || new Date().toISOString().split('T')[0], invoiceRef || null,
    (req.user && req.user.email) || null);

  // Real multi-batch FIFO deduction.
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

  // First sale to a customer nobody owns yet: the closing rep becomes the customer's rep.
  if(customerRow && !customerRow.owner_rep && effectiveRep !== 'Direct') {
    try {
      const claimed = await db.prepare(`UPDATE customers SET owner_rep = ?, owner_rep_set_by = 'first sale', owner_rep_set_at = now() WHERE id = ? AND owner_rep IS NULL`).run(effectiveRep, customerRow.id);
      if(claimed.changes) {
        await db.prepare(`INSERT INTO rep_handovers (kind, ref, subject, from_rep, to_rep, reason, by_email) VALUES ('customer', ?, ?, NULL, ?, 'First sale', ?)`)
          .run(customerName, customerName, effectiveRep, (req.user && req.user.email) || null);
      }
    } catch(e) { console.warn('[sales] could not tie customer to rep:', e.message); }
  }

  res.status(201).json(await db.prepare('SELECT * FROM sales WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  const { from, to, rep } = req.query;

  const sc = await scope.scopeOf(req);
  // A rep with no linked record sees an empty list, not an error and not everyone's sales.
  if(!sc.all && !sc.rep) return res.json([]);
  const effectiveRepFilter = sc.all ? rep : sc.rep;

  let query = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if(from) { query += ' AND sale_date >= ?'; params.push(from); }
  if(to)   { query += ' AND sale_date <= ?'; params.push(to); }
  if(effectiveRepFilter) { query += ' AND rep = ?'; params.push(effectiveRepFilter); }
  query += ' ORDER BY sale_date DESC, created_at DESC';
  res.json(await db.prepare(query).all(...params));
});

// ── Owner hands a sale to another rep ──────────────────────────────────────
// The sale (and the commission already worked out on it) moves to the other rep's figures: their ledger,
// their End-of-Day report and their commission. The Owner must give a reason; the move is logged for good
// and the original rep is kept on the sale (handed_over_from).
router.post('/handover', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { invoiceRef, rep, reason } = req.body || {};
  const why = String(reason || '').trim();
  if(!invoiceRef) return res.status(400).json({ error: 'invoiceRef is required.' });
  if(why.length < 5) return res.status(400).json({ error: 'Give a short reason (at least 5 characters).' });
  const sale = await db.prepare('SELECT * FROM sales WHERE invoice_ref = ? ORDER BY id DESC LIMIT 1').get(String(invoiceRef));
  if(!sale) return res.status(404).json({ error: 'That sale is not on the server yet. Open the ERP on the device that recorded it, signed in as the Owner, and let it finish syncing first.', code: 'SALE_NOT_SAVED' });
  const target = await activeRepNamed(String(rep || ''));
  if(!target) return res.status(400).json({ error: 'Pick a sales rep from the list.' });
  if(target.name === sale.rep) return res.status(400).json({ error: `That sale already belongs to ${sale.rep}.` });
  const by = (req.user && req.user.email) || null;
  await db.prepare(`UPDATE sales SET rep = ?, handed_over_from = ?, handed_over_by = ?, handed_over_at = now(), handover_reason = ? WHERE id = ?`)
    .run(target.name, sale.rep, by, why.slice(0, 300), sale.id);
  await db.prepare(`INSERT INTO rep_handovers (kind, ref, subject, from_rep, to_rep, reason, by_email) VALUES ('sale', ?, ?, ?, ?, ?, ?)`)
    .run(String(invoiceRef), sale.customer_name, sale.rep, target.name, why.slice(0, 300), by);
  console.log(`[audit] Sale ${invoiceRef} handed over from ${sale.rep} to ${target.name} by ${by}`);
  res.json(await db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id));
});

router.get('/handovers', requireSupabaseAuth(), requireRole('owner', 'manager'), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM rep_handovers ORDER BY id DESC LIMIT 200').all());
});

// Narrow, portal-facing — only what checkPriceChangeSinceLastOrder()
// needs. Never returns anything else about the sale or the customer.
router.get('/last-price', requireEitherAuth(), async (req, res) => {
  const customerName = (req.query.customer || '').trim();
  if(!customerName) return res.json(null);
  const row = await db.prepare(
    `SELECT price_per_crate, sale_date FROM sales WHERE customer_name = ? ORDER BY sale_date DESC, created_at DESC LIMIT 1`
  ).get(customerName);
  res.json(row ? { price: row.price_per_crate, date: row.sale_date } : null);
});

module.exports = router;
