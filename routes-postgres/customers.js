const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth } = require('../auth.postgres');

const router = express.Router();

// A customer's OWN shareable code (what they give a friend) — distinct
// from `referral` (how THEY were referred). Short and speakable over
// the phone, not the BEL-CID-timestamp scheme used for the CID itself.
function genReferralCode(name) {
  const letters = (name || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'EGGS';
  const digits = String(Math.floor(100 + Math.random() * 900));
  return `BEL-${letters}${digits}`;
}

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { cid, name, location, contact, phone, type, creditLimit, referral, notes } = req.body;

  if(!name || !location) {
    return res.status(400).json({ error: 'name and location are required.' });
  }

  const referralCode = genReferralCode(name);
  const info = await db.prepare(`
    INSERT INTO customers (cid, name, location, contact, phone, type, credit_limit, referral, notes, referral_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cid || null, name, location, contact || null, phone || null, type || null,
    creditLimit || 0, referral || null, notes || null, referralCode);

  res.status(201).json(await db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all());
});

// Was missing entirely — confirmEditContact() on the ERP side only ever
// saved to local browser storage, meaning contact-info edits never
// actually reached the backend, on top of the Type/Contact fields not
// being editable there at all until now.
router.patch('/:id', requireSupabaseAuth(), async (req, res) => {
  const { phone, location, contact, type, creditLimit } = req.body;
  const existing = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Customer not found.' });

  const fields = [], values = [];
  if(phone !== undefined)      { fields.push('phone = ?');        values.push(phone); }
  if(location !== undefined)   { fields.push('location = ?');     values.push(location); }
  if(contact !== undefined)    { fields.push('contact = ?');      values.push(contact); }
  if(type !== undefined)       { fields.push('type = ?');         values.push(type); }
  if(creditLimit !== undefined){ fields.push('credit_limit = ?'); values.push(creditLimit); }

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

// Partial name/contact match, for lookupCustomer()'s as-you-type check.
router.get('/search', requireEitherAuth(), async (req, res) => {
  const q = (req.query.q || '').trim();
  if(q.length < 3) return res.json(null);
  const rows = await db.prepare(
    `SELECT name, cid, phone, location, referral_code AS "referralCode" FROM customers
     WHERE LOWER(name) LIKE ? OR LOWER(contact) LIKE ? LIMIT 1`
  ).all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
  res.json(rows[0] || null);
});

// Exact CID match, for lookupByCode().
router.get('/by-code', requireEitherAuth(), async (req, res) => {
  const code = (req.query.code || '').trim();
  if(!code) return res.json(null);
  const row = await db.prepare(
    `SELECT name, cid, phone, location, referral_code AS "referralCode" FROM customers WHERE cid = ?`
  ).get(code);
  res.json(row || null);
});

// Exact referral-code match, for resolveReferralCode(). Only the
// referring customer's name is returned — nothing else about them.
router.get('/by-referral', requireEitherAuth(), async (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if(!code) return res.json(null);
  const row = await db.prepare(`SELECT name FROM customers WHERE referral_code = ?`).get(code);
  res.json(row ? { name: row.name } : null);
});

module.exports = router;
