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
const MAX_LEN = 500;             // characters per message
const MAX_PER_HOUR = 5;          // customer messages per order per hour
const MAX_PER_ORDER = 30;        // customer messages per order, ever
const ORDER_WINDOW_DAYS = 60;    // a customer can write about an order for 60 days after it was placed

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
  const order = await db.prepare('SELECT ref, customer_id, customer_name, phone, created_at FROM orders WHERE ref = ?').get(ref);
  if(!order) { res.status(404).json({ error: 'Order not found.' }); return null; }
  if(!last10(order.phone) || last10(order.phone) !== last10(phone)) {
    res.status(403).json({ error: 'That phone number does not match this order.' });
    return null;
  }
  return order;
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
  if(counts.hour >= MAX_PER_HOUR) return res.status(429).json({ error: 'You have sent several messages just now. Please wait a little, or message us on WhatsApp.' });
  if(counts.total >= MAX_PER_ORDER) return res.status(429).json({ error: 'This order has reached its message limit. Please message us on WhatsApp.' });
  await db.prepare(`INSERT INTO order_messages (order_ref, direction, body) VALUES (?, 'customer', ?)`).run(order.ref, body);
  const row = await db.prepare(`SELECT * FROM order_messages WHERE order_ref = ? AND direction = 'customer' ORDER BY id DESC LIMIT 1`).get(order.ref);
  res.status(201).json(asPublic(row));
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
  if(body.length > MAX_LEN) return res.status(400).json({ error: `Keep the reply under ${MAX_LEN} characters.` });
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
