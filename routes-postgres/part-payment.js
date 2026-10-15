const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth, requireRole } = require('../auth.postgres');
const pc = require('../lib/portal-checks');
const pp = require('../lib/part-payment');
const push = require('../lib/push');

const router = express.Router();

// Portal part payment, Stage 2 (Oct 15 2026).
//
// 1. GET  /part-payment/quote           portal or staff: may THIS customer ask, and what would be due now? Never returns the
//                                       balance or any margin figure; only "pay now" and the number of days.
// 2. GET  /part-payment/status/:ref     the customer (order ref + the phone on the order): where their request stands.
// 3. GET  /part-payment/owner           Owner only: every request, with the balance.
// 4. POST /part-payment/:ref/decision   Owner only: confirm or decline one request. The customer is told in the order thread.
//
// The request itself is recorded by POST /orders (routes-postgres/orders.js) when the portal sends partPaymentRequested.
// Nothing here moves money: "confirmed" means the Owner agreed to the terms; the order is still paid and recorded the
// ordinary way in the ERP.

const naira = n => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const lagosToday = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);
function addDays(ymd, days) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function niceDate(ymd) { const d = new Date(ymd + 'T00:00:00Z'); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }

router.get('/quote', requireEitherAuth(), async (req, res) => {
  const q = req.query || {};
  const r = await pp.evaluate({
    customerName: q.customer, phone: q.phone, crates: q.crates, eggPricePerCrate: q.eggPrice, deliveryTotal: q.delivery,
  });
  if(!r.ok) return res.json({ eligible: false });
  res.json({ eligible: true, payNow: r.payNow, days: r.days, level: r.level });
});

router.get('/status/:ref', requireEitherAuth(), async (req, res) => {
  const order = await db.prepare('SELECT ref, phone FROM orders WHERE ref = ?').get(String(req.params.ref));
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  if(!req.user && pc.normPhone(order.phone) !== pc.normPhone(req.query.phone)) return res.status(404).json({ error: 'Order not found.' });
  const row = await db.prepare('SELECT status, pay_now, days, due_date FROM part_payments WHERE order_ref = ?').get(order.ref);
  if(!row) return res.json({ status: null });
  res.json({ status: row.status, payNow: Number(row.pay_now), days: row.days, dueDate: row.status === 'confirmed' ? row.due_date : null });
});

router.get('/owner', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const rows = await db.prepare("SELECT * FROM part_payments WHERE requested_at > now() - interval '120 days' ORDER BY requested_at DESC LIMIT 500").all();
  res.json(rows.map(r => ({
    ref: r.order_ref, customerName: r.customer_name, level: r.level, status: r.status,
    payNow: Number(r.pay_now), balance: Number(r.balance), days: r.days, dueDate: r.due_date,
    requestedAt: r.requested_at, decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note,
  })));
});

router.post('/:ref/decision', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const ref = String(req.params.ref);
  const action = String((req.body && req.body.action) || '');
  if(action !== 'confirm' && action !== 'decline') return res.status(400).json({ error: 'action must be confirm or decline.' });
  const note = String((req.body && req.body.note) || '').slice(0, 300) || null;
  const by = (req.user && req.user.email) || null;
  const row = await db.prepare('SELECT * FROM part_payments WHERE order_ref = ?').get(ref);
  if(!row) return res.status(404).json({ error: 'No part-payment request on that order.' });
  const want = action === 'confirm' ? 'confirmed' : 'declined';
  if(row.status === want) return res.json({ ok: true, status: row.status, unchanged: true });
  if(row.status !== 'requested') return res.status(409).json({ error: 'That request has already been ' + row.status + '.' });
  const order = await db.prepare('SELECT ref, customer_id, customer_name, phone, crates, egg_price_per_crate, delivery_per_crate FROM orders WHERE ref = ?').get(ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  const total = (Number(order.egg_price_per_crate) + Number(order.delivery_per_crate)) * Number(order.crates);

  let message;
  if(action === 'confirm') {
    // Re-check now: the customer's level, verification, debt and the batch cost may all have moved since they asked.
    const r = await pp.evaluate({
      customerName: order.customer_name, crates: order.crates, eggPricePerCrate: order.egg_price_per_crate,
      deliveryTotal: Number(order.delivery_per_crate) * Number(order.crates),
    });
    if(!r.ok) return res.status(409).json({ error: 'This customer no longer qualifies for part payment (' + r.code + '). Decline it, or fix that first.', code: r.code });
    const due = addDays(lagosToday(), r.days);
    await db.prepare(`UPDATE part_payments SET status = 'confirmed', level = ?, pay_now = ?, balance = ?, days = ?, due_date = ?, decided_by = ?, decided_at = now(), note = ? WHERE order_ref = ? AND status = 'requested'`)
      .run(r.level, r.payNow, r.balance, r.days, due, by, note, ref);
    message = `Part payment confirmed for order ${ref}. Please pay ${naira(r.payNow)} now. The rest is due by ${niceDate(due)}.`;
  } else {
    await db.prepare(`UPDATE part_payments SET status = 'declined', decided_by = ?, decided_at = now(), note = ? WHERE order_ref = ? AND status = 'requested'`).run(by, note, ref);
    message = `We could not agree part payment for order ${ref} this time. Please pay the full amount of ${naira(total)}. Thank you.`;
  }
  try {
    await db.prepare(`INSERT INTO order_messages (order_ref, direction, body, sender) VALUES (?, 'staff', ?, ?)`).run(ref, message, by);
    push.notifyOrderReply({ ref, customer_id: order.customer_id }, message).catch(e => console.error('[part-payment] push failed:', e.message));
  } catch(e) { console.error('[part-payment] could not message the customer:', e.message); }
  console.log(`[audit] Part payment on ${ref} ${want} by ${by}`);
  const out = await db.prepare('SELECT * FROM part_payments WHERE order_ref = ?').get(ref);
  res.json({ ok: true, status: out.status, payNow: Number(out.pay_now), balance: Number(out.balance), dueDate: out.due_date });
});

module.exports = router;
