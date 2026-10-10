// lib/portal-checks.js (Oct 10 2026)
//
// The customer portal used to read your prices, promotions, limits and
// blocklist from the customer's OWN phone — which has none of them — and
// the server never double-checked an order. This file is the server's own
// copy of those rules: one place that knows the real prices and limits, used
// by (a) the portal-config route (what the portal shows) and (b) the orders
// route (what the server accepts).
const { db } = require('../db.postgres');

// "0801 234 5678", "+234 801 234 5678" and "2348012345678" all become the
// same last-10-digits string.
function normPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if(d.startsWith('234')) d = d.slice(3);
  if(d.startsWith('0')) d = d.slice(1);
  return d.slice(-10);
}

async function getSettingRaw(key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
async function getSettingJson(key, fallback) {
  const raw = await getSettingRaw(key);
  if(raw == null) return fallback;
  try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch(e) { return fallback; }
}
async function getSettingNumber(key) {
  const raw = await getSettingRaw(key);
  const n = raw == null ? NaN : parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// ── Pricing ────────────────────────────────────────────────────────────
// The volume discount grows with order size and levels off at
// (target margin − margin floor). Only that discount curve is ever sent to a
// customer's phone — never the margin figures themselves, because the
// selling price minus the target margin would give away your cost.
const DEFAULT_HALF_LIFE = 30;

async function getPricing() {
  const sellingPrice = await getSettingNumber('selling_price');
  const floor  = await getSettingNumber('price_floor');
  const target = await getSettingNumber('target_margin');
  const vp = await getSettingJson('volume_pricing', null);
  const halfLife = (vp && Number(vp.halfLife) > 0) ? Number(vp.halfLife) : DEFAULT_HALF_LIFE;
  // Unknown margins => no discount at all, which is the safe side for margin.
  const maxDiscount = (floor != null && target != null) ? Math.max(0, target - floor) : 0;
  return { sellingPrice, maxDiscount, halfLife };
}
function discountForCrates(p, crates) {
  const k = p.halfLife / Math.LN2;
  return Math.max(0, Math.round(p.maxDiscount * (1 - Math.exp(-Math.max(0, crates) / k))));
}

async function getActivePromotions() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.prepare('SELECT id, name, segment, discount, min_crates, until FROM promotions WHERE active = true ORDER BY id DESC').all();
  return rows
    .filter(p => !p.until || p.until === '—' || p.until >= today)
    .map(p => ({ id: p.id, name: p.name, segment: p.segment, discount: p.discount || 0, minCrates: p.min_crates || 0, until: p.until, active: true }));
}

// ── Customer history ───────────────────────────────────────────────────
// "Returning" = at least one completed sale on record, found by phone first,
// then by exact name.
async function customerHasSales(phone, name) {
  const n = normPhone(phone);
  if(n) {
    const row = await db.prepare(`
      SELECT COUNT(*)::int AS n FROM sales s
      JOIN customers c ON c.id = s.customer_id
      WHERE RIGHT(regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g'), 10) = ?
    `).get(n);
    if(row && row.n > 0) return true;
  }
  if(name) {
    const row = await db.prepare('SELECT COUNT(*)::int AS n FROM sales WHERE LOWER(customer_name) = LOWER(?)').get(String(name).trim());
    if(row && row.n > 0) return true;
  }
  return false;
}

async function isBlocked(phone) {
  const n = normPhone(phone);
  if(n.length < 7) return false;
  const row = await db.prepare('SELECT 1 AS x FROM reservation_blocklist WHERE phone_norm = ? LIMIT 1').get(n);
  return !!row;
}

async function hasActiveReservation(phone) {
  const n = normPhone(phone);
  if(n.length < 7) return false;
  const row = await db.prepare(`
    SELECT 1 AS x FROM orders
    WHERE status = 'reserved'
      AND (reservation_expires_at IS NULL OR reservation_expires_at > now())
      AND RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = ?
    LIMIT 1
  `).get(n);
  return !!row;
}

// ── The one check run before a portal order or reservation is accepted ──
// kind: 'reservation' | 'order'. Wording is deliberately generic where it
// would otherwise confirm that someone is on the blocklist.
async function portalPrecheck({ phone, customerName, crates, kind }) {
  const isRes = kind === 'reservation';
  const generic = isRes
    ? 'This reservation could not be completed. Please contact us on WhatsApp to place your order directly.'
    : 'This order could not be completed. Please contact us on WhatsApp to place your order directly.';

  if(await isBlocked(phone)) return { ok: false, code: 'blocked', message: generic };

  const returning = await customerHasSales(phone, customerName);
  const abuse = await getSettingJson('abuse_settings', {});
  const cap = Number(abuse.newCustomerMaxCrates) > 0 ? Number(abuse.newCustomerMaxCrates) : 50;

  if(isRes) {
    if(await hasActiveReservation(phone)) {
      return { ok: false, code: 'active_reservation', message: 'You already have an active reservation. Please complete or let it expire before reserving again.', returning, cap };
    }
    if(!returning && Number(crates) > cap) {
      return { ok: false, code: 'new_customer_cap', message: `New customers can reserve up to ${cap} crates.`, returning, cap };
    }
  }
  return { ok: true, returning, cap };
}

// ── Price re-check (flag mode) ─────────────────────────────────────────
// Lowest egg price per crate a customer could legitimately be quoted: the
// selling price, less the volume discount for that many crates, less the
// biggest promotion currently running. Anything below that (allowing a few
// naira for rounding) did not come from the real rules.
async function priceLowerBound(crates) {
  const p = await getPricing();
  if(p.sellingPrice == null) return null;
  const promos = await getActivePromotions();
  const bestPromo = promos.reduce((m, x) => Math.max(m, x.discount || 0), 0);
  return Math.max(0, p.sellingPrice - discountForCrates(p, crates) - bestPromo);
}

async function logServerEvent({ entryId, category, level, message, detail }) {
  try {
    await db.prepare(`
      INSERT INTO system_events (entry_id, category, level, message, detail, client_at)
      VALUES (?, ?, ?, ?, ?, now())
      ON CONFLICT (entry_id) DO NOTHING
    `).run(entryId, category, level, message, JSON.stringify(detail || null));
  } catch(e) { console.warn('[server-event] could not write:', e.message); }
}

module.exports = {
  normPhone, getSettingJson, getSettingNumber,
  getPricing, discountForCrates, getActivePromotions,
  customerHasSales, isBlocked, hasActiveReservation, portalPrecheck,
  priceLowerBound, logServerEvent,
};
