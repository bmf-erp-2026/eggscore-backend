const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Payment Holds (Oct 10 2026) — the Pending Transfers panel (a customer says
// they have paid by bank transfer but the money has not shown yet) and the
// suspicious-payment flag. Until now these lived only in the browser where
// staff logged them, so another phone or laptop showed no hold at all — and
// worse, would tell staff "payment must be verified" for an order that was
// already on hold. Staff only; the customer portal never touches this.

const TYPES = ['pending_transfer', 'phoney_flag', 'csv_match'];
const STATUSES = ['held', 'verified', 'released', 'cancelled', 'disputed'];
const ID_RE = /^ph[0-9A-Za-z]{6,40}$/;
// A hold that has been closed out must never be dragged back to "held" by an
// out-of-date browser copy.
const CLOSED = ['verified', 'released', 'cancelled'];

const STR_FIELDS = {
  orderRef: 60, customerName: 160, holdType: 30, customerBank: 120, txRef: 120,
  claimedAt: 40, verifiedAt: 40, releasedAt: 40, releasedBy: 80, releaseReason: 200,
  cancelledAt: 40, notes: 500, status: 20,
};
const NUM_FIELDS = ['claimedAmount', 'cratesHeld', 'hoursHeld', 'tvAccrued'];

function cleanHold(id, b) {
  const data = { id };
  for(const [k, max] of Object.entries(STR_FIELDS)) {
    if(typeof b[k] === 'string') data[k] = b[k].slice(0, max);
  }
  for(const k of NUM_FIELDS) {
    if(typeof b[k] === 'number' && Number.isFinite(b[k])) data[k] = b[k];
  }
  if(!data.orderRef) return { error: 'orderRef is required.' };
  if(!TYPES.includes(data.holdType)) return { error: `holdType must be one of: ${TYPES.join(', ')}.` };
  if(!STATUSES.includes(data.status)) return { error: `status must be one of: ${STATUSES.join(', ')}.` };
  return { data };
}

function fromRow(row) {
  const d = (row.data && typeof row.data === 'object') ? row.data : {};
  return {
    ...d,
    id: row.id,
    orderRef: row.order_ref,
    customerName: row.customer_name,
    holdType: row.hold_type,
    status: row.status,
    serverUpdatedAt: row.updated_at && new Date(row.updated_at).toISOString(),
  };
}

router.get('/', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM payment_holds ORDER BY created_at DESC LIMIT 2000').all();
  res.json(rows.map(fromRow));
});

// Create or update one hold. The ERP sends the whole record each time.
router.put('/:id', requireSupabaseAuth(), async (req, res) => {
  const id = String(req.params.id || '');
  if(!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid hold id.' });
  const c = cleanHold(id, req.body || {});
  if(c.error) return res.status(400).json({ error: c.error });
  const by = (req.user && req.user.email) || null;

  const existing = await db.prepare('SELECT * FROM payment_holds WHERE id = ?').get(id);
  if(existing) {
    if(CLOSED.includes(existing.status) && c.data.status === 'held') {
      return res.json({ ...fromRow(existing), ignored: true });
    }
    await db.prepare(`
      UPDATE payment_holds
      SET order_ref = ?, customer_name = ?, hold_type = ?, status = ?, data = ?::jsonb, updated_at = now(), updated_by = ?
      WHERE id = ?
    `).run(c.data.orderRef, c.data.customerName || null, c.data.holdType, c.data.status, JSON.stringify(c.data), by, id);
    console.log(`[audit] Payment hold ${id} (${c.data.orderRef}) -> ${c.data.status} by ${by}`);
    return res.json(fromRow(await db.prepare('SELECT * FROM payment_holds WHERE id = ?').get(id)));
  }

  await db.prepare(`
    INSERT INTO payment_holds (id, order_ref, customer_name, hold_type, status, data, updated_by)
    VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
    ON CONFLICT (id) DO NOTHING
  `).run(id, c.data.orderRef, c.data.customerName || null, c.data.holdType, c.data.status, JSON.stringify(c.data), by);
  console.log(`[audit] Payment hold ${id} (${c.data.orderRef}) logged as ${c.data.status} by ${by}`);
  res.status(201).json(fromRow(await db.prepare('SELECT * FROM payment_holds WHERE id = ?').get(id)));
});

module.exports = router;
