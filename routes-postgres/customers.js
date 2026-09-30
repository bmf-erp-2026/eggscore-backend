const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth, requireRole } = require('../auth.postgres');

const router = express.Router();

// A customer's OWN shareable code (what they give a friend) — distinct
// from `referral` (how THEY were referred). Short and speakable over
// the phone, not the BEL-CID-timestamp scheme used for the CID itself.
function genReferralCode(name) {
  const letters = (name || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'EGGS';
  const digits = String(Math.floor(100 + Math.random() * 900));
  return `BEL-${letters}${digits}`;
}

router.post('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { cid, name, location, contact, phone, type, creditLimit, referral, notes, trustTier } = req.body;

  if(!name || !location) {
    return res.status(400).json({ error: 'name and location are required.' });
  }

  const referralCode = genReferralCode(name);
  // trust_tier (Aug 22, Trust-Tiered Progressive Margin Financing) —
  // gates how much of an order's MARGIN this customer may defer,
  // separate from the loyalty tier. Defaults to 'new' (0% deferred,
  // cash-only) for any customer created without an explicit value —
  // never silently inherits more trust than they've earned.
  const info = await db.prepare(`
    INSERT INTO customers (cid, name, location, contact, phone, type, credit_limit, referral, notes, referral_code, trust_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cid || null, name, location, contact || null, phone || null, type || null,
    creditLimit || 0, referral || null, notes || null, referralCode, trustTier || 'new');

  res.status(201).json(await db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all());
});

// Was missing entirely — confirmEditContact() on the ERP side only ever
// saved to local browser storage, meaning contact-info edits never
// actually reached the backend, on top of the Type/Contact fields not
// being editable there at all until now.
//
// Field-level role split (Sep 1 2026, Sales Rep Access): this route
// bundles safe contact-info fields with finance-sensitive ones in one
// request, so it can't be gated at the whole-route level like most
// others. A rep may still fix a customer's phone/location/contact/type,
// or let referralCode auto-mint — but creditLimit/trustTier/loyaltyTier
// are owner-only. Deliberately rejects the WHOLE request with a clear
// error if a non-owner includes any restricted field, rather than
// silently applying only the allowed ones — a silent partial-apply here
// would mean a rep believes they changed a credit limit that quietly
// never took effect, discovered only much later.
const OWNER_ONLY_CUSTOMER_FIELDS = ['creditLimit', 'trustTier', 'loyaltyTier'];

router.patch('/:id', requireSupabaseAuth(), async (req, res) => {
  const { phone, location, contact, type, creditLimit, trustTier, loyaltyTier, referralCode } = req.body;

  if(req.user.role !== 'owner') {
    const attempted = OWNER_ONLY_CUSTOMER_FIELDS.filter(f => req.body[f] !== undefined);
    if(attempted.length > 0) {
      return res.status(403).json({ error: `Your role cannot update: ${attempted.join(', ')}.` });
    }
  }

  const existing = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Customer not found.' });

  const fields = [], values = [];
  if(phone !== undefined)      { fields.push('phone = ?');        values.push(phone); }
  if(location !== undefined)   { fields.push('location = ?');     values.push(location); }
  if(contact !== undefined)    { fields.push('contact = ?');      values.push(contact); }
  if(type !== undefined)       { fields.push('type = ?');         values.push(type); }
  if(creditLimit !== undefined){ fields.push('credit_limit = ?'); values.push(creditLimit); }
  // trust_tier — one of 'new'/'building'/'established'/'proven', set
  // manually from the ERP's Customer Scores table. No validation
  // against that list here, same permissiveness as the other free-text
  // fields above — the ERP's <select> is the real guard.
  if(trustTier !== undefined)  { fields.push('trust_tier = ?');   values.push(trustTier); }
  // loyalty_tier (Aug 22 fix) — this column existed but nothing ever
  // wrote to it; every row in production was stuck at its 'New'
  // default regardless of what a customer had actually earned. Set
  // via the ERP's local tier-clearance workflow (auto-downgrade or a
  // manually-cleared upgrade), same permissiveness as trust_tier above.
  if(loyaltyTier !== undefined){ fields.push('loyalty_tier = ?'); values.push(loyaltyTier); }
  // referral_code (Aug 25 fix) — same disease as trust_tier and
  // loyalty_tier before it: a real column that nothing ever wrote
  // back to from a client-generated value. Only ever set here when
  // getOrCreateReferralCode() genuinely has to mint a brand-new code
  // (nothing existed yet, anywhere) — never overwrites an existing one.
  if(referralCode !== undefined) { fields.push('referral_code = ?'); values.push(referralCode); }

  if(fields.length === 0) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.id);
  await db.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  res.json(await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

// ── Portal-facing lookup endpoints — Phase 2A ─────────────────────────
// These are deliberately narrow: only the fields a customer should see
// about themselves, never the full customer record (credit limit,
// internal notes, etc). The portal's API key is visible in its own
// client-side JS, so anything it can call is effectively public —
// these three routes are designed with that in mind.

// Sep 30 2026 — three more small, derived facts added on top of the
// original narrow set, so the portal's promoAppliesToCustomer() can
// finally check the "Wholesalers Only" / "Inactive (30+ days)" /
// "High-Volume (200+ crates/mo)" promo segments (previously a known,
// flagged gap — those segments applied to everyone because the portal
// had no way to know a customer's type or purchase history at all).
// Each one is computed server-side rather than handing over raw sales
// rows — `type` is the customer's own declared business type (same
// "Wholesaler"/"Depot"/etc. field the ERP already shows them), and the
// two crate/date figures are single aggregates, not a history dump —
// same "narrow, portal-facing" principle the rest of this section
// already follows.
const SEGMENT_FIELDS_SQL = `
    type,
    (SELECT COALESCE(SUM(s.crates), 0) FROM sales s
      WHERE s.customer_id = customers.id AND s.sale_date::date >= (CURRENT_DATE - INTERVAL '30 days')
    ) AS "recentCrates30d",
    (SELECT (CURRENT_DATE - MAX(s.sale_date::date)) FROM sales s
      WHERE s.customer_id = customers.id
    ) AS "daysSinceLastPurchase"`;

// Partial name/contact match, for lookupCustomer()'s as-you-type check.
router.get('/search', requireEitherAuth(), async (req, res) => {
  const q = (req.query.q || '').trim();
  if(q.length < 3) return res.json(null);
  const rows = await db.prepare(
    `SELECT name, cid, phone, location, referral_code AS "referralCode", loyalty_tier AS "loyalty",
    ${SEGMENT_FIELDS_SQL}
     FROM customers
     WHERE LOWER(name) LIKE ? OR LOWER(contact) LIKE ? LIMIT 1`
  ).all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
  res.json(rows[0] || null);
});

// Exact CID match, for lookupByCode().
router.get('/by-code', requireEitherAuth(), async (req, res) => {
  const code = (req.query.code || '').trim();
  if(!code) return res.json(null);
  const row = await db.prepare(
    `SELECT name, cid, phone, location, referral_code AS "referralCode", loyalty_tier AS "loyalty",
    ${SEGMENT_FIELDS_SQL}
     FROM customers WHERE cid = ?`
  ).get(code);
  res.json(row || null);
});

// Exact referral-code match, for resolveReferralCode(). Only the
// referring customer's name is returned — nothing else about them.
router.get('/by-referral', requireEitherAuth(), async (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if(!code) return res.json(null);
  const row = await db.prepare(`SELECT name, cid FROM customers WHERE referral_code = ?`).get(code);
  res.json(row ? { name: row.name, cid: row.cid } : null);
});

module.exports = router;
