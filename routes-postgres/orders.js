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

// Same convention as the client-side docRefNumber('CID') generator used
// by the ERP's manual "+ Add New Customer" flow — BEL-CID-YYMMDD-HHMMSS.
function genCustomerCid() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(2);
  return `BEL-CID-${yy}${p(now.getMonth()+1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// Matches purely on digits, so "0806 837 1725", "+234 806-837-1725", and
// "08068371725" all resolve to the same customer instead of creating a
// near-duplicate record for the same person.
function normalisePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

router.post('/', requireEitherAuth(), async (req, res) => {
  const { customerName, phone, location, crates, eggPricePerCrate, deliveryPerCrate, notes, paymentMethod } = req.body;
  if(!customerName || !crates || crates < 1) {
    return res.status(400).json({ error: 'customerName and a positive crates value are required.' });
  }

  // Silent housekeeping — every order now resolves to a real customer
  // record, whether or not the customer ever taps the portal's "remember
  // me" prompt. Matched by phone (more reliable than name, which people
  // spell inconsistently); a genuinely new number gets a real customer
  // row created here, same CID convention as the ERP's manual Add
  // Customer flow. isNewCustomer tells the portal whether to show the
  // enrollment celebration or the quieter "welcome back" version.
  let customerId = null, customerCid = null, isNewCustomer = false;
  const normalisedPhone = normalisePhone(phone);
  if(normalisedPhone) {
    const allCustomers = await db.prepare('SELECT id, cid, phone FROM customers').all();
    const match = allCustomers.find(c => normalisePhone(c.phone) === normalisedPhone);
    if(match) {
      customerId  = match.id;
      customerCid = match.cid;
    } else if(location) {
      const cid = genCustomerCid();
      const info = await db.prepare(`
        INSERT INTO customers (cid, name, location, phone, type, credit_limit)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(cid, customerName, location, phone || null, 'portal', 0);
      customerId    = info.lastInsertRowid;
      customerCid   = cid;
      isNewCustomer = true;
    }
  }

  const ref = genOrderRef();
  const info = await db.prepare(`
    INSERT INTO orders (ref, customer_id, customer_name, phone, location, crates, egg_price_per_crate, delivery_per_crate, notes, payment_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ref, customerId, customerName, phone || null, location || null, crates,
    eggPricePerCrate || 0, deliveryPerCrate || 0, notes || null, paymentMethod || null);

  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...order, customerCid, isNewCustomer });
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

  console.log(`[audit] Order ${req.params.ref} updated by ${req.user?.email || 'portal key'}`);

  res.json(await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref));
});

module.exports = router;
