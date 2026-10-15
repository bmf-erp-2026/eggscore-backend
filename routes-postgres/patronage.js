const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth } = require('../auth.postgres');
const pc = require('../lib/portal-checks');

const router = express.Router();

// GET /patronage/:customerName (Oct 15 2026, Portal part payment, Stage 1)
//
// Read-only. Feeds the "Your patronage level" ticker on the customer portal: the customer's level (the Trust Tier
// the Owner has set for them) and how far they are toward the next one, measured as a MIX of three things:
// months as a customer, number of orders, and crates bought.
//
// Deliberately NOT here: how much of an order's margin each level may defer, costs, margins, credit limits. The
// level only moves when the Owner changes it in the ERP; this route never changes anything, it only shows progress.
const LEVELS = ['new', 'building', 'established', 'proven'];
const NAMES = { new: 'New', building: 'Building', established: 'Established', proven: 'Proven' };

// What a customer needs to have reached the level named on the left. Owner can override by saving a setting called
// patronage_thresholds (same shape); a missing or broken value falls back to these.
const DEFAULTS = {
  building:    { months: 1, orders: 3,  crates: 50 },
  established: { months: 3, orders: 20, crates: 1000 },
  proven:      { months: 6, orders: 40, crates: 4000 },
};

const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
async function thresholdsFor(level) {
  const saved = await pc.getSettingJson('patronage_thresholds', {});
  const s = (saved && saved[level]) || {};
  const d = DEFAULTS[level];
  return { months: num(s.months) || d.months, orders: num(s.orders) || d.orders, crates: num(s.crates) || d.crates };
}

router.get('/:customerName', requireEitherAuth(), async (req, res) => {
  const name = String(req.params.customerName || '').trim();
  if(!name) return res.status(400).json({ error: 'customerName is required.' });
  const cust = await db.prepare('SELECT name, trust_tier FROM customers WHERE name = ?').get(name);
  if(!cust) return res.status(404).json({ error: 'Customer not found.' });

  let level = String(cust.trust_tier || 'new').toLowerCase();
  if(!LEVELS.includes(level)) level = 'new';
  const idx = LEVELS.indexOf(level);

  if(idx === LEVELS.length - 1) {
    return res.json({ level, levelName: NAMES[level], top: true, next: null, nextName: null, progressPct: 100, ready: false, measures: [] });
  }

  // One row per invoice. The sales table holds 219 doubled rows from 3 Sep 2026 (a rep's device re-sent other reps'
  // sales before the duplicate guard existed); counting rows would show a customer too many orders and crates.
  const row = await db.prepare(`
    WITH uniq AS (
      SELECT DISTINCT ON (COALESCE(invoice_ref, 'id-' || id::text)) crates, sale_date
      FROM sales
      WHERE customer_name = ? AND COALESCE(fully_reversed, 0) = 0
      ORDER BY COALESCE(invoice_ref, 'id-' || id::text), id
    )
    SELECT COUNT(*)::int AS orders, COALESCE(SUM(crates), 0)::int AS crates, MIN(sale_date) AS first_sale FROM uniq`).get(cust.name);
  const orders = (row && row.orders) || 0;
  const crates = (row && row.crates) || 0;
  const first = row && row.first_sale ? new Date(row.first_sale).getTime() : NaN;
  const months = Number.isFinite(first) ? Math.max(0, (Date.now() - first) / (30.44 * 86400000)) : 0;

  const next = LEVELS[idx + 1];
  const need = await thresholdsFor(next);
  const ratio = (have, want) => Math.max(0, Math.min(1, have / want));
  const rs = [ratio(months, need.months), ratio(orders, need.orders), ratio(crates, need.crates)];
  const ready = rs.every(r => r >= 1);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const progressPct = ready ? 100 : Math.min(99, Math.round(mean * 100));

  res.json({
    level, levelName: NAMES[level], top: false, next, nextName: NAMES[next], progressPct, ready,
    measures: [
      { key: 'months', label: 'Months with us',    have: Math.floor(months), need: need.months },
      { key: 'orders', label: 'Orders',            have: orders,             need: need.orders },
      { key: 'crates', label: 'Crates bought',     have: crates,             need: need.crates },
    ],
  });
});

module.exports = router;
