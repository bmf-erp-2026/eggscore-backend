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
const ORDER_WINDOW_DAYS = 30;    // a customer can write about an order for one month after it was placed
const RETENTION_DAYS = 30;       // every message is deleted one month after it was sent (keeps the database small)
const OFFICE_CLOSE_HOUR = 19;    // Lagos time: messages after 7 PM are answered the next working day (Mon-Sat); Sundays are not a working day
const PAY_QUESTION_AFTER_MIN = 30;   // "I have paid" quick question appears this long after the order, if payment is not yet confirmed
const DELIVERY_QUESTION_HOUR = 18;   // "Where is my delivery?" opens at this Lagos hour (close of business, 6 PM) on the delivery day
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

// Oct 13 2026 — volume-change detection. A customer who writes to change the number of crates
// ("add 30 more crates", "reduce it to 20") must never depend on a person remembering it. Every customer
// message is checked; one that looks like a change opens a FOLLOW-UP on the order, which blocks dispatch
// until someone records what was done. The check is deliberately generous: a wrong guess costs one tap
// ("not a volume change"), a missed one costs a wrong delivery.
const ADD_WORDS = /\b(add|adding|added|more|extra|additional|increase|increment|top[ -]?up|another|plus|increasing)\b/i;
const CUT_WORDS = /\b(reduce|reduction|less|fewer|cut|remove|decrease|lower|reducing|decreasing)\b/i;
const QTY_WORDS = /\b(crate|crates|volume|quantity|qty|tray|trays|carton|cartons)\b/i;
function detectVolumeChange(text) {
  const t = String(text || '');
  const adds = ADD_WORDS.test(t), cuts = CUT_WORDS.test(t);
  if(!(adds || cuts)) return null;
  const nums = (t.match(/(?<![\d.,])\d{1,4}(?![\d.,]|\s*(?:am|pm)\b)/gi) || []).map(Number).filter(n => n > 0);
  if(!QTY_WORDS.test(t) && !nums.length) return null;
  // a number with no quantity word is only trusted next to a change word ("add 30")
  const n = nums.length ? nums[0] : null;
  return { crates: n === null ? null : (cuts && !adds ? -n : n) };
}
const followupOut = r => ({
  id: Number(r.id), orderRef: r.order_ref, kind: r.kind, status: r.status, crates: r.crates === null ? null : Number(r.crates),
  orderCratesAtOpen: r.order_crates_at_open === null || r.order_crates_at_open === undefined ? null : Number(r.order_crates_at_open),
  source: r.source, sourceText: r.source_text || '', openedBy: r.opened_by || null, openedAt: new Date(r.opened_at).toISOString(),
  resolvedBy: r.resolved_by || null, resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null, note: r.note || '',
});
// Opens (or updates) the single open volume follow-up for an order. Returns { followup, created }.
async function openVolumeFollowup(order, crates, text, source, by) {
  const open = await db.prepare("SELECT * FROM order_followups WHERE order_ref = ? AND kind = 'volume_change' AND status = 'open' ORDER BY id DESC LIMIT 1").get(order.ref);
  if(open) {
    // a later message with a number sharpens the quantity; the original words are kept in the log line
    if(crates !== null && crates !== undefined) {
      await db.prepare('UPDATE order_followups SET crates = ?, source_text = ? WHERE id = ?').run(crates, String(text || '').slice(0, 300), open.id);
    }
    return { followup: followupOut(await db.prepare('SELECT * FROM order_followups WHERE id = ?').get(open.id)), created: false };
  }
  await db.prepare(`INSERT INTO order_followups (order_ref, kind, status, crates, order_crates_at_open, source, source_text, opened_by)
                    VALUES (?, 'volume_change', 'open', ?, ?, ?, ?, ?)`)
    .run(order.ref, crates === undefined ? null : crates, order.crates === undefined ? null : order.crates, source, String(text || '').slice(0, 300), by || null);
  const row = await db.prepare("SELECT * FROM order_followups WHERE order_ref = ? AND kind = 'volume_change' AND status = 'open' ORDER BY id DESC LIMIT 1").get(order.ref);
  return { followup: followupOut(row), created: true };
}
async function alertOwnerOfFollowup(order, f) {
  const what = f.crates ? `${f.crates > 0 ? 'add' : 'remove'} ${Math.abs(f.crates)} crates` : 'change the crates';
  return push.notifyOwners({
    title: '📦 Order change needs action', body: `${order.customer_name || 'A customer'} (${order.ref}) wants to ${what}. The order is held until this is dealt with.`,
    url: `/famad-erp.html?ordmsg=${encodeURIComponent(order.ref)}`, tag: `followup-${order.ref}`, kind: 'order_followup',
  });
}

// Oct 12 2026 — office hours. A message is never refused out of hours, but the customer
// is told when it will be answered: after 7 PM (Lagos), or any time on a Sunday, the next
// working day, Monday to Saturday.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function officeNotice(nowMs) {
  const l = new Date((nowMs == null ? Date.now() : nowMs) + 3600000);   // Lagos = UTC+1
  const day = l.getUTCDay();
  const afterHours = day === 0 || l.getUTCHours() >= OFFICE_CLOSE_HOUR;
  if(!afterHours) return { afterHours: false, answerOn: null };
  let next = day === 0 ? 1 : (day + 1) % 7;   // Sunday -> Monday; otherwise tomorrow
  if(next === 0) next = 1;                    // Saturday evening -> Monday (Sunday is not a working day)
  return { afterHours: true, answerOn: WEEKDAYS[next] };
}
const asPublic = r => ({ id: Number(r.id), direction: r.direction, body: r.body, at: new Date(r.created_at).toISOString() });
const asStaff = r => ({ ...asPublic(r), sender: r.sender || null, read: !!r.read_at });

// Finds the order and checks the phone number matches the one on it.
async function ownedOrder(req, res) {
  const ref = String(req.params.ref || '');
  const phone = req.body && req.body.phone;
  if(!/^BEL-ORD-[0-9-]{6,30}$/.test(ref) || !phone) { res.status(400).json({ error: 'Order reference and phone number are required.' }); return null; }
  const order = await db.prepare('SELECT ref, customer_id, customer_name, phone, created_at, status, payment_verified, preferred_delivery_day, crates FROM orders WHERE ref = ?').get(ref);
  if(!order) { res.status(404).json({ error: 'Order not found.' }); return null; }
  if(!last10(order.phone) || last10(order.phone) !== last10(phone)) {
    res.status(403).json({ error: 'That phone number does not match this order.' });
    return null;
  }
  return order;
}


// Oct 12 2026 — which quick questions make sense right now for an order.
// "I have paid" only while payment is NOT confirmed and a short wait has passed;
// "Where is my delivery?" only once payment IS confirmed and close of business (6 PM Lagos)
// on the delivery day the customer chose has passed. Finished or cancelled orders get neither.
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
    delivery: !closed && paid && now >= new Date(deliveryOn + 'T' + String(DELIVERY_QUESTION_HOUR).padStart(2, '0') + ':00:00+01:00').getTime(),
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
  // Oct 13 2026 — a message that asks to change the crates opens a follow-up that holds the order. Never fails the send.
  try {
    const hit = ['cancelled', 'rejected'].includes(String(order.status)) ? null : detectVolumeChange(body);
    if(hit) {
      const r = await openVolumeFollowup(order, hit.crates, body, 'auto', null);
      if(r.created) alertOwnerOfFollowup(order, r.followup).catch(e => console.error('[order-messages] follow-up alert failed:', e.message));
    }
  } catch(e) { console.error('[order-messages] follow-up check failed:', e.message); }
  res.status(201).json({ ...asPublic(row), ...officeNotice() });
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

// ── Oct 13 2026 — follow-ups: things a customer asked for after ordering that must not be forgotten ──
// Every open follow-up (the ERP asks every minute or so, and before any dispatch step).
router.get('/followups/open', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare("SELECT * FROM order_followups WHERE status = 'open' ORDER BY id ASC LIMIT 200").all();
  res.json(rows.map(followupOut));
});
// Recent history for one order (open and closed), newest first.
router.get('/:ref/followups', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM order_followups WHERE order_ref = ? ORDER BY id DESC LIMIT 20').all(String(req.params.ref));
  res.json(rows.map(followupOut));
});
// Staff flag a message (or a phone call) as a volume change.
router.post('/:ref/followup', requireSupabaseAuth(), async (req, res) => {
  const order = await db.prepare('SELECT ref, customer_name, crates, status FROM orders WHERE ref = ?').get(String(req.params.ref));
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  if(['cancelled', 'rejected'].includes(String(order.status))) return res.status(400).json({ error: 'That order is closed.' });
  const n = parseInt(req.body && req.body.crates, 10);
  const crates = Number.isFinite(n) && n !== 0 && Math.abs(n) <= 100000 ? n : null;
  const r = await openVolumeFollowup(order, crates, cleanText(req.body && req.body.text).slice(0, 300) || 'Flagged by staff', 'staff', (req.user && req.user.email) || null);
  res.status(r.created ? 201 : 200).json(r.followup);
});
// Close a follow-up with a recorded outcome. The customer is always told, except when it was a false alarm.
router.post('/followups/:id/resolve', requireSupabaseAuth(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = Number.isInteger(id) ? await db.prepare('SELECT * FROM order_followups WHERE id = ?').get(id) : null;
  if(!f) return res.status(404).json({ error: 'Follow-up not found.' });
  if(f.status !== 'open') return res.status(409).json({ error: 'That follow-up is already closed.' });
  const outcome = String((req.body && req.body.outcome) || '');
  if(!['applied', 'new_order', 'declined', 'dismissed'].includes(outcome)) return res.status(400).json({ error: 'Choose what was done.' });
  const note = cleanText(req.body && req.body.note).slice(0, 300);
  const message = cleanText(req.body && req.body.message);
  const order = await db.prepare('SELECT ref, customer_id, customer_name, crates, status FROM orders WHERE ref = ?').get(f.order_ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  if(outcome !== 'applied' && !note) return res.status(400).json({ error: 'Write a short note on what was decided.' });
  if(outcome !== 'dismissed' && (!message || message.length < 3)) return res.status(400).json({ error: 'Write the message to the customer: they must be told the outcome.' });
  if(message.length > MAX_STAFF_LEN) return res.status(400).json({ error: `Keep the message under ${MAX_STAFF_LEN} characters.` });
  if(outcome === 'applied') {
    if(['in_transit', 'fulfilled'].includes(String(order.status))) return res.status(409).json({ error: 'The order has already gone out, so its crates cannot be changed. Choose "Put on a new order" or "Decline".' });
    if(Number(order.crates) === Number(f.order_crates_at_open)) return res.status(409).json({ error: 'The order still has the same number of crates. Change the crates first, then close this.' });
  }
  const by = (req.user && req.user.email) || null;
  const finalNote = outcome === 'applied' ? `Crates ${f.order_crates_at_open} to ${order.crates}${note ? ': ' + note : ''}` : note;
  await db.prepare('UPDATE order_followups SET status = ?, resolved_by = ?, resolved_at = now(), note = ? WHERE id = ?').run(outcome, by, finalNote, id);
  if(message && outcome !== 'dismissed') {
    await db.prepare(`INSERT INTO order_messages (order_ref, direction, body, sender) VALUES (?, 'staff', ?, ?)`).run(order.ref, message, by);
    await db.prepare(`UPDATE order_messages SET read_at = now() WHERE order_ref = ? AND direction = 'customer' AND read_at IS NULL`).run(order.ref);
    push.notifyOrderReply(order, message).catch(e => console.error('[order-messages] push failed:', e.message));
  }
  console.log(`[audit] Follow-up ${id} on ${order.ref} closed as ${outcome} by ${by}`);
  res.json(followupOut(await db.prepare('SELECT * FROM order_followups WHERE id = ?').get(id)));
});

// One line per order that has messages (last 30 days) with the unread count.
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
    WHERE m.created_at > now() - interval '30 days'
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
  push.notifyOrderReply(order, body).catch(e => console.error('[order-messages] push failed:', e.message));
  res.status(201).json(asStaff(row));
});

// Oct 12 2026 — retention. Messages older than RETENTION_DAYS are deleted so the table
// stays small (the Owner's decision: one month, then old messages give way). Runs shortly
// after the server starts and then every 6 hours; a failure is logged and never stops anything.
async function purgeOldMessages() {
  try {
    const r = await db.prepare(`DELETE FROM order_messages WHERE created_at < now() - interval '${RETENTION_DAYS} days'`).run();
    if(r && r.changes) console.log(`[order-messages] purged ${r.changes} message(s) older than ${RETENTION_DAYS} days`);
  } catch(e) { console.error('[order-messages] purge failed:', e.message); }
}
const firstPurge = setTimeout(purgeOldMessages, Number(process.env.OM_PURGE_FIRST_MS) || 20000);
const repeatPurge = setInterval(purgeOldMessages, 6 * 3600 * 1000);
if(firstPurge.unref) firstPurge.unref();
if(repeatPurge.unref) repeatPurge.unref();

module.exports = router;
module.exports.officeNotice = officeNotice;   // exported for the test suite
module.exports.quickState = quickState;   // exported for the test suite
module.exports.detectVolumeChange = detectVolumeChange;   // exported for the test suite
