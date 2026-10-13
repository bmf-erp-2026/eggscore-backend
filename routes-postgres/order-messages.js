const express = require('express');
const { db } = require('../db.postgres');
const repScope = require('../lib/rep-scope');
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
const CHANGE_WORDS = /\b(change|changing|amend|adjust|update|instead|make it|raise|raising|revise)\b/i;
const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAYS = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
// Removes the numbers that are NOT quantities: dates ("Saturday, 17th", "14 October", "October 14"), times, money, phone-like
// and long numbers. What is left are the numbers that could be a number of crates.
function stripNonQuantities(t) {
  return String(t || '')
    .replace(/\b\d{1,2}\s*(?:st|nd|rd|th)\b/gi, ' ')
    .replace(new RegExp('\\b' + DAYS + '\\b[\\s,.-]*\\d{1,2}\\b(?!\\s*(?:crate|crates|tray|trays|carton|cartons|more|extra)\\b)', 'gi'), ' ')
    .replace(new RegExp('\\b\\d{1,2}\\s*(?:of\\s+)?' + MONTHS + '\\b', 'gi'), ' ')
    .replace(new RegExp('\\b' + MONTHS + '\\b[\\s,.-]*\\d{1,2}\\b', 'gi'), ' ')
    .replace(/\b\d{1,2}\s*[:.]\s*\d{2}(?!\d)(?:\s*(?:am|pm)\b)?/gi, ' ')
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, ' ')
    .replace(/[\u20A6]\s*[\d,.]+|\bN\s?\d[\d,.]*|\bNGN\s?[\d,.]+/gi, ' ')
    .replace(/\d[\d,]*\.\d+|\d{1,3}(?:,\d{3})+|\d{5,}/g, ' ');
}
// Which number is the change? A number is trusted only when it sits next to a quantity or change word
// ("25 more", "add 30", "reduce it to 20"). A number that is only a date, a time or an amount is never used.
// If two different numbers both qualify the answer is left open (null) and the staff member types it,
// instead of the system guessing.
function detectVolumeChange(text) {
  const t0 = String(text || '');
  const adds = ADD_WORDS.test(t0), cuts = CUT_WORDS.test(t0);
  const t = stripNonQuantities(t0);
  const qty = QTY_WORDS.test(t0);
  if(!(adds || cuts || (CHANGE_WORDS.test(t0) && qty))) return null;
  const nums = (t.match(/(?<![\d.,])\d{1,4}(?![\d.,])/g) || []).map(Number).filter(n => n > 0);
  if(!qty && !nums.length) return null;
  const NUM = '(?<![\\d.,])(\\d{1,4})(?![\\d.,])';
  const strong = new Set(), weak = new Set();
  let m;
  const reMore = new RegExp(NUM + '\\s*(?:more|extra|additional|new|fresh|other)\\b', 'gi');
  while((m = reMore.exec(t))) strong.add(Number(m[1]));
  const reWord = new RegExp('\\b(?:add|adding|added|increase|increasing|increment|top[ -]?up|another|plus|extra|additional|more|reduce|reducing|reduction|cut|remove|decrease|decreasing|lower|less|fewer)\\b(?:\\s+(?:it|my\\s+order|the\\s+order|this\\s+order|order|by|to|of|with|an?|the))*\\s+' + NUM, 'gi');
  while((m = reWord.exec(t))) strong.add(Number(m[1]));
  const reQty = new RegExp(NUM + '\\s*(?:crate|crates|tray|trays|carton|cartons)\\b', 'gi');
  while((m = reQty.exec(t))) weak.add(Number(m[1]));
  let pick = null;
  if(strong.size === 1) pick = [...strong][0];
  else if(strong.size === 0 && weak.size === 1) pick = [...weak][0];
  else if(strong.size === 0 && weak.size === 0 && nums.length === 1) pick = nums[0];
  // a message that only says "change / make it" gives a new total, not an amount to add or remove, so it is never turned into a +/- figure
  if(pick === null || !(adds || cuts)) return { crates: null };
  return { crates: (cuts && !adds) ? -pick : pick };
}
// ── Oct 13 2026 — address and delivery-day changes ──
// A customer who asks to change WHERE or WHEN the order is delivered must not be left to memory either. These two
// kinds of request hold the order exactly like a change of crates. Detection is deliberately generous: a false alarm
// costs one tap ("not a change"), a missed one costs a delivery to the wrong place or on the wrong day.
const ADDR_NOUN = /\b(address|location|street|junction|estate|landmark|drop[ -]?off|delivery point)\b/i;
const ADDR_CHANGE = /\b(change|changing|changed|new|different|another|instead|update|updating|move|moved|moving|wrong|correct|correction|relocat\w*|rather|alter\w*)\b/i;
function detectAddressChange(text) {
  const t = String(text || '');
  return ADDR_NOUN.test(t) && ADDR_CHANGE.test(t);
}
const DAY_CHANGE = /\b(instead|rather|change|changing|changed|reschedul\w*|postpone\w*|move|moved|moving|earlier|later|push(?:ed)?|bring(?:ing)? (?:it )?forward|another day|different day|new (?:day|date)|switch\w*)\b/i;
const WD_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
// Returns null when the message is not about changing the day, else { requestedDay } where requestedDay is the
// weekday the customer WANTS (days after "instead of", "rather than", "not", "from" are the old day), or null if it
// cannot be told from the words.
function detectDayChange(text, currentDay) {
  const t = String(text || '');
  const days = [];
  const re = /\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
  let m;
  while((m = re.exec(t))) days.push({ day: WD_FULL[m[1].slice(0, 3).toLowerCase()], idx: m.index });
  if(!(days.length || /\b(day|date|tomorrow|next week)\b/i.test(t))) return null;
  if(!DAY_CHANGE.test(t)) return null;
  const old = /(instead of|rather than|and not|not on|not|from|in place of)\s*$/i;
  const wanted = days.filter(d => !old.test(t.slice(Math.max(0, d.idx - 16), d.idx))).map(d => d.day).filter(d => d !== currentDay);
  const distinct = [...new Set(wanted)];
  return { requestedDay: distinct.length === 1 ? distinct[0] : null };
}
// Planning for a delivery day is settled by 3 PM the day before: a change asked for after that, or on the day
// itself, is LATE and only the Owner can approve it, with a recorded reason.
const CHANGE_CUTOFF_HOUR = 15;
function isLateChange(order, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const due = deliveryDateOf(order);
  const cutoff = new Date(due + 'T00:00:00+01:00').getTime() - 86400000 + CHANGE_CUTOFF_HOUR * 3600000;
  return now >= cutoff;
}
const KIND_WORDS = { volume_change: 'change the crates', address_change: 'change the delivery address', day_change: 'change the delivery day' };
const followupOut = r => ({
  id: Number(r.id), orderRef: r.order_ref, kind: r.kind, status: r.status, crates: r.crates === null ? null : Number(r.crates),
  orderCratesAtOpen: r.order_crates_at_open === null || r.order_crates_at_open === undefined ? null : Number(r.order_crates_at_open),
  source: r.source, sourceText: r.source_text || '', openedBy: r.opened_by || null, openedAt: new Date(r.opened_at).toISOString(),
  resolvedBy: r.resolved_by || null, resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null, note: r.note || '',
  detail: (r.detail && typeof r.detail === 'object') ? r.detail : {},
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
  const what = f.kind === 'address_change' ? 'change the delivery address'
    : f.kind === 'day_change' ? 'change the delivery day' + (f.detail && f.detail.requestedDay ? ' to ' + f.detail.requestedDay : '')
    : (f.crates ? `${f.crates > 0 ? 'add' : 'remove'} ${Math.abs(f.crates)} crates` : 'change the crates');
  const late = f.detail && f.detail.late;
  return push.notifyOwners({
    title: (late ? '⏰ LATE order change needs you' : '📦 Order change needs action'),
    body: `${order.customer_name || 'A customer'} (${order.ref}) wants to ${what}.${late ? ' This is after 3 PM the day before delivery.' : ''} The order is held until this is dealt with.`,
    url: `/famad-erp.html?ordmsg=${encodeURIComponent(order.ref)}`, tag: `followup-${order.ref}-${f.kind}`, kind: 'order_followup',
  });
}
// Opens (once) an address or delivery-day follow-up. Returns { followup, created }.
async function openOtherFollowup(order, kind, text, source, by, extra) {
  const open = await db.prepare("SELECT * FROM order_followups WHERE order_ref = ? AND kind = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(order.ref, kind);
  if(open) return { followup: followupOut(open), created: false };
  const detail = { ...(extra || {}), late: isLateChange(order), deliveryOn: deliveryDateOf(order), oldAddress: order.location || '', oldDay: order.preferred_delivery_day || '' };
  await db.prepare(`INSERT INTO order_followups (order_ref, kind, status, order_crates_at_open, source, source_text, opened_by, detail)
                    VALUES (?, ?, 'open', ?, ?, ?, ?, CAST(? AS jsonb))`)
    .run(order.ref, kind, order.crates === undefined ? null : order.crates, source, String(text || '').slice(0, 300), by || null, JSON.stringify(detail));
  const row = await db.prepare("SELECT * FROM order_followups WHERE order_ref = ? AND kind = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(order.ref, kind);
  return { followup: followupOut(row), created: true };
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
  const order = await db.prepare('SELECT ref, customer_id, customer_name, phone, created_at, status, payment_verified, preferred_delivery_day, crates, location FROM orders WHERE ref = ?').get(ref);
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
    const closedOrder = ['cancelled', 'rejected'].includes(String(order.status));
    const hit = closedOrder ? null : detectVolumeChange(body);
    if(hit) {
      const r = await openVolumeFollowup(order, hit.crates, body, 'auto', null);
      if(r.created) alertOwnerOfFollowup(order, r.followup).catch(e => console.error('[order-messages] follow-up alert failed:', e.message));
    }
  } catch(e) { console.error('[order-messages] follow-up check failed:', e.message); }
  // Oct 13 2026 — the same for a change of delivery address or delivery day (separate try so one failing never hides the other)
  try {
    if(!['cancelled', 'rejected'].includes(String(order.status))) {
      if(detectAddressChange(body)) {
        const r = await openOtherFollowup(order, 'address_change', body, 'auto', null, {});
        if(r.created) alertOwnerOfFollowup(order, r.followup).catch(e => console.error('[order-messages] follow-up alert failed:', e.message));
      }
      const dh = detectDayChange(body, order.preferred_delivery_day);
      if(dh) {
        const r = await openOtherFollowup(order, 'day_change', body, 'auto', null, { requestedDay: dh.requestedDay });
        if(r.created) alertOwnerOfFollowup(order, r.followup).catch(e => console.error('[order-messages] follow-up alert failed:', e.message));
      }
    }
  } catch(e) { console.error('[order-messages] address/day follow-up check failed:', e.message); }
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

// Oct 13 2026 — a rep may only deal with the orders of their own customers (plus customers nobody owns yet).
async function staffMayTouch(req, res, ref) {
  if(await repScope.canSeeOrder(await repScope.scopeOf(req), ref)) return true;
  res.status(403).json(repScope.NOT_YOURS);
  return false;
}

// ── Oct 13 2026 — follow-ups: things a customer asked for after ordering that must not be forgotten ──
// Every open follow-up (the ERP asks every minute or so, and before any dispatch step).
router.get('/followups/open', requireSupabaseAuth(), async (req, res) => {
  const cl = repScope.customerClause(await repScope.scopeOf(req), 'c');
  const rows = await db.prepare(`SELECT f.* FROM order_followups f LEFT JOIN orders o ON o.ref = f.order_ref LEFT JOIN customers c ON c.id = o.customer_id
                                 WHERE f.status = 'open' AND ${cl.sql} ORDER BY f.id ASC LIMIT 200`).all(...cl.params);
  res.json(rows.map(followupOut));
});
// Recent history for one order (open and closed), newest first.
router.get('/:ref/followups', requireSupabaseAuth(), async (req, res) => {
  if(!(await staffMayTouch(req, res, req.params.ref))) return;
  const rows = await db.prepare('SELECT * FROM order_followups WHERE order_ref = ? ORDER BY id DESC LIMIT 20').all(String(req.params.ref));
  res.json(rows.map(followupOut));
});
// Staff flag a message (or a phone call) as a volume change.
router.post('/:ref/followup', requireSupabaseAuth(), async (req, res) => {
  const order = await db.prepare('SELECT ref, customer_name, crates, status, location, created_at, preferred_delivery_day FROM orders WHERE ref = ?').get(String(req.params.ref));
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  if(!(await staffMayTouch(req, res, order.ref))) return;
  if(['cancelled', 'rejected'].includes(String(order.status))) return res.status(400).json({ error: 'That order is closed.' });
  const kind = String((req.body && req.body.kind) || 'volume_change');
  if(!['volume_change', 'address_change', 'day_change'].includes(kind)) return res.status(400).json({ error: 'Unknown kind of change.' });
  const text = cleanText(req.body && req.body.text).slice(0, 300) || 'Flagged by staff';
  const by = (req.user && req.user.email) || null;
  let r;
  if(kind === 'volume_change') {
    const n = parseInt(req.body && req.body.crates, 10);
    const crates = Number.isFinite(n) && n !== 0 && Math.abs(n) <= 100000 ? n : null;
    r = await openVolumeFollowup(order, crates, text, 'staff', by);
  } else {
    const dh = kind === 'day_change' ? detectDayChange(text, order.preferred_delivery_day) : null;
    const asked = String((req.body && req.body.requestedDay) || '');
    const requestedDay = DAY_INDEX[asked] !== undefined ? asked : (dh && dh.requestedDay) || null;
    r = await openOtherFollowup(order, kind, text, 'staff', by, kind === 'day_change' ? { requestedDay } : {});
  }
  if(r.created) alertOwnerOfFollowup(order, r.followup).catch(e => console.error('[order-messages] follow-up alert failed:', e.message));
  res.status(r.created ? 201 : 200).json(r.followup);
});
// Close a follow-up with a recorded outcome. The customer is always told, except when it was a false alarm.
router.post('/followups/:id/resolve', requireSupabaseAuth(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = Number.isInteger(id) ? await db.prepare('SELECT * FROM order_followups WHERE id = ?').get(id) : null;
  if(!f) return res.status(404).json({ error: 'Follow-up not found.' });
  if(!(await staffMayTouch(req, res, f.order_ref))) return;
  if(f.status !== 'open') return res.status(409).json({ error: 'That follow-up is already closed.' });
  if(f.kind === 'address_change' || f.kind === 'day_change') return resolveWhereWhen(req, res, f);
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

// ── address and delivery-day requests ──
// Address: any staff member records the new address and sends it to the Owner ("propose"); only the Owner approves
// ("applied"), and the Owner can also type the address and approve in one step. Day: only the Owner approves.
// Anyone may decline or mark a false alarm. A LATE request (after 3 PM the day before delivery, or on the day)
// needs the Owner's written reason to approve. Every outcome tells the customer, except a false alarm.
async function resolveWhereWhen(req, res, f) {
  const isOwner = !!(req.user && req.user.role === 'owner');
  const by = (req.user && req.user.email) || null;
  const outcome = String((req.body && req.body.outcome) || '');
  const allowed = f.kind === 'address_change' ? ['propose', 'applied', 'declined', 'dismissed'] : ['applied', 'declined', 'dismissed'];
  if(!allowed.includes(outcome)) return res.status(400).json({ error: 'Choose what was done.' });
  const note = cleanText(req.body && req.body.note).slice(0, 300);
  const message = cleanText(req.body && req.body.message);
  const order = await db.prepare('SELECT ref, customer_id, customer_name, crates, status, location, created_at, preferred_delivery_day FROM orders WHERE ref = ?').get(f.order_ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  const detail = (f.detail && typeof f.detail === 'object') ? { ...f.detail } : {};
  const gone = ['in_transit', 'fulfilled'].includes(String(order.status));
  if(outcome === 'propose') {
    const address = cleanText(req.body && req.body.address).slice(0, 300);
    if(address.length < 5) return res.status(400).json({ error: 'Type the full new delivery address.' });
    detail.proposal = { address, by, at: new Date().toISOString(), note };
    await db.prepare('UPDATE order_followups SET detail = CAST(? AS jsonb) WHERE id = ?').run(JSON.stringify(detail), f.id);
    push.notifyOwners({
      title: '📍 Address change needs your approval', body: `${order.customer_name || 'A customer'} (${order.ref}): new address proposed by ${by || 'staff'}.${detail.late ? ' LATE: after 3 PM the day before delivery.' : ''}`,
      url: `/famad-erp.html?ordmsg=${encodeURIComponent(order.ref)}`, tag: `followup-${order.ref}-${f.kind}`, kind: 'order_followup',
    }).catch(e => console.error('[order-messages] follow-up alert failed:', e.message));
    console.log(`[audit] Address proposal on ${order.ref} by ${by}`);
    return res.json(followupOut(await db.prepare('SELECT * FROM order_followups WHERE id = ?').get(f.id)));
  }
  if(outcome === 'applied') {
    if(!isOwner) return res.status(403).json({ error: 'Only the Owner can approve this change.', code: 'OWNER_ONLY' });
    if(gone) return res.status(409).json({ error: 'The order has already gone out, so this cannot be changed. Choose "Decline".' });
  }
  if(outcome !== 'dismissed' && (!message || message.length < 3)) return res.status(400).json({ error: 'Write the message to the customer: they must be told the outcome.' });
  if(message.length > MAX_STAFF_LEN) return res.status(400).json({ error: `Keep the message under ${MAX_STAFF_LEN} characters.` });
  if(outcome !== 'applied' && !note) return res.status(400).json({ error: 'Write a short note on what was decided.' });
  let finalNote = note;
  if(outcome === 'applied') {
    if(detail.late && note.length < 5) return res.status(400).json({ error: 'This request came in late (after 3 PM the day before delivery, or on the day). Write why you are approving it anyway.' });
    if(f.kind === 'address_change') {
      const address = cleanText(req.body && req.body.address).slice(0, 300) || (detail.proposal && detail.proposal.address) || '';
      if(address.length < 5) return res.status(400).json({ error: 'Type the new delivery address.' });
      await db.prepare('UPDATE orders SET location = ?, updated_at = now() WHERE ref = ?').run(address, order.ref);
      detail.oldAddress = detail.oldAddress || order.location || ''; detail.newAddress = address; detail.approvedBy = by;
      finalNote = `Address: ${(order.location || '').slice(0, 80)} to ${address.slice(0, 120)}${note ? ' (' + note + ')' : ''}`.slice(0, 300);
    } else {
      const day = String((req.body && req.body.day) || '');
      if(!['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].includes(day)) return res.status(400).json({ error: 'Choose the new delivery day (Monday to Saturday).' });
      if(day === String(order.preferred_delivery_day || '')) return res.status(409).json({ error: 'That is already the delivery day on this order.' });
      await db.prepare('UPDATE orders SET preferred_delivery_day = ?, updated_at = now() WHERE ref = ?').run(day, order.ref);
      const nowOn = deliveryDateOf({ ...order, preferred_delivery_day: day });
      detail.oldDay = detail.oldDay || order.preferred_delivery_day || ''; detail.newDay = day; detail.newDeliveryOn = nowOn; detail.approvedBy = by;
      finalNote = `Day: ${order.preferred_delivery_day || 'none'} to ${day} (delivery ${nowOn})${note ? ' (' + note + ')' : ''}`.slice(0, 300);
    }
  }
  await db.prepare('UPDATE order_followups SET status = ?, resolved_by = ?, resolved_at = now(), note = ?, detail = CAST(? AS jsonb) WHERE id = ?').run(outcome, by, finalNote, JSON.stringify(detail), f.id);
  if(message && outcome !== 'dismissed') {
    await db.prepare(`INSERT INTO order_messages (order_ref, direction, body, sender) VALUES (?, 'staff', ?, ?)`).run(order.ref, message, by);
    await db.prepare(`UPDATE order_messages SET read_at = now() WHERE order_ref = ? AND direction = 'customer' AND read_at IS NULL`).run(order.ref);
    push.notifyOrderReply(order, message).catch(e => console.error('[order-messages] push failed:', e.message));
  }
  console.log(`[audit] ${f.kind} follow-up ${f.id} on ${order.ref} closed as ${outcome} by ${by}`);
  res.json(followupOut(await db.prepare('SELECT * FROM order_followups WHERE id = ?').get(f.id)));
}

// One line per order that has messages (last 30 days) with the unread count.
router.get('/inbox', requireSupabaseAuth(), async (req, res) => {
  const cl = repScope.customerClause(await repScope.scopeOf(req), 'c');
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
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE m.created_at > now() - interval '30 days' AND ${cl.sql}
    GROUP BY m.order_ref, o.customer_name, o.phone, o.crates, o.status
    ORDER BY (COUNT(*) FILTER (WHERE m.direction = 'customer' AND m.read_at IS NULL) > 0) DESC, MAX(m.created_at) DESC
    LIMIT 200
  `).all(...cl.params);
  res.json(rows.map(r => ({
    ref: r.ref, customerName: r.customer_name || '', phone: r.phone || '', crates: r.crates, status: r.status,
    unread: r.unread, total: r.total, lastAt: new Date(r.last_at).toISOString(),
    lastDirection: r.last_direction, lastBody: String(r.last_body || '').slice(0, 140),
  })));
});

router.get('/:ref/staff', requireSupabaseAuth(), async (req, res) => {
  if(!(await staffMayTouch(req, res, req.params.ref))) return;
  const rows = await db.prepare('SELECT * FROM order_messages WHERE order_ref = ? ORDER BY id ASC LIMIT 200').all(String(req.params.ref));
  res.json(rows.map(asStaff));
});

router.post('/:ref/read', requireSupabaseAuth(), async (req, res) => {
  if(!(await staffMayTouch(req, res, req.params.ref))) return;
  const r = await db.prepare(`UPDATE order_messages SET read_at = now() WHERE order_ref = ? AND direction = 'customer' AND read_at IS NULL`).run(String(req.params.ref));
  res.json({ ok: true, marked: r.changes || 0 });
});

router.post('/:ref/reply', requireSupabaseAuth(), async (req, res) => {
  const ref = String(req.params.ref);
  const order = await db.prepare('SELECT ref, customer_id FROM orders WHERE ref = ?').get(ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  if(!(await staffMayTouch(req, res, ref))) return;
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
module.exports.detectVolumeChange = detectVolumeChange;
module.exports.detectAddressChange = detectAddressChange;
module.exports.detectDayChange = detectDayChange;
module.exports.isLateChange = isLateChange;   // exported for the test suite
