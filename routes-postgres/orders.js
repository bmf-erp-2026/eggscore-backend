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

// A customer's OWN shareable referral code (what they give a friend) —
// same generator as the ERP's manual Add Customer flow, so a portal-
// created customer gets one too instead of only manually-added ones.
function genReferralCode(name) {
  const letters = (name || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'EGGS';
  const digits = String(Math.floor(100 + Math.random() * 900));
  return `BEL-${letters}${digits}`;
}

router.post('/', requireEitherAuth(), async (req, res) => {
  const { customerName, phone, location, crates, eggPricePerCrate, deliveryPerCrate, notes, paymentMethod,
          referredByCustomerName, reservationCustomerType, reservedAt, reservationWindowHours, reservationExpiresAt, status,
          confirmedExistingCid, theme } = req.body;
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

  // A returning customer ordering from a new number is invisible to the
  // phone-only lookup below — the portal recognises her by NAME (see
  // checkPhoneMismatch() client-side) and, once confirmed, sends her
  // real CID directly here. Trusting it outright would risk merging two
  // different people who share a name on a mistaken guess, so the
  // client only ever sends this after either an unambiguous phone match
  // or an explicit "yes, that's me" from the customer — never a bare
  // name-only guess. Refreshing her phone here is exactly right in
  // this case: it's the same real person, just calling from a new number.
  if(confirmedExistingCid) {
    const existing = await db.prepare('SELECT id, cid FROM customers WHERE cid = ?').get(confirmedExistingCid);
    if(existing) {
      customerId  = existing.id;
      customerCid = existing.cid;
      if(normalisedPhone) {
        await db.prepare('UPDATE customers SET phone = ? WHERE id = ?').run(phone, existing.id);
      }
    }
  }

  if(!customerId && normalisedPhone) {
    const allCustomers = await db.prepare('SELECT id, cid, phone FROM customers').all();
    const match = allCustomers.find(c => normalisePhone(c.phone) === normalisedPhone);
    if(match) {
      customerId  = match.id;
      customerCid = match.cid;
    } else if(location) {
      const cid = genCustomerCid();
      // 'Individual' is a real, meaningful value from the same Customer
      // Type vocabulary used in the ERP's manual Add Customer form
      // (Wholesaler/Retailer/Market Trader/Depot/Restaurant-Hotel/
      // Individual) — a reasonable default for a first-time online
      // order, editable later via Edit Contact Info once Bob knows more
      // about them. 'portal' was a meaningless internal placeholder.
      const info = await db.prepare(`
        INSERT INTO customers (cid, name, location, phone, type, credit_limit, referral_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(cid, customerName, location, phone || null, 'Individual', 0, genReferralCode(customerName));
      customerId    = info.lastInsertRowid;
      customerCid   = cid;
      isNewCustomer = true;
    }
  }

const ref = genOrderRef();
  const info = await db.prepare(`
    INSERT INTO orders (ref, customer_id, customer_name, phone, location, crates, egg_price_per_crate, delivery_per_crate, notes, payment_method, referred_by_customer_name, reservation_customer_type, reserved_at, reservation_window_hours, reservation_expires_at, status, theme)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ref, customerId, customerName, phone || null, location || null, crates,
    eggPricePerCrate || 0, deliveryPerCrate || 0, notes || null, paymentMethod || null,
    referredByCustomerName || null, reservationCustomerType || null, reservedAt || null,
    reservationWindowHours || null, reservationExpiresAt || null, status || 'pending',
    theme === 'dark' ? 'dark' : 'light');

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
  const { status, paymentVerified, batchId, convertedAt, cancelledAt } = req.body;
  const order = await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });

  const fields = [], values = [];
  if(status !== undefined) { fields.push('status = ?'); values.push(status); }
  if(paymentVerified !== undefined) { fields.push('payment_verified = ?'); values.push(paymentVerified ? 1 : 0); }
  if(batchId !== undefined) { fields.push('batch_id = ?'); values.push(batchId); }
  if(convertedAt !== undefined) { fields.push('converted_at = ?'); values.push(convertedAt); }
  if(cancelledAt !== undefined) { fields.push('cancelled_at = ?'); values.push(cancelledAt); }
  fields.push("updated_at = now()");

  if(fields.length === 1) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.ref);
  await db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE ref = ?`).run(...values);

  console.log(`[audit] Order ${req.params.ref} updated by ${req.user?.email || 'portal key'}`);

  res.json(await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref));
});

module.exports = router;
