const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth, requireRole } = require('../auth.postgres');
const scope = require('../lib/rep-scope');

const router = express.Router();

// A customer's OWN shareable code (what they give a friend) — distinct
// from `referral` (how THEY were referred). Short and speakable over
// the phone, not the BEL-CID-timestamp scheme used for the CID itself.
function genReferralCode(name) {
  const letters = (name || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'EGGS';
  const digits = String(Math.floor(100 + Math.random() * 900));
  return `BEL-${letters}${digits}`;
}

// Oct 13 2026 — a rep (or a manager) may add a customer. A rep's new customer is tied to that rep straight away
// ("the rep who pitched them"); the Owner and a manager may name the rep, or leave the customer unowned.
router.post('/', requireSupabaseAuth(), requireRole('owner', 'manager', 'rep'), async (req, res) => {
  const { cid, name, location, contact, phone, type, creditLimit, referral, notes, trustTier, ownerRep } = req.body;

  if(!name || !location) {
    return res.status(400).json({ error: 'name and location are required.' });
  }

  const sc = await scope.scopeOf(req);
  if(!sc.all && !sc.rep) return res.status(403).json(scope.NOT_LINKED);
  // A rep may not set their own credit terms: those stay with the Owner.
  const isOwner = req.user.role === 'owner';
  const tie = sc.all ? (ownerRep || null) : sc.rep;

  const referralCode = genReferralCode(name);
  // trust_tier (Aug 22, Trust-Tiered Progressive Margin Financing) —
  // gates how much of an order's MARGIN this customer may defer,
  // separate from the loyalty tier. Defaults to 'new' (0% deferred,
  // cash-only) for any customer created without an explicit value —
  // never silently inherits more trust than they've earned.
  const info = await db.prepare(`
    INSERT INTO customers (cid, name, location, contact, phone, type, credit_limit, referral, notes, referral_code, trust_tier, owner_rep, owner_rep_set_by, owner_rep_set_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cid || null, name, location, contact || null, phone || null, type || null,
    isOwner ? (creditLimit || 0) : 0, referral || null, notes || null, referralCode, isOwner ? (trustTier || 'new') : 'new',
    tie, tie ? 'created by ' + (req.user.email || req.user.role) : null, tie ? new Date().toISOString() : null);

  res.status(201).json(await db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  // Oct 13 2026 — a rep sees only their own customers, plus customers nobody owns yet.
  const sc = await scope.scopeOf(req);
  const cl = scope.customerClause(sc, 'customers');
  res.json(await db.prepare(`SELECT * FROM customers WHERE ${cl.sql} ORDER BY created_at DESC`).all(...cl.params));
});

// ── Which rep owns which customer (Oct 13 2026) ─────────────────────────────
// Customers you have not tied to a rep yet, with the rep who made the FIRST sale to each (the usual "who
// pitched them" answer) as a suggestion. Owner only.
router.get('/rep-suggestions', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT c.id, c.name, c.location,
           (SELECT s.rep FROM sales s WHERE s.customer_name = c.name AND s.rep <> 'Direct' ORDER BY s.sale_date ASC, s.created_at ASC LIMIT 1) AS suggested_rep,
           (SELECT COUNT(*)::int FROM sales s WHERE s.customer_name = c.name) AS sales_count
    FROM customers c WHERE c.owner_rep IS NULL ORDER BY c.name ASC`).all();
  res.json(rows);
});

// Tie customers to reps. Body: { assignments: [{ id, rep }], reason }. Owner only. Every move is logged.
// rep = null/'' sets a customer back to "nobody's yet" (open to every rep).
// rep = '__hold__' parks the customer with the Owner (Oct 15 2026, for a rep who left): no rep sees it, and
// the Command Centre reminds the Owner until it is given to a rep.
const HOLD = '(Owner hold)';
router.post('/owner-rep', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const list = Array.isArray(req.body && req.body.assignments) ? req.body.assignments.slice(0, 500) : [];
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300) || 'Owner assignment';
  if(!list.length) return res.status(400).json({ error: 'Nothing to assign.' });
  const by = (req.user && req.user.email) || null;
  let done = 0; const skipped = [];
  for(const a of list) {
    const c = await db.prepare('SELECT id, name, owner_rep FROM customers WHERE id = ?').get(a.id);
    if(!c) { skipped.push({ id: a.id, why: 'Customer not found.' }); continue; }
    let target = null;
    if(a.rep === '__hold__') target = { name: HOLD };
    else if(a.rep) {
      target = await db.prepare("SELECT name FROM reps WHERE name = ? AND COALESCE(status,'active') <> 'inactive'").get(String(a.rep));
      if(!target) { skipped.push({ id: a.id, why: `"${a.rep}" is not an active rep.` }); continue; }
    }
    if((c.owner_rep || null) === (target ? target.name : null)) { skipped.push({ id: a.id, why: 'Already set.' }); continue; }
    await db.prepare('UPDATE customers SET owner_rep = ?, owner_rep_set_by = ?, owner_rep_set_at = now() WHERE id = ?').run(target ? target.name : null, by, c.id);
    await db.prepare(`INSERT INTO rep_handovers (kind, ref, subject, from_rep, to_rep, reason, by_email) VALUES ('customer', ?, ?, ?, ?, ?, ?)`)
      .run(c.name, c.name, c.owner_rep || null, target ? target.name : '(nobody)', reason, by);
    done++;
  }
  console.log(`[audit] Customer rep assignment by ${by}: ${done} changed, ${skipped.length} skipped`);
  res.json({ ok: true, changed: done, skipped });
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
const OWNER_ONLY_CUSTOMER_FIELDS = ['creditLimit', 'trustTier', 'loyaltyTier', 'shopVerified', 'shopNote', 'phoneVerified', 'phoneNote'];

router.patch('/:id', requireSupabaseAuth(), async (req, res) => {
  const { phone, location, contact, type, creditLimit, trustTier, loyaltyTier, referralCode, shopVerified, shopNote, phoneVerified, phoneNote } = req.body;

  if(req.user.role !== 'owner') {
    const attempted = OWNER_ONLY_CUSTOMER_FIELDS.filter(f => req.body[f] !== undefined);
    if(attempted.length > 0) {
      return res.status(403).json({ error: `Your role cannot update: ${attempted.join(', ')}.` });
    }
  }

  const existing = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Customer not found.' });
  // Oct 13 2026 — a rep may only edit a customer they may see (their own, or one nobody owns yet).
  const sc = await scope.scopeOf(req);
  if(!(await scope.canSeeCustomer(sc, existing.id))) return res.status(403).json(scope.NOT_YOURS);

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

  // Oct 14 2026 (queue item C) — credit-onboarding verification. Owner only (guarded above). Confirming needs
  // a written note of how it was checked; the server stamps who and when; undoing clears all three.
  const who = req.user.email || 'owner';
  for(const [flag, note, col] of [[shopVerified, shopNote, 'shop'], [phoneVerified, phoneNote, 'phone']]) {
    if(flag === undefined) continue;
    if(flag) {
      const n = String(note || '').trim();
      if(n.length < 3) return res.status(400).json({ error: 'Say how the ' + col + ' was checked (a few words) before confirming it.' });
      fields.push(`${col}_verified_at = now()`, `${col}_verified_by = ?`, `${col}_verified_note = ?`); values.push(who, n.slice(0, 300));
    } else {
      fields.push(`${col}_verified_at = NULL`, `${col}_verified_by = NULL`, `${col}_verified_note = NULL`);
    }
    console.log(`[audit] ${col} ${flag ? 'confirmed' : 'confirmation removed'} for customer ${existing.name} by ${who}`);
  }

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
