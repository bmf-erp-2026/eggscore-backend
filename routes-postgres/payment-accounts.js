const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth, requireRole } = require('../auth.postgres');
const pc = require('../lib/portal-checks');
const payCode = require('../lib/pay-code');
const push = require('../lib/push');
const crypto = require('crypto');

const HOLD_HOURS = 24;
// An account customers may see and pay into: switched on, and past its waiting period.
const LIVE = "active = 1 AND (live_at IS NULL OR live_at <= now())";
const isLive = r => Number(r.active) === 1 && (!r.live_at || new Date(r.live_at).getTime() <= Date.now());

// A red alert the Owner must acknowledge. One per dedupe key (so the same stranger number on the same day is one alert),
// and a phone push goes out the moment a NEW one is raised. Never throws into the caller.
async function raiseAlert({ kind, key, message, detail, pushTitle, pushBody }) {
  try {
    const info = await db.prepare('INSERT INTO security_alerts (kind, dedupe_key, message, detail) VALUES (?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING')
      .run(kind, key, message, JSON.stringify(detail || null));
    if(info && info.changes) {
      push.notifyOwners({ title: pushTitle || '\u{1F6A8} EggScore security alert', body: pushBody || message, url: '/famad-erp.html', tag: 'secalert-' + key, kind: 'security_alert' })
        .catch(e => console.error('[payment-accounts] alert push failed:', e.message));
    }
  } catch(e) { console.warn('[payment-accounts] could not raise alert:', e.message); }
}
const who = req => (req.user && req.user.email) || 'someone';
const fmtAcct = r => `${r.bank} \u00b7 ${r.account_name} \u00b7 ${r.account_number}`;

// ── Owner PIN door (0.59) ────────────────────────────────────────────────────────────────────────────────────────────
// The Payment Accounts page and every change to the list need the Owner PIN on top of the Owner login, so a screen left
// open (idle lock failed) or a stolen login is still stopped at the door. The PIN is checked HERE, on the server, against
// the same hash the ERP's other PIN boxes use (settings key owner_pin, SHA-256 of the PIN + the app's salt). The PIN travels
// in the x-owner-pin header (or {pin} on /unlock) over HTTPS, is never stored or logged, and the stored hash is never sent
// back. Three wrong PINs lock the door for 30 minutes and raise a red alert + phone push. The counter lives in memory, so a
// server restart clears it; that is the one soft edge, and the alert has already gone out by then.
const PIN_SALT = 'bel_eggscore_salt_2026';
const PIN_TRIES = 3, PIN_LOCK_MS = 30 * 60 * 1000;
const pinDoor = { fails: 0, lockedUntil: 0 };
const pinMins = () => Math.max(1, Math.ceil((pinDoor.lockedUntil - Date.now()) / 60000));
// Returns true when the PIN is right. Otherwise it has already answered the request and returns false.
async function checkOwnerPin(req, res) {
  if(Date.now() < pinDoor.lockedUntil) { res.status(423).json({ error: `Locked for ${pinMins()} more minute(s) after wrong PINs.`, locked: true, mins: pinMins() }); return false; }
  const supplied = String(req.headers['x-owner-pin'] || (req.body && req.body.pin) || '').slice(0, 32);
  if(!supplied) { res.status(401).json({ error: 'Owner PIN required.', pinRequired: true, remaining: PIN_TRIES - pinDoor.fails }); return false; }
  let stored = null;
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'owner_pin'").get();
    stored = row && JSON.parse(row.value);
  } catch(e) { stored = null; }
  if(!stored || !stored.hash) { res.status(409).json({ error: 'No Owner PIN is set yet. Set one in Settings first.' }); return false; }
  const a = crypto.createHash('sha256').update(supplied + PIN_SALT).digest();
  const b = Buffer.from(String(stored.hash), 'hex');
  if(b.length === a.length && crypto.timingSafeEqual(a, b)) { pinDoor.fails = 0; return true; }
  pinDoor.fails += 1;
  const stamp = Date.now();
  await pc.logServerEvent({ entryId: `srv-payacct-badpin-${stamp}`, category: 'security', level: 'warn',
    message: `Wrong Owner PIN typed at Payment Accounts (${pinDoor.fails} of ${PIN_TRIES})`, detail: { by: who(req) } });
  if(pinDoor.fails >= PIN_TRIES) {
    pinDoor.fails = 0; pinDoor.lockedUntil = stamp + PIN_LOCK_MS;
    await raiseAlert({ kind: 'pin_lockout', key: `pinlock-${stamp}`,
      message: `The wrong Owner PIN was typed ${PIN_TRIES} times at Payment Accounts (signed in as ${who(req)}). The page is locked for 30 minutes. If this was not you, change your password now.`,
      detail: { by: who(req) }, pushTitle: '\u{1F6A8} Wrong PIN at Payment Accounts', pushBody: `${PIN_TRIES} wrong Owner PINs at Payment Accounts (${who(req)}). Locked for 30 minutes.` });
    res.status(423).json({ error: 'Locked for 30 minutes after 3 wrong PINs. A red alert was raised.', locked: true, mins: 30 });
    return false;
  }
  res.status(401).json({ error: `Incorrect PIN. ${PIN_TRIES - pinDoor.fails} attempt(s) left before the lock.`, pinRequired: true, remaining: PIN_TRIES - pinDoor.fails });
  return false;
}
const ownerPin = async (req, res, next) => { try { if(await checkOwnerPin(req, res)) next(); } catch(e) { next(e); } };

const router = express.Router();

// The official EggScore bank accounts (Oct 16 2026, 0.55).
//
//   GET   /payment-accounts           portal or staff: the ACTIVE accounts (what a customer may pay into)
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
