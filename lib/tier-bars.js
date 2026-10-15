// Trust Tier bars (Oct 15 2026): what a customer needs to be SUGGESTED a level. One place, used by both the Owner's
// Suggested Trust Tier column (routes-postgres/customers.js) and the customer portal ticker (routes-postgres/patronage.js),
// so the two can never disagree.
//
// The bars were set from the Owner's own grading of real customers (lowest customer he graded at each level):
//   Proven      Mile 12 Wholesaler: score 45, 10 orders, 1,175 crates
//   Established Obrikom Farms: 5 orders, 772 crates; Claire Egg Hub: score 61, 650 crates
// Months of trading is deliberately NOT a bar (the business is about 3 months old). Orders are counted one per invoice.
// The Owner can override any figure by saving a setting called trust_tier_bars (same shape); a missing or broken value
// falls back to these.
const pc = require('./portal-checks');

const LEVELS = ['new', 'building', 'established', 'proven'];
const NAMES = { new: 'New', building: 'Building', established: 'Established', proven: 'Proven' };

const DEFAULTS = {
  building:    { score: 40, orders: 5,  crates: 150 },
  established: { score: 50, orders: 5,  crates: 600 },
  proven:      { score: 45, orders: 10, crates: 1100 },
};

const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

async function getBars() {
  const saved = await pc.getSettingJson('trust_tier_bars', {});
  const out = {};
  Object.keys(DEFAULTS).forEach(level => {
    const s = (saved && saved[level]) || {}, d = DEFAULTS[level];
    out[level] = { score: num(s.score) || d.score, orders: num(s.orders) || d.orders, crates: num(s.crates) || d.crates };
  });
  return out;
}

// The highest level whose three bars are all met. A customer with no score yet cannot be suggested anything above New.
function levelFor(bars, { score, orders, crates }) {
  if(score == null) return 'new';
  for(let i = LEVELS.length - 1; i >= 1; i--) {
    const b = bars[LEVELS[i]];
    if(score >= b.score && orders >= b.orders && crates >= b.crates) return LEVELS[i];
  }
  return 'new';
}

// One row per invoice: the sales table can hold the same invoice twice (the doubled rows of 3 Sep 2026), so count
// distinct invoices, not rows. Used for one customer (name given) or for every customer (name omitted).
const UNIQ_SQL = `
  SELECT DISTINCT ON (customer_name, COALESCE(invoice_ref, 'id-' || id::text)) customer_name, crates
  FROM sales
  WHERE COALESCE(fully_reversed, 0) = 0
  ORDER BY customer_name, COALESCE(invoice_ref, 'id-' || id::text), id`;

module.exports = { LEVELS, NAMES, DEFAULTS, getBars, levelFor, UNIQ_SQL };
