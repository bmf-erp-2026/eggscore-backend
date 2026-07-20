const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

function genOrderRef() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(2);
  return `BEL-ORD-${yy}${p(now.getMonth()+1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// POST /orders — the customer portal creates an order. Portal-role
// keys only; a customer's session can never read financial data,
// only ever create its own order.
router.post('/', requireAuth('portal', 'erp'), (req, res) => {
  const { customerName, phone, location, crates, eggPricePerCrate, deliveryPerCrate, notes } = req.body;

  if(!customerName || !crates || crates < 1) {
    return res.status(400).json({ error: 'customerName and a positive crates value are required.' });
  }

  const ref = genOrderRef();
  const stmt = db.prepare(`
    INSERT INTO orders (ref, customer_name, phone, location, crates, egg_price_per_crate, delivery_per_crate, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(ref, customerName, phone || null, location || null, crates,
    eggPricePerCrate || 0, deliveryPerCrate || 0, notes || null);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(order);
});

// GET /orders — the ERP reads the queue. erp-role only — this is
// exactly the boundary that never existed before: a customer's key
// cannot list every other customer's orders.
router.get('/', requireAuth('erp'), (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at ASC').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY created_at ASC').all();
  res.json(rows);
});

// GET /orders/:ref — a single order, either side can read (portal
// needs this to show a customer their own order status by ref).
router.get('/:ref', requireAuth('erp', 'portal'), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  res.json(order);
});

// PATCH /orders/:ref — ERP-only status transitions (confirm, mark
// in-transit, mark delivered). This is the endpoint that replaces
// every localStorage write the ERP used to do directly.
router.patch('/:ref', requireAuth('erp'), (req, res) => {
  const { status, paymentVerified, batchId } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });

  const fields = [], values = [];
  if(status !== undefined) { fields.push('status = ?'); values.push(status); }
  if(paymentVerified !== undefined) { fields.push('payment_verified = ?'); values.push(paymentVerified ? 1 : 0); }
  if(batchId !== undefined) { fields.push('batch_id = ?'); values.push(batchId); }
  fields.push("updated_at = datetime('now')");

  if(fields.length === 1) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.ref);
  db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE ref = ?`).run(...values);

  res.json(db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref));
});

module.exports = router;
