const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth } = require('../auth.postgres');
const push = require('../lib/push');

const router = express.Router();

// Oct 12 2026 — Order messages.
//
// A customer can send EggScore a short message about ONE order they placed.
// It is not a broadcast and not a general chat: every message belongs to an
// order, the customer proves who they are with the order reference plus the
// phone number on that order (the same check push notifications use), and
// only EggScore staff can answer. Staff see every thread in the ERP.
//
// Limits (all deliberate, all easy to change here):
const MAX_LEN = 300;             // characters per CUSTOMER message (staff replies may be longer, below)
const MAX_STAFF_LEN = 500;       // characters per staff reply
const MAX_PER_HOUR = 2;          // customer messages per order per hour (more than that = pick up the phone)
const MAX_PER_ORDER = 30;        // customer messages per order, ever
const ORDER_WINDOW_DAYS = 60;    // a customer can write about an order for 60 days after it was placed
const PAY_QUESTION_AFTER_MIN = 30;   // "I have paid" quick question appears this long after the order, if payment is not yet confirmed
const NO_DAY_FALLBACK_DAYS = 7;      // an order with no recorded delivery day counts as due 7 days after it was placed

const digitsOf = s => String(s || '').replace(/\D/g, '');
const last10 = s => digitsOf(s).slice(-10);
// Trim, remove control characters, keep line breaks, collapse long blank runs.
function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const asPublic = r => ({ id: Number(r.id), direction: r.direction, body: r.body, at: new Date(r.created_at).toISOString() });
const asStaff = r => ({ ...asPublic(r), sender: r.sender || null, read: !!r.read_at });

// Finds the order and checks the phone number matches the one on it.
async function ownedOrder(req, res) {
  const ref = String(req.params.ref || '');
  const phone = req.body && req.body.phone;
  if(!/^BEL-ORD-[0-9-]{6,30}$/.test(ref) || !phone) { res.status(400).json({ error: 'Order reference and phone number are required.' }); return null; }
  const order = await db.prepare('SELECT ref, customer_id, customer_name, phone, created_at, status, payment_verified, preferred_delivery_day FROM orders WHERE ref = ?').get(ref);
  if(!order) { res.status(404).json({ error: 'Order not found.' }); return null; }
  if(!last10(order.phone) || last10(order.phone) !== last10(phone)) {
    res.status(403).json({ error: 'That phone number does not match this order.' });
    return null;
  }
  return order;
}


// Oct 12 2026 — which quick questions make sense right now for an order.
// "I have paid" only while payment is NOT confirmed and a short wait has passed;
// "Where is my delivery?" only once payment IS confirmed and the delivery day
// the customer chose has arrived. Finished or cancelled orders get neither.
// Decided here (server clock, Lagos date) so the portal only shows what this says.
const DAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const LAGOS_MS = 3600000;   // Africa/Lagos = UTC+1, no daylight saving
const ymd = ms => new Date(ms + LAGOS_MS).toISOString().slice(0, 10);
// Same rule the portal uses when it offers a day: the next such weekday AFTER the order date, never the same day.
function deliveryDateOf(order) {
  const placed = new Date(order.created_at).getTime();
  const wd = new Date(placed + LAGOS_MS).getUTCDay();
  const target = DAY_INDEX[String(order.preferred_delivery_day || '')];
  const add = target === undefined ? NO_DAY_FALLBACK_DAYS : ((target - wd + 7) % 7 || 7);
  return ymd(placed + add * 86400000);
}
function quickState(order, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const status = String(order.status || '');
  const closed = ['fulfilled', 'cancelled', 'rejected'].includes(status);
  const paid = Number(order.payment_verified) === 1;
  const minutes = (now - new Date(order.created_at).getTime()) / 60000;
  const deliveryOn = deliveryDateOf(order);
  return {
    pay: !closed && !paid && minutes >= PAY_QUESTION_AFTER_MIN,
    delivery: !closed && paid && ymd(now) >= deliveryOn,
    deliveryOn, paid, closed,
  };
}

// ═══════════════════════ CUSTOMER SIDE (portal key) ═══════════════════════

router.post('/:ref/send', requireEitherAuth(), async (req, res) => {
  const order = await ownedOrder(req, res); if(!order) return;
  const body = cleanText(req.body && req.body.message);
  if(!body) return res.status(400).json({ error: 'Please type a message first.' });
  if(body.length > MAX_LEN) return res.status(400).json({ error: `Please keep it under ${MAX_LEN} characters.` });
  const ageDays = (Date.now() - new Date(order.created_at).getTime()) / 86400000;
  if(ageDays > ORDER_WINDOW_DAYS) return res.status(403).json({ error: 'This order is too old for messages. Please message us on WhatsApp.' });
  const counts = await db.prepare(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour
    FROM order_messages WHERE order_ref = ? AND direction = 'customer'
  `).get(order.ref);
  if(counts.hour >= MAX_PER_HOUR) return res.status(429).json({ error: 'You have sent a few messages just now. Please wait a little, or call or message us on WhatsApp.' });
  if(counts.total >= MAX_PER_ORDER) return res.status(429).json({ error: 'This order has reached its message limit. Please call or message us on WhatsApp.' });
  await db.prepare(`INSERT INTO order_messages (order_ref, direction, body) VALUES (?, 'customer', ?)`).run(order.ref, body);
  const row = await db.prepare(`SELECT * FROM order_messages WHERE order_ref = ? AND direction = 'customer' ORDER BY id DESC LIMIT 1`).get(order.ref);
  // Oct 12 2026 — tell staff devices that opted in, even if the ERP is closed. Never blocks or fails the send.
  push.notifyStaffOfMessage({ ref: order.ref, customerName: order.customer_name }).catch(e => console.error('[order-messages] staff alert failed:', e.message));
  res.status(201).json(asPublic(row));
});

// Oct 12 2026 — "My orders" on the portal. The phone keeps a short list of the orders
// placed on it (reference + phone number); this returns the current status of each,
// and when EggScore last replied, so the portal can show "new reply" tags. An order
// is only included if the phone number sent with it matches the one on the order, and
// nothing else about an order is returned (no address, no prices, no other customers).
// Declared before /:ref/... so "my-orders" is not mistaken for an order reference.
router.post('/my-orders', requireEitherAuth(), async (req, res) => {
  const input = Array.isArray(req.body && req.body.orders) ? req.body.orders.slice(0, 10) : [];
  const wanted = input
    .filter(o => o && /^BEL-ORD-[0-9-]{6,30}$/.test(String(o.ref || '')) && digitsOf(o.phone).length >= 7)
    .map(o => ({ ref: String(o.ref), phone: last10(o.phone) }));
  if(!wanted.length) return res.json([]);
  const marks = wanted.map(() => '?').join(',');
  const refs = wanted.map(w => w.ref);
  const orders = await db.prepare(`SELECT ref, phone, status, payment_verified, crates, created_at FROM orders WHERE ref IN (${marks})`).all(...refs);
  const staffRows = await db.prepare(`
    SELECT order_ref, MAX(created_at) AS last_staff_at
    FROM order_messages WHERE direction = 'staff' AND order_ref IN (${marks}) GROUP BY order_ref
  `).all(...refs);
  const lastStaff = {}; staffRows.forEach(r => { lastStaff[r.order_ref] = new Date(r.last_staff_at).toISOString(); });
  const out = [];
  for(const w of wanted) {
    const o = orders.find(x => x.ref === w.ref);
    if(!o || !last10(o.phone) || last10(o.phone) !== w.phone) continue;
    out.push({
      ref: o.ref, status: o.status || '', paid: Number(o.payment_verified) === 1,
      crates: o.crates, createdAt: new Date(o.created_at).toISOString(),
      lastStaffAt: lastStaff[o.ref] || null,
    });
  }
  res.json(out);
});

// Which quick questions the portal may offer for this order right now.
router.post('/:ref/quick', requireEitherAuth(), async (req, res) => {
  const order = await ownedOrder(req, res); if(!order) return;
  res.json(quickState(order));
});

// POST (not GET) so the phone number never travels in a web address.
router.post('/:ref/thread', requireEitherAuth(), async (req, res) => {
  const order = await ownedOrder(req, res); if(!order) return;
  const rows = await db.prepare('SELECT * FROM order_messages WHERE order_ref = ? ORDER BY id ASC LIMIT 200').all(order.ref);
  res.json(rows.map(asPublic));
});

// ═══════════════════════ STAFF SIDE (any signed-in staff) ═══════════════════════

// One line per order that has messages (last 60 days) with the unread count.
router.get('/inbox', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare(`
    SELECT m.order_ref AS ref,
           o.customer_name, o.phone, o.crates, o.status,
           COUNT(*) FILTER (WHERE m.direction = 'customer' AND m.read_at IS NULL)::int AS unread,
           COUNT(*)::int AS total,
           MAX(m.created_at) AS last_at,
           (ARRAY_AGG(m.direction ORDER BY m.id DESC))[1] AS last_direction,
           (ARRAY_AGG(m.body ORDER BY m.id DESC))[1] AS last_body
    FROM order_messages m
    LEFT JOIN orders o ON o.ref = m.order_ref
    WHERE m.created_at > now() - interval '60 days'
    GROUP BY m.order_ref, o.customer_name, o.phone, o.crates, o.status
    ORDER BY (COUNT(*) FILTER (WHERE m.direction = 'customer' AND m.read_at IS NULL) > 0) DESC, MAX(m.created_at) DESC
    LIMIT 200
  `).all();
  res.json(rows.map(r => ({
    ref: r.ref, customerName: r.customer_name || '', phone: r.phone || '', crates: r.crates, status: r.status,
    unread: r.unread, total: r.total, lastAt: new Date(r.last_at).toISOString(),
    lastDirection: r.last_direction, lastBody: String(r.last_body || '').slice(0, 140),
  })));
});

router.get('/:ref/staff', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM order_messages WHERE order_ref = ? ORDER BY id ASC LIMIT 200').all(String(req.params.ref));
  res.json(rows.map(asStaff));
});

router.post('/:ref/read', requireSupabaseAuth(), async (req, res) => {
  const r = await db.prepare(`UPDATE order_messages SET read_at = now() WHERE order_ref = ? AND direction = 'customer' AND read_at IS NULL`).run(String(req.params.ref));
  res.json({ ok: true, marked: r.changes || 0 });
});

router.post('/:ref/reply', requireSupabaseAuth(), async (req, res) => {
  const ref = String(req.params.ref);
  const order = await db.prepare('SELECT ref, customer_id FROM orders WHERE ref = ?').get(ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  const body = cleanText(req.body && req.body.message);
  if(!body) return res.status(400).json({ error: 'Type a reply first.' });
  if(body.length > MAX_STAFF_LEN) return res.status(400).json({ error: `Keep the reply under ${MAX_STAFF_LEN} characters.` });
  const by = (req.user && req.user.email) || null;
  await db.prepare(`INSERT INTO order_messages (order_ref, direction, body, sender) VALUES (?, 'staff', ?, ?)`).run(ref, body, by);
  // Answering a thread also counts as having read everything the customer sent.
  await db.prepare(`UPDATE order_messages SET read_at = now() WHERE order_ref = ? AND direction = 'customer' AND read_at IS NULL`).run(ref);
  const row = await db.prepare(`SELECT * FROM order_messages WHERE order_ref = ? AND direction = 'staff' ORDER BY id DESC LIMIT 1`).get(ref);
  // Tell the customer's phone(s) there is a reply. Never blocks or fails the reply.
  push.notifyOrderReply(order).catch(e => console.error('[order-messages] push failed:', e.message));
  res.status(201).json(asStaff(row));
});

module.exports = router;
module.exports.quickState = quickState;   // exported for the test suite
