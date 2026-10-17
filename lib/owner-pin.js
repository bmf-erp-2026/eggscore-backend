// The Owner PIN door, shared by the Payment Accounts routes and the Settings route that stores the PIN (0.59 / 0.60).
//
// The PIN is stored only as a hash (settings key owner_pin: { hash, recoveryHash, setAt, lockoutUntil }), made the same way the ERP
// makes it: SHA-256 of the secret plus the app's salt. The server checks a typed PIN (or recovery code) against that hash,
// never stores or logs what was typed, and counts wrong tries in ONE place: three wrong tries lock the door for 30 minutes and
// raise a red alert + phone push. The counter lives in memory, so a restart clears a lock; the alert has already gone out.
const crypto = require('crypto');
const { db } = require('../db.postgres');
const pc = require('./portal-checks');
const push = require('./push');

const SALT = 'bel_eggscore_salt_2026';
const TRIES = 3, LOCK_MS = 30 * 60 * 1000;
const door = { fails: 0, lockedUntil: 0 };
const mins = () => Math.max(1, Math.ceil((door.lockedUntil - Date.now()) / 60000));
const who = req => (req.user && req.user.email) || 'someone';
const hashSecret = s => crypto.createHash('sha256').update(String(s) + SALT).digest('hex');
function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex'), y = Buffer.from(String(b || ''), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function getStored() {
  try { const row = await db.prepare("SELECT value FROM settings WHERE key = 'owner_pin'").get(); return row ? JSON.parse(row.value) : null; }
  catch(e) { return null; }
}

// A red alert the Owner must acknowledge. One per dedupe key, and a phone push goes out the moment a NEW one is raised.
// Never throws into the caller.
async function raiseAlert({ kind, key, message, detail, pushTitle, pushBody }) {
  try {
    const info = await db.prepare('INSERT INTO security_alerts (kind, dedupe_key, message, detail) VALUES (?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING')
      .run(kind, key, message, JSON.stringify(detail || null));
    if(info && info.changes) {
      push.notifyOwners({ title: pushTitle || '\u{1F6A8} EggScore security alert', body: pushBody || message, url: '/famad-erp.html', tag: 'secalert-' + key, kind: 'security_alert' })
        .catch(e => console.error('[owner-pin] alert push failed:', e.message));
    }
  } catch(e) { console.warn('[owner-pin] could not raise alert:', e.message); }
}

// Check a typed PIN (kind 'pin') or recovery code (kind 'recovery'). Returns { ok: true } or { ok: false, status, body }.
// `where` names the place in the alert ("Payment Accounts", "the Owner PIN settings").
async function checkSecret(req, kind, supplied, where) {
  if(Date.now() < door.lockedUntil) return { ok: false, status: 423, body: { error: `Locked for ${mins()} more minute(s) after wrong PINs.`, locked: true, mins: mins() } };
  supplied = String(supplied || '').slice(0, 32);
  if(!supplied) return { ok: false, status: 401, body: { error: kind === 'recovery' ? 'Recovery code required.' : 'Owner PIN required.', pinRequired: true, remaining: TRIES - door.fails } };
  const stored = await getStored();
  if(!stored || !stored.hash) return { ok: false, status: 409, body: { error: 'No Owner PIN is set yet. Set one in Settings first.' } };
  const want = kind === 'recovery' ? stored.recoveryHash : stored.hash;
  if(sameHex(hashSecret(supplied), want)) { door.fails = 0; return { ok: true }; }
  door.fails += 1;
  const stamp = Date.now();
  await pc.logServerEvent({ entryId: `srv-ownerpin-bad-${stamp}`, category: 'security', level: 'warn',
    message: `Wrong Owner ${kind === 'recovery' ? 'recovery code' : 'PIN'} typed at ${where} (${door.fails} of ${TRIES})`, detail: { by: who(req) } });
  if(door.fails >= TRIES) {
    door.fails = 0; door.lockedUntil = stamp + LOCK_MS;
    await raiseAlert({ kind: 'pin_lockout', key: `pinlock-${stamp}`,
      message: `The wrong Owner PIN was typed ${TRIES} times at ${where} (signed in as ${who(req)}). The Owner PIN is locked for 30 minutes. If this was not you, change your password now.`,
      detail: { by: who(req) }, pushTitle: '\u{1F6A8} Wrong PIN at ' + where, pushBody: `${TRIES} wrong Owner PINs at ${where} (${who(req)}). Locked for 30 minutes.` });
    return { ok: false, status: 423, body: { error: 'Locked for 30 minutes after 3 wrong PINs. A red alert was raised.', locked: true, mins: 30 } };
  }
  return { ok: false, status: 401, body: { error: `Incorrect ${kind === 'recovery' ? 'recovery code' : 'PIN'}. ${TRIES - door.fails} attempt(s) left before the lock.`, pinRequired: true, remaining: TRIES - door.fails } };
}
function clearLock() { door.fails = 0; door.lockedUntil = 0; }

// Guard for PATCH /settings/owner-pin (mounted in server.postgres.js, ahead of the Settings routes). An Owner login alone can no
// longer swap the PIN: changing the PIN hash or the recovery hash needs proof of the CURRENT PIN (x-owner-pin header) or of the
// recovery code (x-owner-recovery header). Saving the same hashes again (the ERP's lockout sync) and the very first PIN ever set
// need no proof. A wrong proof counts toward the same 3-tries / 30-minute lock as the Payment Accounts door.
function guardPinChange() {
  const { requireSupabaseAuth, requireRole } = require('../auth.postgres');
  return [requireSupabaseAuth(), requireRole('owner'), async (req, res, next) => {
    try {
      const pin = req.body && req.body.pin;
      if(!pin || typeof pin !== 'object' || !pin.hash) return next();   // the route itself answers 400
      const stored = await getStored();
      if(!stored || !stored.hash) return next();                          // first PIN ever
      const unchanged = String(pin.hash) === String(stored.hash) && String(pin.recoveryHash || '') === String(stored.recoveryHash || '');
      if(unchanged) return next();
      const viaRecovery = !req.headers['x-owner-pin'] && !!req.headers['x-owner-recovery'];
      const proof = await checkSecret(req, viaRecovery ? 'recovery' : 'pin', viaRecovery ? req.headers['x-owner-recovery'] : req.headers['x-owner-pin'], 'the Owner PIN settings');
      if(!proof.ok) return res.status(proof.status).json(proof.body);
      next();
    } catch(e) { next(e); }
  }];
}

module.exports = { SALT, door, who, hashSecret, sameHex, getStored, raiseAlert, checkSecret, clearLock, guardPinChange };
