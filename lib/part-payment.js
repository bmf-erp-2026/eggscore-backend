// lib/part-payment.js (Oct 15 2026): the server's own copy of the part-payment rules.
//
// A customer on the portal may ASK to pay part of an order now and the rest later. This file decides, on the server,
// whether they may ask and how much would be due now. Nothing here moves money or changes a tier: it works out a figure
// and the Owner confirms or declines each request in the ERP (routes-postgres/part-payment.js).
//
// What is deferred is a share of the MARGIN, never of the order: the cost of the eggs is always paid up front. The share
// follows the customer's Trust Tier (same figures as the ERP's Scorecard settings: Building 25%, Established 50%,
// Proven 80%). Delivery is always due now, in full.
//
// Owner can change any of these by saving a setting (JSON or number); a missing or broken value falls back to the default:
//   margin_defer_pct     {"building":0.25,"established":0.5,"proven":0.8}
//   part_payment_levels  ["established","proven"]   which levels may ask (the Owner chose Established and Proven first)
//   part_payment_days    7                          days allowed for the balance (the Owner chose 7)
const { db } = require('../db.postgres');
const pc = require('./portal-checks');
const tb = require('./tier-bars');

const DEFAULT_DEFER = { new: 0, building: 0.25, established: 0.5, proven: 0.8 };
const DEFAULT_LEVELS = ['established', 'proven'];
const DEFAULT_DAYS = 7;

async function getRules() {
  const savedDefer = await pc.getSettingJson('margin_defer_pct', {});
  const defer = {};
  Object.keys(DEFAULT_DEFER).forEach(l => {
    const v = Number(savedDefer && savedDefer[l]);
    defer[l] = (Number.isFinite(v) && v >= 0 && v <= 1) ? v : DEFAULT_DEFER[l];
  });
  let levels = await pc.getSettingJson('part_payment_levels', DEFAULT_LEVELS);
  levels = Array.isArray(levels) ? levels.map(x => String(x).toLowerCase()).filter(x => tb.LEVELS.includes(x) && x !== 'new') : DEFAULT_LEVELS;
  if(!levels.length) levels = DEFAULT_LEVELS;
  const d = await pc.getSettingNumber('part_payment_days');
  const days = (d != null && d >= 1 && d <= 60) ? Math.round(d) : DEFAULT_DAYS;
  return { defer, levels, days };
}

// Cost of the next crate to leave the yard: the oldest batch that still has eggs in it (first in, first out),
// falling back to the newest batch on record.
async function fifoCost() {
  const row = await db.prepare('SELECT cost FROM batches WHERE remaining > 0 ORDER BY received_date ASC, created_at ASC LIMIT 1').get();
  if(row && Number(row.cost) > 0) return Number(row.cost);
  const last = await db.prepare('SELECT cost FROM batches ORDER BY received_date DESC, created_at DESC LIMIT 1').get();
  return last && Number(last.cost) > 0 ? Number(last.cost) : null;
}

// Names of customers who still owe written-off money (same rule as owner-records.js /credit-blocked/names).
async function badDebtNames() {
  const debts = await db.prepare("SELECT id, data FROM owner_records WHERE kind = 'bad_debt'").all();
  const recs = await db.prepare("SELECT data FROM owner_records WHERE kind = 'bad_debt_recovery'").all();
  const got = {};
  recs.forEach(r => { const d = r.data || {}; got[d.badDebtId] = (got[d.badDebtId] || 0) + (Number(d.amount) || 0); });
  const names = new Set();
  debts.forEach(r => { const d = r.data || {}; if((Number(d.amount) || 0) - (got[r.id] || 0) > 0.5 && d.customerName) names.add(d.customerName); });
  return names;
}

const verified = c => !!(c.verify_grandfathered || (c.shop_verified_at && c.phone_verified_at));

// The one check. phone is optional here (the Owner's confirm step re-checks by name alone); when it IS given it must be
// the customer's own number, so a stranger typing someone else's business name gets nothing.
async function evaluate({ customerName, phone, crates, eggPricePerCrate, deliveryTotal }) {
  const no = (code) => ({ ok: false, code, message: 'Part payment is not available for this order.' });
  const name = String(customerName || '').trim();
  const n = Math.round(Number(crates)), price = Number(eggPricePerCrate), delivery = Math.max(0, Number(deliveryTotal) || 0);
  if(!name || !(n > 0) || !(price > 0)) return no('bad_input');
  const c = await db.prepare('SELECT id, name, phone, trust_tier, shop_verified_at, phone_verified_at, verify_grandfathered FROM customers WHERE name = ?').get(name);
  if(!c) return no('unknown_customer');
  if(phone && pc.normPhone(c.phone) !== pc.normPhone(phone)) return no('phone_mismatch');
  const level = String(c.trust_tier || 'new').toLowerCase();
  const rules = await getRules();
  if(!rules.levels.includes(level)) return { ...no('level'), level };
  if(!verified(c)) return { ...no('unverified'), level };
  if((await badDebtNames()).has(c.name)) return { ...no('blocked'), level };
  const cost = await fifoCost();
  if(cost == null) return { ...no('no_cost'), level };
  const eggRevenue = n * price;
  const margin = Math.max(0, eggRevenue - n * cost);
  const deferPct = rules.defer[level] || 0;
  if(!(margin > 0) || !(deferPct > 0)) return { ...no('no_margin'), level };
  const financed = Math.round(margin * deferPct);
  // The customer is shown a round number; rounding is always UP so the Owner is never short.
  const payNow = Math.min(eggRevenue + delivery, Math.ceil((eggRevenue - financed + delivery) / 100) * 100);
  const total = eggRevenue + delivery;
  return { ok: true, level, payNow, balance: Math.max(0, total - payNow), total, days: rules.days, customerId: c.id };
}

module.exports = { evaluate, getRules, fifoCost, DEFAULT_DEFER, DEFAULT_LEVELS, DEFAULT_DAYS };
