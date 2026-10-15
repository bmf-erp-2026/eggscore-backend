const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth } = require('../auth.postgres');
const tb = require('../lib/tier-bars');

const router = express.Router();

// GET /patronage/:customerName (Oct 15 2026, Portal part payment, Stage 1; moved to the Trust Tier bars the same day)
//
// Read-only. Feeds the "Your patronage level" ticker on the customer portal: the customer's level (the Trust Tier
// the Owner has set for them) and how far they are toward the next one. Progress is measured on the SAME three things
// the Owner's Suggested Trust Tier uses (lib/tier-bars.js): the customer's Scorecard result, number of orders, and
// crates bought. The Scorecard figure itself is never shown to the customer: the portal gets a plain
// "payment and order record: on track / keep it steady" line instead.
//
// Deliberately NOT here: how much of an order's margin each level may defer, costs, margins, credit limits. The
// level only moves when the Owner changes it in the ERP; this route never changes anything, it only shows progress.
const LEVELS = tb.LEVELS;
const NAMES = tb.NAMES;

router.get('/:customerName', requireEitherAuth(), async (req, res) => {
  const name = String(req.params.customerName || '').trim();
  if(!name) return res.status(400).json({ error: 'customerName is required.' });
  const cust = await db.prepare('SELECT name, trust_tier, scorecard_score FROM customers WHERE name = ?').get(name);
  if(!cust) return res.status(404).json({ error: 'Customer not found.' });

  let level = String(cust.trust_tier || 'new').toLowerCase();
  if(!LEVELS.includes(level)) level = 'new';
  const idx = LEVELS.indexOf(level);

  if(idx === LEVELS.length - 1) {
    return res.json({ level, levelName: NAMES[level], top: true, next: null, nextName: null, progressPct: 100, ready: false, measures: [] });
  }

  // One row per invoice. The sales table held 219 doubled rows from 3 Sep 2026 (a rep's device re-sent other reps'
  // sales before the duplicate guard existed); counting rows would show a customer too many orders and crates.
  const row = await db.prepare(`
    WITH uniq AS (
      SELECT DISTINCT ON (COALESCE(invoice_ref, 'id-' || id::text)) crates
      FROM sales
      WHERE customer_name = ? AND COALESCE(fully_reversed, 0) = 0
      ORDER BY COALESCE(invoice_ref, 'id-' || id::text), id
    )
    SELECT COUNT(*)::int AS orders, COALESCE(SUM(crates), 0)::int AS crates FROM uniq`).get(cust.name);
  const orders = (row && row.orders) || 0;
  const crates = (row && row.crates) || 0;
  const score = cust.scorecard_score == null ? null : Number(cust.scorecard_score);

  const next = LEVELS[idx + 1];
  const need = (await tb.getBars())[next];
  const ratio = (have, want) => Math.max(0, Math.min(1, have / want));
  const scoreOk = score != null && score >= need.score;
  const rs = [score == null ? 0 : ratio(score, need.score), ratio(orders, need.orders), ratio(crates, need.crates)];
  const ready = scoreOk && orders >= need.orders && crates >= need.crates;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const progressPct = ready ? 100 : Math.min(99, Math.round(mean * 100));

  res.json({
    level, levelName: NAMES[level], top: false, next, nextName: NAMES[next], progressPct, ready,
    measures: [
      { key: 'orders', label: 'Orders',        have: orders, need: need.orders },
      { key: 'crates', label: 'Crates bought', have: crates, need: need.crates },
      { key: 'record', kind: 'status', label: 'Payment and order record', ok: scoreOk },
    ],
  });
});

module.exports = router;
