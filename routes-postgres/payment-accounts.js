const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth, requireRole } = require('../auth.postgres');
const pc = require('../lib/portal-checks');
const payCode = require('../lib/pay-code');
const push = require('../lib/push');
const crypto = require('crypto');
const ownerPinLib = require('../lib/owner-pin');

const HOLD_HOURS = 24;
// An account customers may see and pay into: switched on, and past its waiting period.
const LIVE = "active = 1 AND (live_at IS NULL OR live_at <= now())";
const isLive = r => Number(r.active) === 1 && (!r.live_at || new Date(r.live_at).getTime() <= Date.now());

const { raiseAlert, who } = require('../lib/owner-pin');
const fmtAcct = r => `${r.bank} \u00b7 ${r.account_name} \u00b7 ${r.account_number}`;

// ── Owner PIN door (0.59) ────────────────────────────────────────────────────────────────────────────────────────────
// The Payment Accounts page and every change to the list need the Owner PIN on top of the Owner login, so a screen left
// open (idle lock failed) or a stolen login is still stopped at the door. The check is in lib/owner-pin.js: the PIN travels in
// the x-owner-pin header (or {pin} on /unlock) over HTTPS and is compared with the stored hash; it is never stored or logged.
// Three wrong PINs lock the door for 30 minutes and raise a red alert + phone push.
async function checkOwnerPin(req, res) {
  const r = await ownerPinLib.checkSecret(req, 'pin', req.headers['x-owner-pin'] || (req.body && req.body.pin), 'Payment Accounts');
  if(r.ok) return true;
  res.status(r.status).json(r.body); return false;
}
const ownerPin = async (req, res, next) => { try { if(await checkOwnerPin(req, res)) next(); } catch(e) { next(e); } };

const router = express.Router();

// The official EggScore bank accounts (Oct 16 2026, 0.55).
//
//   GET   /payment-accounts           portal or staff: the ACTIVE accounts (what a customer may pay into)
//   POST  /payment-accounts/forgot, /forgot/confirm   Owner only, no PIN: email a one-time code, then set a new Owner PIN (0.60)
//   POST  /payment-accounts/unlock    Owner only: the PIN door (0.59). /all, POST and PATCH also need the Owner PIN (x-owner-pin)
//   GET   /payment-accounts/all       Owner only (+PIN): every account including retired ones
//   POST  /payment-accounts           Owner only: add an account
//   PATCH /payment-accounts/:id       Owner only: retire / reactivate / fix the bank, name or label
//   POST  /payment-accounts/verify    portal or staff: "is this account number ours?" and, if a reference + Pay Code are
//                                     given, "does the code match that reference?"
//   GET   /payment-accounts/code/:ref staff only: the Pay Code for an order reference or invoice number
//   GET   /payment-accounts/alerts    Owner only: red alerts not yet acknowledged
//   POST  /payment-accounts/alerts/ack Owner only: acknowledge one alert ({id}) or all of them ({all:true})
//
// 0.56 (Oct 17 2026): a newly added account waits HOLD_HOURS before customers can see it (the Owner may release it early),
// every change to the list and every check of a number that is not ours raises a red alert (Command Center + phone push),
// and a customer's successful check of their own order's account is remembered so staff can see who has not checked.
//
// An account NUMBER is never edited: a wrong number is retired and the right one added, so the history is honest.

const shape = r => ({ id: r.id, bank: r.bank, accountName: r.account_name, accountNumber: r.account_number, label: r.label || null });
const digits = s => String(s == null ? '' : s).replace(/\D/g, '');

router.get('/', requireEitherAuth(), async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM payment_accounts WHERE ${LIVE} ORDER BY id`).all();
  res.json({ accounts: rows.map(shape) });
});

router.get('/all', requireSupabaseAuth(), requireRole('owner'), ownerPin, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM payment_accounts ORDER BY active DESC, id').all();
  res.json({ accounts: rows.map(r => ({ ...shape(r), active: Number(r.active) === 1, createdAt: r.created_at, retiredAt: r.retired_at, createdBy: r.created_by, liveAt: r.live_at || null, pending: Number(r.active) === 1 && !isLive(r) })) });
});

router.post('/', requireSupabaseAuth(), requireRole('owner'), ownerPin, async (req, res) => {
  const bank = String(req.body.bank || '').trim().slice(0, 60);
  const accountName = String(req.body.accountName || '').trim().slice(0, 80);
  const accountNumber = digits(req.body.accountNumber);
  const label = String(req.body.label || '').trim().slice(0, 60) || null;
  if(!bank) return res.status(400).json({ error: 'Enter the bank name.' });
  if(!accountName) return res.status(400).json({ error: 'Enter the account name exactly as the bank shows it.' });
  if(accountNumber.length !== 10) return res.status(400).json({ error: 'A Nigerian bank account number has 10 digits.' });
  const dup = await db.prepare('SELECT id, active FROM payment_accounts WHERE account_number = ?').get(accountNumber);
  if(dup) return res.status(409).json({ error: Number(dup.active) === 1 ? 'That account number is already on the list.' : 'That account number is on the list but retired. Reactivate it instead.' });
  const info = await db.prepare(`INSERT INTO payment_accounts (bank, account_name, account_number, label, created_by, live_at) VALUES (?, ?, ?, ?, ?, now() + interval '${HOLD_HOURS} hours')`)
    .run(bank, accountName, accountNumber, label, (req.user && req.user.email) || null);
  const row = await db.prepare('SELECT * FROM payment_accounts WHERE id = ?').get(info.lastInsertRowid);
  await pc.logServerEvent({ entryId: `srv-payacct-add-${row.id}`, category: 'security', level: 'info',
    message: `Official payment account added: ${bank} · ${accountName} · ${accountNumber}. Customers cannot see it for ${HOLD_HOURS} hours unless it is released.`, detail: { id: row.id, by: (req.user && req.user.email) || null } });
  await raiseAlert({ kind: 'account_added', key: `acct-add-${row.id}`,
    message: `${who(req)} added an official payment account: ${fmtAcct(row)}. Customers will see it in ${HOLD_HOURS} hours. If this was not you, retire it now and change your password.`,
    detail: { id: row.id, by: who(req) }, pushTitle: '\u{1F6A8} Payment account added', pushBody: `${fmtAcct(row)} was added by ${who(req)}. Not you? Retire it now.` });
  res.status(201).json({ ...shape(row), active: true, pending: true, liveAt: row.live_at });
});

router.patch('/:id', requireSupabaseAuth(), requireRole('owner'), ownerPin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM payment_accounts WHERE id = ?').get(req.params.id);
  if(!row) return res.status(404).json({ error: 'Account not found.' });
  const sets = [], vals = [], changed = [];
  if(req.body.bank !== undefined)        { const v = String(req.body.bank).trim().slice(0, 60); if(!v) return res.status(400).json({ error: 'Bank name cannot be empty.' }); if(v !== row.bank) changed.push('bank'); sets.push('bank = ?'); vals.push(v); }
  if(req.body.accountName !== undefined) { const v = String(req.body.accountName).trim().slice(0, 80); if(!v) return res.status(400).json({ error: 'Account name cannot be empty.' }); if(v !== row.account_name) changed.push('account name'); sets.push('account_name = ?'); vals.push(v); }
  if(req.body.label !== undefined)       { sets.push('label = ?'); vals.push(String(req.body.label).trim().slice(0, 60) || null); }
  let kind = null;
  if(req.body.active !== undefined) {
    const on = req.body.active === true || req.body.active === 1 || req.body.active === '1';
    if(on !== (Number(row.active) === 1)) kind = on ? 'on' : 'off';
    sets.push('active = ?'); vals.push(on ? 1 : 0);
    sets.push(on ? 'retired_at = NULL' : 'retired_at = now()');
  }
  // Release a waiting account early (it still raises an alert, so the Owner's own phone shows it happened).
  const release = req.body.release === true && !isLive(row) && Number(row.active) === 1;
  if(release) sets.push('live_at = NULL');
  if(!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  await db.prepare(`UPDATE payment_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
  const after = await db.prepare('SELECT * FROM payment_accounts WHERE id = ?').get(req.params.id);
  const stamp = Date.now();
  if(kind) {
    const word = kind === 'on' ? 'reactivated' : 'retired';
    await pc.logServerEvent({ entryId: `srv-payacct-${kind}-${after.id}-${stamp}`, category: 'security', level: 'info',
      message: `Official payment account ${word}: ${fmtAcct(after)}`, detail: { id: after.id, by: who(req) } });
    await raiseAlert({ kind: 'account_' + word, key: `acct-${kind}-${after.id}-${stamp}`,
      message: `${who(req)} ${word} an official payment account: ${fmtAcct(after)}.${kind === 'on' ? ' Customers can see it again.' : ' Customers are now told it is no longer ours.'} If this was not you, change your password now.`,
      detail: { id: after.id, by: who(req) }, pushTitle: '\u{1F6A8} Payment account ' + word, pushBody: `${fmtAcct(after)} was ${word} by ${who(req)}.` });
  }
  if(release) {
    await pc.logServerEvent({ entryId: `srv-payacct-release-${after.id}-${stamp}`, category: 'security', level: 'info',
      message: `Official payment account released early: ${fmtAcct(after)}`, detail: { id: after.id, by: who(req) } });
    await raiseAlert({ kind: 'account_released', key: `acct-release-${after.id}-${stamp}`,
      message: `${who(req)} released a waiting payment account early: ${fmtAcct(after)}. Customers can see it now.`,
      detail: { id: after.id, by: who(req) }, pushTitle: '\u{1F6A8} Payment account released', pushBody: `${fmtAcct(after)} was released by ${who(req)}. Customers can see it now.` });
  }
  if(changed.length) {
    await pc.logServerEvent({ entryId: `srv-payacct-edit-${after.id}-${stamp}`, category: 'security', level: 'info',
      message: `Official payment account edited (${changed.join(', ')}): now ${fmtAcct(after)}`, detail: { id: after.id, by: who(req) } });
    await raiseAlert({ kind: 'account_edited', key: `acct-edit-${after.id}-${stamp}`,
      message: `${who(req)} changed the ${changed.join(' and ')} of an official payment account: now ${fmtAcct(after)}.`,
      detail: { id: after.id, by: who(req) }, pushTitle: '\u{1F6A8} Payment account edited', pushBody: `${fmtAcct(after)} was edited by ${who(req)}.` });
  }
  res.json({ ...shape(after), active: Number(after.active) === 1, pending: Number(after.active) === 1 && !isLive(after), liveAt: after.live_at || null });
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

// The page's door: the ERP calls this with the typed PIN before it shows the Payment Accounts page. Wrong and right tries are
// counted here, so the lock and the alert do not depend on the browser.
router.post('/unlock', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  if(!(await checkOwnerPin(req, res))) return;
  await pc.logServerEvent({ entryId: `srv-payacct-unlock-${Date.now()}`, category: 'security', level: 'info',
    message: 'Payment Accounts opened with the Owner PIN', detail: { by: who(req) } });
  res.json({ ok: true });
});

// ── "Forgot my PIN" by email (0.60) ──────────────────────────────────────────────────────────────────────────────────
// The back channel for a forgotten Owner PIN. It works while the door is locked, because it asks for no PIN: it asks for a
// 6-digit code that is emailed to the Owner's login email (Resend, key in the RESEND_API_KEY variable). The code lasts 15
// minutes, allows 5 tries, and only its hash is kept. A correct code sets a NEW Owner PIN (the same PIN the ERP's other PIN
// boxes use) and lifts any lock. Asking for a code and using one both raise a red alert + phone push.
const RESET_KEY = 'owner_pin_reset';
const RESET_MIN = 15, RESET_TRIES = 5;
const maskEmail = e => { const [u, d] = String(e || '').split('@'); return u ? (u.slice(0, 1) + '***' + (u.length > 3 ? u.slice(-1) : '') + '@' + (d || '')) : ''; };
const resetHash = c => ownerPinLib.hashSecret('reset:' + c);
async function getReset() { try { const r = await db.prepare('SELECT value FROM settings WHERE key = ?').get(RESET_KEY); return r ? JSON.parse(r.value) : null; } catch(e) { return null; } }
async function putReset(obj, by) {
  if(obj === null) { await db.prepare('DELETE FROM settings WHERE key = ?').run(RESET_KEY); return; }
  await db.prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()")
    .run(RESET_KEY, JSON.stringify(obj), by || null);
}
const WEAK = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '3210', '1212', '2580', '1122', '12345', '54321', '123456', '654321', '1234567', '12345678', '00000000']);
function weakPin(p) { return WEAK.has(p) || /^(.)\1+$/.test(p); }

router.post('/forgot', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const email = (req.user && req.user.email) || '';
  if(!email) return res.status(400).json({ error: 'Your login has no email address to send a code to.' });
  const key = process.env.RESEND_API_KEY;
  if(!key) return res.status(503).json({ error: 'Email codes are not switched on yet (the RESEND_API_KEY is not set in Railway).' });
  const prev = await getReset(); const now = Date.now();
  if(prev && prev.sentAt && now - prev.sentAt < 60 * 1000) return res.status(429).json({ error: 'A code was just sent. Wait a minute before asking for another.' });
  const hourStart = prev && prev.hourStart && now - prev.hourStart < 3600 * 1000 ? prev.hourStart : now;
  const count = hourStart === (prev && prev.hourStart) ? (prev.count || 0) : 0;
  if(count >= 3) return res.status(429).json({ error: 'Three codes have been sent in the last hour. Try again later.' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const body = {
    from: process.env.EMAIL_FROM || 'EggScore Security <onboarding@resend.dev>', to: [email],
    subject: 'Your EggScore Owner PIN code',
    text: `Your EggScore code is ${code}\n\nIt works for ${RESET_MIN} minutes and lets you choose a new Owner PIN.\nIf you did not ask for this, do not share it, and change your EggScore password now.`,
    html: `<p>Your EggScore code is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>It works for ${RESET_MIN} minutes and lets you choose a new Owner PIN.</p><p>If you did not ask for this, do not share it, and change your EggScore password now.</p>`
  };
  let ok = false, status = 0;
  try {
    const r = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    ok = r.ok; status = r.status;
  } catch(e) { status = 0; }
  if(!ok) {
    await pc.logServerEvent({ entryId: `srv-ownerpin-mailfail-${now}`, category: 'security', level: 'warn', message: `Owner PIN code email failed (status ${status})`, detail: { by: who(req) } });
    return res.status(502).json({ error: status === 403 ? 'The email service refused this address. With the free test sender, the email must be the one you signed up to Resend with.' : 'Could not send the email. Try again in a minute.' });
  }
  await putReset({ hash: resetHash(code), exp: now + RESET_MIN * 60 * 1000, tries: 0, sentAt: now, hourStart, count: count + 1, email }, email);
  await pc.logServerEvent({ entryId: `srv-ownerpin-mail-${now}`, category: 'security', level: 'info', message: 'An Owner PIN code was emailed', detail: { by: who(req), to: maskEmail(email) } });
  await raiseAlert({ kind: 'pin_reset_requested', key: `pinreset-req-${now}`,
    message: `An Owner PIN code was emailed to ${maskEmail(email)} (asked for by ${who(req)}). If this was not you, change your password now.`,
    detail: { by: who(req) }, pushTitle: '\u{1F6A8} Owner PIN code requested', pushBody: `A PIN code was emailed to ${maskEmail(email)}. Not you? Change your password now.` });
  res.json({ ok: true, sentTo: maskEmail(email), minutes: RESET_MIN });
});

router.post('/forgot/confirm', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
  const newPin = String((req.body && req.body.newPin) || '');
  if(code.length !== 6) return res.status(400).json({ error: 'Type the 6-digit code from the email.' });
  if(newPin.length < 4 || newPin.length > 8) return res.status(400).json({ error: 'The new PIN must be 4 to 8 characters.' });
  if(weakPin(newPin)) return res.status(400).json({ error: 'That PIN is too easy to guess (like 1234 or 0000). Choose another.' });
  const row = await getReset();
  if(!row || !row.exp || Date.now() > row.exp) { if(row) await putReset(null); return res.status(400).json({ error: 'That code has expired or was never sent. Ask for a new one.' }); }
  if(!ownerPinLib.sameHex(resetHash(code), row.hash)) {
    row.tries = (row.tries || 0) + 1;
    await pc.logServerEvent({ entryId: `srv-ownerpin-badcode-${Date.now()}`, category: 'security', level: 'warn', message: `Wrong emailed PIN code typed (${row.tries} of ${RESET_TRIES})`, detail: { by: who(req) } });
    if(row.tries >= RESET_TRIES) {
      await putReset(null);
      await raiseAlert({ kind: 'pin_reset_failed', key: `pinreset-fail-${Date.now()}`,
        message: `The emailed Owner PIN code was typed wrong ${RESET_TRIES} times (signed in as ${who(req)}). The code was cancelled. If this was not you, change your password now.`,
        detail: { by: who(req) }, pushTitle: '\u{1F6A8} Wrong PIN code typed', pushBody: `${RESET_TRIES} wrong emailed-code tries (${who(req)}). Code cancelled.` });
      return res.status(429).json({ error: 'Too many wrong codes. That code is cancelled. Ask for a new one.' });
    }
    await putReset(row, who(req));
    return res.status(401).json({ error: `Wrong code. ${RESET_TRIES - row.tries} try(s) left.` });
  }
  const stored = (await ownerPinLib.getStored()) || {};
  const next = Object.assign({}, stored, { hash: ownerPinLib.hashSecret(newPin), setAt: new Date().toISOString(), lockoutUntil: null });
  await db.prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('owner_pin', ?, ?, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()")
    .run(JSON.stringify(next), who(req));
  await putReset(null); ownerPinLib.clearLock();
  await pc.logServerEvent({ entryId: `srv-ownerpin-reset-${Date.now()}`, category: 'security', level: 'warn', message: 'Owner PIN changed with an emailed code', detail: { by: who(req) } });
  await raiseAlert({ kind: 'pin_reset_done', key: `pinreset-done-${Date.now()}`,
    message: `The Owner PIN was changed with an emailed code (signed in as ${who(req)}). If this was not you, change your password now.`,
    detail: { by: who(req) }, pushTitle: '\u{1F6A8} Owner PIN changed', pushBody: `The Owner PIN was changed by ${who(req)} using an emailed code. Not you? Change your password now.` });
  res.json({ ok: true });
});

router.post('/verify', requireEitherAuth(), async (req, res) => {
  const caller = String((req.headers['x-forwarded-for'] || req.ip || 'x')).split(',')[0].trim();
  if(tooMany(caller, 30, 60000, hits)) return res.status(429).json({ error: 'Too many checks. Please wait a minute and try again.' });
  note(caller, hits);
  const number = digits(req.body.accountNumber);
  if(number.length !== 10) return res.status(400).json({ error: 'Type the 10-digit account number.' });
  const acct = await db.prepare('SELECT * FROM payment_accounts WHERE account_number = ?').get(number);
  const official = !!acct && isLive(acct);
  const pending = !!acct && Number(acct.active) === 1 && !isLive(acct);
  const retired = !!acct && Number(acct.active) !== 1;
  const out = { official, retired, pending };
  if(official) { out.bank = acct.bank; out.accountName = acct.account_name; }
  const ref = payCode.normRef(req.body.ref), code = payCode.cleanCode(req.body.code);
  out.codeChecked = false; out.codeValid = null;
  if(ref && code) {
    if(tooMany(ref, 10, 3600000, badCodes)) return res.status(429).json({ error: 'Too many wrong codes for that reference. Please contact EggScore on WhatsApp.', locked: true });
    out.codeChecked = true;
    out.codeValid = await payCode.codeMatches(ref, code);
    if(!out.codeValid) note(ref, badCodes);
  }
  // The customer checked this order's account on the real page: remember it, so staff can see who has not.
  if(official && ref && out.codeValid) {
    try { await db.prepare('INSERT INTO payment_checks (ref) VALUES (?) ON CONFLICT (ref) DO UPDATE SET checked_at = now(), checks = payment_checks.checks + 1 RETURNING ref').run(ref); }
    catch(e) { console.warn('[payment-accounts] could not record check:', e.message); }
  }
  // A number that is NOT ours is worth the Owner knowing about: a customer was sent it by someone.
  // (A number the Owner added a few hours ago and is still waiting to go live is not a stranger: no alarm.)
  if(!official && !pending) {
    const day = new Date().toISOString().slice(0, 10);
    await pc.logServerEvent({ entryId: `srv-notours-${number}-${day}`, category: 'security', level: 'warn',
      message: `A customer checked account ${number} and it is NOT an EggScore account${retired ? ' (it was once, now retired)' : ''}. Someone may be sending customers a false account.`,
      detail: { number, retired, ref: ref || null } });
    await raiseAlert({ kind: 'stranger', key: `notours-${number}-${day}`,
      message: `A customer checked account ${number} and it is NOT an EggScore account${retired ? ' (it was once, now retired)' : ''}. Someone may be sending customers a false account${ref ? ' (order ' + ref + ')' : ''}.`,
      detail: { number, retired, ref: ref || null }, pushTitle: '\u{1F6A8} A customer was sent a false account', pushBody: `Account ${number} is NOT ours. A customer just checked it${ref ? ' for order ' + ref : ''}.` });
  }
  res.json(out);
});

router.get('/alerts', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const rows = await db.prepare('SELECT id, kind, message, created_at FROM security_alerts WHERE acked_at IS NULL ORDER BY id DESC LIMIT 20').all();
  const n = await db.prepare('SELECT COUNT(*) AS n FROM security_alerts WHERE acked_at IS NULL').get();
  res.json({ count: Number(n && n.n) || 0, alerts: rows.map(r => ({ id: r.id, kind: r.kind, message: r.message, at: r.created_at })) });
});

router.post('/alerts/ack', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  if(req.body.all === true) await db.prepare('UPDATE security_alerts SET acked_at = now(), acked_by = ? WHERE acked_at IS NULL').run(who(req));
  else if(Number.isInteger(Number(req.body.id))) await db.prepare('UPDATE security_alerts SET acked_at = now(), acked_by = ? WHERE id = ? AND acked_at IS NULL').run(who(req), Number(req.body.id));
  else return res.status(400).json({ error: 'Say which alert.' });
  const n = await db.prepare('SELECT COUNT(*) AS n FROM security_alerts WHERE acked_at IS NULL').get();
  res.json({ ok: true, count: Number(n && n.n) || 0 });
});

router.get('/code/:ref', requireSupabaseAuth(), async (req, res) => {
  const code = await payCode.payCodeFor(req.params.ref);
  if(!code) return res.status(400).json({ error: 'Reference needed.' });
  res.json({ ref: payCode.normRef(req.params.ref), code });
});

module.exports = router;
