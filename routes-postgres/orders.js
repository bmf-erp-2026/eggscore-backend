const express = require('express');
const { db } = require('../db.postgres');
const { requireAuth, requireSupabaseAuth, requireEitherAuth } = require('../auth.postgres');

const router = express.Router();

function genOrderRef() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(2);
  return `BEL-ORD-${yy}${p(now.getMonth()+1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

router.post('/', requireEitherAuth(), async (req, res) => {
  const { customerName, phone, location, crates, eggPricePerCrate, deliveryPerCrate, notes } = req.body;
  if(!customerName || !crates || crates < 1) {
    return res.status(400).json({ error: 'customerName and a positive crates value are required.' });
  }

  const ref = genOrderRef();
  const info = await db.prepare(`
    INSERT INTO orders (ref, customer_name, phone, location, crates, egg_price_per_crate, delivery_per_crate, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ref, customerName, phone || null, location || null, crates,
    eggPricePerCrate || 0, deliveryPerCrate || 0, notes || null);

  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(order);
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  const { status } = req.query;
  const rows = status
    ? await db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at ASC').all(status)
    : await db.prepare('SELECT * FROM orders ORDER BY created_at ASC').all();
  res.json(rows);
});

router.get('/:ref', requireEitherAuth(), async (req, res) => {
  const order = await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  res.json(order);
});

router.patch('/:ref', requireSupabaseAuth(), async (req, res) => {
  const { status, paymentVerified, batchId } = req.body;
  const order = await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });

  const fields = [], values = [];
  if(status !== undefined) { fields.push('status = ?'); values.push(status); }
  if(paymentVerified !== undefined) { fields.push('payment_verified = ?'); values.push(paymentVerified ? 1 : 0); }
  if(batchId !== undefined) { fields.push('batch_id = ?'); values.push(batchId); }
  fields.push("updated_at = now()");

  if(fields.length === 1) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.ref);
  await db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE ref = ?`).run(...values);

  // Traceability — every status change is now tied to a real logged-in
  // person, not a shared key. Worth recording who, not just what.
  console.log(`[audit] Order ${req.params.ref} updated by ${req.user?.email || 'portal key'}`);

  res.json(await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref));
});

module.exports = router;
