// lib/push.js — Web Push engine for the EggScore customer portal (Oct 9 2026).
//
// What this file does, in plain terms:
//   1. Holds the one place that actually sends a notification to a phone.
//   2. Knows the wording of every AUTOMATIC message (English + Pidgin).
//   3. Runs a small timer that sends the delivery-day reminders and the
//      "we miss you" nudges at the right hour, Lagos time.
//   4. Exposes notifyOrderChange(), called by routes-postgres/orders.js
//      whenever staff move an order forward, to tell the customer.
//
// Safety rules baked in (so a bug or a busy day cannot spam anyone):
//   - A given automatic message is sent to a given device ONCE (push_sent has a
//     unique dedupe key per device).
//   - Promo-type messages (reminder / winback / broadcast) are capped per device
//     per week (default 3). Order updates are never capped — they are service
//     messages the customer asked for.
//   - If VAPID keys are not configured, everything here quietly does nothing.
const { db } = require('../db.postgres');

// Loaded defensively: if the web-push package ever failed to install, the
// rest of the backend (orders, sales, everything) must still boot and run.
// Push simply stays OFF and says why in the log.
let webpush = null;
try { webpush = require('web-push'); }
catch(e) { console.error('[push] "web-push" package is not installed — push notifications are OFF.'); }

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'https://order.eggscore.com.ng';

let pushEnabled = false;
if(webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushEnabled = true;
  } catch(e) {
    console.error('[push] VAPID keys present but invalid — push disabled:', e.message);
  }
} else {
  console.log('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications are OFF.');
}

function isEnabled() { return pushEnabled; }
function getPublicKey() { return pushEnabled ? VAPID_PUBLIC_KEY : null; }

// ── Settings (stored in the existing key/value `settings` table) ─────────
const DEFAULT_SETTINGS = {
  orderUpdates: true,       // "confirmed / on its way / delivered" messages
  deliveryReminders: true,  // "Wednesday delivery closes tonight"
  winback: true,            // "we miss you" for customers quiet 30+ days
  reminderHour: 16,         // Lagos hour (0-23) the reminder goes out
  winbackHour: 10,          // Lagos hour the win-back goes out
  weeklyCap: 3,             // max promo-type messages per device per 7 days
  winbackAfterDays: 30,     // how long quiet before a win-back
};

async function getSettings() {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'push_settings'").get();
    if(row && row.value) return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
  } catch(e) { /* fall through to defaults */ }
  return { ...DEFAULT_SETTINGS };
}

function cleanSettings(input) {
  const out = {};
  for(const k of ['orderUpdates', 'deliveryReminders', 'winback']) {
    if(typeof input[k] === 'boolean') out[k] = input[k];
  }
  const intIn = (k, lo, hi) => {
    const n = parseInt(input[k], 10);
    if(Number.isInteger(n) && n >= lo && n <= hi) out[k] = n;
  };
  intIn('reminderHour', 0, 23);
  intIn('winbackHour', 0, 23);
  intIn('weeklyCap', 1, 14);
  intIn('winbackAfterDays', 7, 180);
  return out;
}

async function saveSettings(input, updatedBy) {
  const merged = { ...(await getSettings()), ...cleanSettings(input) };
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('push_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(merged), updatedBy || null);
  return merged;
}

// ── Lagos clock (Africa/Lagos is UTC+1 all year, no daylight saving) ─────
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function lagosNow(offsetDays = 0) {
  const d = new Date(Date.now() + 3600000 + offsetDays * 86400000);
  const p = n => String(n).padStart(2, '0');
  return {
    hour: d.getUTCHours(),
    weekday: WEEKDAYS[d.getUTCDay()],
    dateKey: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    monthKey: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`,
  };
}

async function activeDeliveryDays() {
  const rows = await db.prepare('SELECT name FROM delivery_days WHERE active = true ORDER BY id ASC').all();
  return rows.map(r => String(r.name || '').trim()).filter(Boolean);
}

// Next delivery day AFTER today (never today — same rule as the portal).
function nextDeliveryDayName(days) {
  const lower = days.map(d => d.toLowerCase());
  for(let i = 1; i <= 7; i++) {
    const w = lagosNow(i).weekday;
    const idx = lower.indexOf(w.toLowerCase());
    if(idx !== -1) return days[idx];
  }
  return null;
}

// ── Message wording ──────────────────────────────────────────────────────
// Each message is { en: {title, body}, pcm: {title, body} }. Pidgin is
// deliberately simple and warm; Bob should read it over and adjust.
const crateWord = n => (n === 1 ? 'crate' : 'crates');

const MSG = {
  order_paid: o => ({
    en:  { title: 'Payment received ✅', body: `We have confirmed your payment for order ${o.ref}. We are preparing your eggs.` },
    pcm: { title: 'We don see your payment ✅', body: `Your payment for order ${o.ref} don land. We dey prepare your eggs.` },
  }),
  order_confirmed: o => ({
    en:  { title: 'Order confirmed', body: `Your ${o.crates} ${crateWord(o.crates)} of eggs ${o.crates === 1 ? 'is' : 'are'} confirmed. We will tell you when ${o.crates === 1 ? 'it is' : 'they are'} on the road.` },
    pcm: { title: 'Your order don confirm', body: `Your ${o.crates} ${o.crates === 1 ? 'crate' : 'crates'} of eggs dey ready. We go tell you as e dey comot.` },
  }),
  order_in_transit: o => ({
    en:  { title: 'Your eggs are on the way 🚚', body: `Your ${o.crates} ${crateWord(o.crates)} ${o.crates === 1 ? 'is' : 'are'} on the road to you. Please keep your phone close for the driver's call.` },
    pcm: { title: 'Your eggs don comot 🚚', body: `Your ${o.crates} ${o.crates === 1 ? 'crate' : 'crates'} dey road come. Make you pick phone when driver call.` },
  }),
  order_fulfilled: o => ({
    en:  { title: 'Delivered — thank you! 🥚', body: `Order ${o.ref} is complete. Tap to order again whenever you are ready.` },
    pcm: { title: 'Your order don complete — thank you! 🥚', body: `Order ${o.ref} don finish. Tap to order again any time you ready.` },
  }),
  order_cancelled: o => ({
    en:  { title: 'Update on your order', body: `Order ${o.ref} was not completed. Message us on WhatsApp if this surprises you.` },
    pcm: { title: 'Update on your order', body: `Order ${o.ref} no go through. Message us for WhatsApp if e shock you.` },
  }),
  reminder: day => ({
    en:  { title: `${day} delivery closes tonight`, body: `Order today to be on ${day}'s delivery run. Tap to order.` },
    pcm: { title: `${day} delivery dey close tonight`, body: `Order today make you dey ${day} delivery. Tap to order.` },
  }),
  winback: day => ({
    en:  { title: 'We miss you 🥚', body: day ? `Fresh eggs are ready. Our next delivery day is ${day}. Tap to order.` : 'Fresh eggs are ready whenever you are. Tap to order.' },
    pcm: { title: 'We don miss you 🥚', body: day ? `Fresh eggs dey ready. Our next delivery day na ${day}. Tap to order.` : 'Fresh eggs dey ready any time you want. Tap to order.' },
  }),
};

function pickMessage(msg, language) {
  const m = (language === 'pcm' && msg.pcm && msg.pcm.title && msg.pcm.body) ? msg.pcm : msg.en;
  return m;
}

// ── The one function that talks to a phone ───────────────────────────────
async function sendOne(sub, payload, ttlSeconds) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: ttlSeconds || 86400, urgency: 'normal' }
    );
    await db.prepare('UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = ?').run(sub.id);
    return { ok: true };
  } catch(err) {
    const code = err && err.statusCode;
    if(code === 404 || code === 410) {
      // The phone removed the subscription (app uninstalled, permission revoked).
      await db.prepare('UPDATE push_subscriptions SET active = false WHERE id = ?').run(sub.id);
      return { ok: false, gone: true };
    }
    await db.prepare(`
      UPDATE push_subscriptions
      SET failure_count = failure_count + 1,
          active = CASE WHEN failure_count + 1 >= 5 THEN false ELSE active END
      WHERE id = ?
    `).run(sub.id);
    console.error(`[push] send failed (sub ${sub.id}, status ${code || 'n/a'}):`, err && err.body ? String(err.body).slice(0, 200) : err.message);
    return { ok: false, gone: false };
  }
}

// kinds that count toward the weekly "don't spam" cap
const CAPPED_KINDS = ['reminder', 'winback', 'broadcast'];

// Sends one message to a list of subscriptions.
//   message : { en:{title,body}, pcm?:{title,body} }
//   opts    : { kind, url, tag, ttl, dedupeKey, enforceCap, weeklyCap }
// Returns { targeted, delivered, failed, skipped }.
async function deliver(subs, message, opts) {
  const result = { targeted: subs.length, delivered: 0, failed: 0, skipped: 0 };
  if(!pushEnabled || subs.length === 0) return result;

  for(let i = 0; i < subs.length; i += 10) {
    const batch = subs.slice(i, i + 10);
    await Promise.all(batch.map(async sub => {
      try {
        // 1. never send the same automatic message to a device twice
        let sentRowId = null;
        if(opts.dedupeKey) {
          const ins = await db.prepare(`
            INSERT INTO push_sent (subscription_id, kind, dedupe_key) VALUES (?, ?, ?)
            ON CONFLICT DO NOTHING
          `).run(sub.id, opts.kind, opts.dedupeKey);
          if(!ins.changes) { result.skipped++; return; }
          sentRowId = ins.lastInsertRowid;
        }
        // 2. weekly cap for promo-type messages
        if(opts.enforceCap) {
          const row = await db.prepare(`
            SELECT COUNT(*)::int AS n FROM push_sent
            WHERE subscription_id = ? AND kind IN ('reminder','winback','broadcast')
              AND created_at > now() - interval '7 days'
              ${sentRowId ? 'AND id <> ' + Number(sentRowId) : ''}
          `).get(sub.id);
          if(row && row.n >= (opts.weeklyCap || 3)) {
            if(sentRowId) await db.prepare('DELETE FROM push_sent WHERE id = ?').run(sentRowId);
            result.skipped++;
            return;
          }
        }
        const m = pickMessage(message, sub.language);
        const payload = {
          title: m.title, body: m.body,
          url: opts.url || '/famad-order.html',
          tag: opts.tag || undefined,
          kind: opts.kind,
        };
        const r = await sendOne(sub, payload, opts.ttl);
        if(r.ok) {
          result.delivered++;
          if(!sentRowId) {
            await db.prepare('INSERT INTO push_sent (subscription_id, kind) VALUES (?, ?)').run(sub.id, opts.kind);
          }
        } else {
          result.failed++;
          // transient failure: free the dedupe slot so a later tick can retry
          if(sentRowId) await db.prepare('DELETE FROM push_sent WHERE id = ?').run(sentRowId);
        }
      } catch(e) {
        result.failed++;
        console.error('[push] deliver error:', e.message);
      }
    }));
  }
  return result;
}

async function logCampaign(kind, message, audience, result, createdBy) {
  try {
    await db.prepare(`
      INSERT INTO push_log (kind, title_en, body_en, title_pcm, body_pcm, audience, targeted, delivered, failed, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(kind, message.en.title, message.en.body,
           message.pcm ? message.pcm.title : null, message.pcm ? message.pcm.body : null,
           audience || null, result.targeted, result.delivered, result.failed, createdBy || null);
  } catch(e) { console.error('[push] log error:', e.message); }
}

// ── Audiences ────────────────────────────────────────────────────────────
const NOT_DEAD = "o.status NOT IN ('cancelled','rejected')";

async function subsForAudience(audience, settings) {
  const a = audience || { type: 'all' };
  const days = Math.max(1, parseInt((settings && settings.winbackAfterDays) || 30, 10));
  let where = 's.active = true';
  const params = [];
  switch(a.type) {
    case 'wholesalers':
      where += " AND c.type = 'Wholesaler'";
      break;
    case 'inactive':
      where += ` AND s.customer_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM orders o WHERE o.customer_id = s.customer_id AND ${NOT_DEAD}
          AND o.created_at > now() - interval '${days} days')`;
      break;
    case 'highvolume':
      where += ` AND s.customer_id IS NOT NULL AND (
        SELECT COALESCE(SUM(o.crates), 0) FROM orders o WHERE o.customer_id = s.customer_id AND ${NOT_DEAD}
          AND o.created_at > now() - interval '30 days') >= 200`;
      break;
    case 'customer': {
      const digits = String(a.phone || '').replace(/\D/g, '');
      if(digits.length < 7) return [];
      where += " AND RIGHT(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = ?";
      params.push(digits.slice(-10));
      break;
    }
    case 'all':
    default:
      break;
  }
  return db.prepare(`
    SELECT s.* FROM push_subscriptions s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE ${where}
  `).all(...params);
}

// ── Owner broadcast ──────────────────────────────────────────────────────
async function broadcast({ titleEn, bodyEn, titlePcm, bodyPcm, url, audience, createdBy, dryRun }) {
  const settings = await getSettings();
  const subs = await subsForAudience(audience, settings);
  if(dryRun) return { targeted: subs.length, delivered: 0, failed: 0, skipped: 0, dryRun: true };

  const message = {
    en: { title: titleEn, body: bodyEn },
    pcm: (titlePcm && bodyPcm) ? { title: titlePcm, body: bodyPcm } : null,
  };
  const isTest = audience && audience.type === 'customer';
  const kind = isTest ? 'test' : 'broadcast';
  const result = await deliver(subs, message, {
    kind, url, tag: isTest ? undefined : 'bel-promo', ttl: 86400 * 2, enforceCap: false,
  });
  await logCampaign(kind, message, (audience && audience.type) || 'all', result, createdBy);
  return result;
}

// ── Order updates (called from routes-postgres/orders.js) ────────────────
async function subsForCustomer(customerId) {
  if(!customerId) return [];
  return db.prepare('SELECT * FROM push_subscriptions WHERE customer_id = ? AND active = true').all(customerId);
}

// before = the order row before the PATCH, after = the row after it.
async function notifyOrderChange(before, after) {
  if(!pushEnabled || !after || !after.customer_id) return;
  const settings = await getSettings();
  if(!settings.orderUpdates) return;

  const events = [];
  const wasPaid = Number(before.payment_verified) === 1, isPaid = Number(after.payment_verified) === 1;
  if(!wasPaid && isPaid) events.push(['paid', MSG.order_paid]);
  if(before.status !== after.status) {
    if(after.status === 'confirmed')       events.push(['confirmed', MSG.order_confirmed]);
    else if(after.status === 'in_transit') events.push(['in_transit', MSG.order_in_transit]);
    else if(after.status === 'fulfilled')  events.push(['fulfilled', MSG.order_fulfilled]);
    else if(after.status === 'cancelled' || after.status === 'rejected') events.push(['cancelled', MSG.order_cancelled]);
  }
  if(events.length === 0) return;

  const subs = await subsForCustomer(after.customer_id);
  if(subs.length === 0) return;
  for(const [name, build] of events) {
    const message = build({ ref: after.ref, crates: after.crates });
    const result = await deliver(subs, message, {
      kind: 'order_update', dedupeKey: `order:${after.ref}:${name}`,
      tag: `order-${after.ref}`, url: '/famad-order.html', ttl: 86400 * 2,
    });
    await logCampaign('order_update', message, `order ${after.ref} (${name})`, result, 'system');
  }
}

// ── Scheduled messages ───────────────────────────────────────────────────
async function runDeliveryReminders(settings) {
  const tomorrow = lagosNow(1);
  const days = await activeDeliveryDays();
  const match = days.find(d => d.toLowerCase() === tomorrow.weekday.toLowerCase());
  if(!match) return;

  // Skip customers who already have an open order booked for that day.
  const subs = await db.prepare(`
    SELECT s.* FROM push_subscriptions s
    WHERE s.active = true AND NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.customer_id = s.customer_id
        AND o.status IN ('pending','reserved','confirmed')
        AND LOWER(COALESCE(o.preferred_delivery_day, '')) = LOWER(?)
    )
  `).all(match);
  if(subs.length === 0) return;

  const message = MSG.reminder(match);
  const result = await deliver(subs, message, {
    kind: 'reminder', dedupeKey: `reminder:${tomorrow.dateKey}`, tag: 'bel-reminder',
    url: '/famad-order.html', ttl: 3600 * 6, enforceCap: true, weeklyCap: settings.weeklyCap,
  });
  if(result.delivered || result.failed) await logCampaign('reminder', message, `${match} reminder`, result, 'system');
}

async function runWinback(settings) {
  const subs = await subsForAudience({ type: 'inactive' }, settings);
  if(subs.length === 0) return;
  const nextDay = nextDeliveryDayName(await activeDeliveryDays());
  const message = MSG.winback(nextDay);
  const result = await deliver(subs, message, {
    kind: 'winback', dedupeKey: `winback:${lagosNow().monthKey}`, tag: 'bel-winback',
    url: '/famad-order.html', ttl: 86400, enforceCap: true, weeklyCap: settings.weeklyCap,
  });
  if(result.delivered || result.failed) await logCampaign('winback', message, `quiet ${settings.winbackAfterDays}+ days`, result, 'system');
}

let schedulerTimer = null;
async function schedulerTick() {
  if(!pushEnabled) return;
  try {
    const settings = await getSettings();
    const now = lagosNow();
    // A 3-hour window after the chosen hour, so a server restart at the
    // wrong minute doesn't skip the whole day. The per-day dedupe key
    // guarantees each device still only receives it once.
    if(settings.deliveryReminders && now.hour >= settings.reminderHour && now.hour <= settings.reminderHour + 2) {
      await runDeliveryReminders(settings);
    }
    if(settings.winback && now.hour >= settings.winbackHour && now.hour <= settings.winbackHour + 2) {
      await runWinback(settings);
    }
  } catch(e) {
    console.error('[push] scheduler error:', e.message);
  }
}

function startScheduler() {
  if(schedulerTimer || !pushEnabled) return;
  schedulerTimer = setInterval(schedulerTick, 10 * 60 * 1000);
  setTimeout(schedulerTick, 30 * 1000);
  console.log('[push] scheduler started (checks every 10 minutes, Lagos time).');
}

module.exports = {
  isEnabled, getPublicKey, getSettings, saveSettings, DEFAULT_SETTINGS,
  subsForAudience, broadcast, notifyOrderChange, startScheduler,
  // exposed for tests
  _internal: { lagosNow, nextDeliveryDayName, pickMessage, MSG, cleanSettings, runDeliveryReminders, runWinback, deliver, schedulerTick },
};
