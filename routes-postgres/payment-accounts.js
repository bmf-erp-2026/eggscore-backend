const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth, requireRole } = require('../auth.postgres');
const pc = require('../lib/portal-checks');
const payCode = require('../lib/pay-code');

const router = express.Router();

// The official EggScore bank accounts (Oct 16 2026, 0.55).
//
//   GET   /payment-accounts           portal or staff: the ACTIVE accounts (what a customer may pay into)
//   GET   /payment-accounts/all       Owner only: every account including retired ones
//   POST  /payment-accounts           Owner only: add an account
//   PATCH /payment-accounts/:id       Owner only: retire / reactivate / fix the bank, name or label
//   POST  /payment-accounts/verify    portal or staff: "is this account number ours?" and, if a reference + Pay Code are
//                                     given, "does the code match that reference?"
//   GET   /payment-accounts/code/:ref staff only: the Pay Code for an order reference or invoice number
//
// An account NUMBER is never edited: a wrong number is retired and the right one added, so the history is honest.

const shape = r => ({ id: r.id, bank: r.bank, accountName: r.account_name, accountNumber: r.account_number, label: r.label || null });
const digits = s => String(s == null ? '' : s).replace(/\D/g, '');

router.get('/', requireEitherAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM payment_accounts WHERE active = 1 ORDER BY id').all();
  res.json({ accounts: rows.map(shape) });
});

router.get('/all', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM payment_accounts ORDER BY active DESC, id').all();
  res.json({ accounts: rows.map(r => ({ ...shape(r), active: Number(r.active) === 1, createdAt: r.created_at, retiredAt: r.retired_at, createdBy: r.created_by })) });
});

router.post('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const bank = String(req.body.bank || '').trim().slice(0, 60);
  const accountName = String(req.body.accountName || '').trim().slice(0, 80);
  const accountNumber = digits(req.body.accountNumber);
  const label = String(req.body.label || '').trim().slice(0, 60) || null;
  if(!bank) return res.status(400).json({ error: 'Enter the bank name.' });
  if(!accountName) return res.status(400).json({ error: 'Enter the account name exactly as the bank shows it.' });
  if(accountNumber.length !== 10) return res.status(400).json({ error: 'A Nigerian bank account number has 10 digits.' });
  const dup = await db.prepare('SELECT id, active FROM payment_accounts WHERE account_number = ?').get(accountNumber);
  if(dup) return res.status(409).json({ error: Number(dup.active) === 1 ? 'That account number is already on the list.' : 'That account number is on the list but retired. Reactivate it instead.' });
  const info = await db.prepare('INSERT INTO payment_accounts (bank, account_name, account_number, label, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(bank, accountName, accountNumber, label, (req.user && req.user.email) || null);
  const row = await db.prepare('SELECT * FROM payment_accounts WHERE id = ?').get(info.lastInsertRowid);
  await pc.logServerEvent({ entryId: `srv-payacct-add-${row.id}`, category: 'security', level: 'info',
    message: `Official payment account added: ${bank} · ${accountName} · ${accountNumber}`, detail: { id: row.id, by: (req.user && req.user.email) || null } });
  res.status(201).json({ ...shape(row), active: true });
});

router.patch('/:id', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM payment_accounts WHERE id = ?').get(req.params.id);
  if(!row) return res.status(404).json({ error: 'Account not found.' });
  const sets = [], vals = [];
  if(req.body.bank !== undefined)        { const v = String(req.body.bank).trim().slice(0, 60); if(!v) return res.status(400).json({ error: 'Bank name cannot be empty.' }); sets.push('bank = ?'); vals.push(v); }
  if(req.body.accountName !== undefined) { const v = String(req.body.accountName).trim().slice(0, 80); if(!v) return res.status(400).json({ error: 'Account name cannot be empty.' }); sets.push('account_name = ?'); vals.push(v); }
  if(req.body.label !== undefined)       { sets.push('label = ?'); vals.push(String(req.body.label).trim().slice(0, 60) || null); }
  if(req.body.active !== undefined) {
    const on = req.body.active === true || req.body.active === 1 || req.body.active === '1';
    sets.push('active = ?'); vals.push(on ? 1 : 0);
    sets.push(on ? 'retired_at = NULL' : 'retired_at = now()');
  }
  if(!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  await db.prepare(`UPDATE payment_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
  const after = await db.prepare('SELECT * FROM payment_accounts WHERE id = ?').get(req.params.id);
  if(req.body.active !== undefined) {
    await pc.logServerEvent({ entryId: `srv-payacct-${Number(after.active) === 1 ? 'on' : 'off'}-${after.id}-${Date.now()}`, category: 'security', level: 'info',
      message: `Official payment account ${Number(after.active) === 1 ? 'reactivated' : 'retired'}: ${after.bank} · ${after.account_name} · ${after.account_number}`,
      detail: { id: after.id, by: (req.user && req.user.email) || null } });
  }
  res.json({ ...shape(after), active: Number(after.active) === 1 });
});

// ── Verify: light protection against guessing. Per caller 30 checks a minute, and per reference 10 wrong codes an hour. ──
const hits = new Map(), badCodes = new Map();
function tooMany(key, max, windowMs, store) {
  const now = Date.now(), arr = (store.get(key) || []).filter(t => now - t < windowMs);
  store.set(key, arr);
  return arr.length >= max;
}
function note(key, store) { const a = store.get(key) || []; a.push(Date.now()); store.set(key, a); }
setInterval(() => { const now = Date.now(); for(const [k, a] of hits) if(!a.some(t => now - t < 60000)) hits.delete(k); for(const [k, a] of badCodes) if(!a.some(t => now - t < 3600000)) badCodes.delete(k); }, 600000).unref();

router.post('/verify', requireEitherAuth(), async (req, res) => {
  const caller = String((req.headers['x-forwarded-for'] || req.ip || 'x')).split(',')[0].trim();
  if(tooMany(caller, 30, 60000, hits)) return res.status(429).json({ error: 'Too many checks. Please wait a minute and try again.' });
  note(caller, hits);
  const number = digits(req.body.accountNumber);
  if(number.length !== 10) return res.status(400).json({ error: 'Type the 10-digit account number.' });
  const acct = await db.prepare('SELECT * FROM payment_accounts WHERE account_number = ?').get(number);
  const official = !!acct && Number(acct.active) === 1;
  const retired = !!acct && Number(acct.active) !== 1;
  const out = { official, retired };
  if(official) { out.bank = acct.bank; out.accountName = acct.account_name; }
  const ref = payCode.normRef(req.body.ref), code = payCode.cleanCode(req.body.code);
  out.codeChecked = false; out.codeValid = null;
  if(ref && code) {
    if(tooMany(ref, 10, 3600000, badCodes)) return res.status(429).json({ error: 'Too many wrong codes for that reference. Please contact EggScore on WhatsApp.', locked: true });
    out.codeChecked = true;
    out.codeValid = await payCode.codeMatches(ref, code);
    if(!out.codeValid) note(ref, badCodes);
  }
  // A number that is NOT ours is worth the Owner knowing about: a customer was sent it by someone.
  if(!official) {
    const day = new Date().toISOString().slice(0, 10);
    await pc.logServerEvent({ entryId: `srv-notours-${number}-${day}`, category: 'security', level: 'warn',
      message: `A customer checked account ${number} and it is NOT an EggScore account${retired ? ' (it was once, now retired)' : ''}. Someone may be sending customers a false account.`,
      detail: { number, retired, ref: ref || null } });
  }
  res.json(out);
});

router.get('/code/:ref', requireSupabaseAuth(), async (req, res) => {
  const code = await payCode.payCodeFor(req.params.ref);
  if(!code) return res.status(400).json({ error: 'Reference needed.' });
  res.json({ ref: payCode.normRef(req.params.ref), code });
});

module.exports = router;
