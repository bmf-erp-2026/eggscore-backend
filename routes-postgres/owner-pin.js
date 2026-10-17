// Owner PIN, checked on the SERVER only (0.64, Oct 2026).
//
// Before this, every ERP browser downloaded the PIN's hash and compared what was typed against it on the device, so anyone
// with an Owner login could read the hash and work the PIN out offline, and staff devices (which could not read the hash)
// fell back to a default. Now no browser ever receives the hash. A PIN typed in ANY override box is sent here and checked
// against the stored hash by lib/owner-pin.js, which holds the ONE door for the whole system: 3 wrong tries lock it for
// 30 minutes, and a red alert + phone push goes out. The same door guards Payment Accounts, so there is one PIN and one lock.
//
//   POST /owner-pin/verify   any signed-in staff login   {pin}                 -> {ok:true} | 401 wrong | 423 locked | 409 no PIN set
//   POST /owner-pin/change   Owner login                 {currentPin,newPin}   -> {ok, recoveryCode (shown once), setAt}
//   POST /owner-pin/recover  Owner login                 {code,newPin}         -> {ok, recoveryCode (a NEW one, shown once), setAt}
//
// What was typed is never stored or logged. The recovery code is made here, shown once, and only its hash is kept.
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');
const pc = require('../lib/portal-checks');
const pin = require('../lib/owner-pin');

const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const WEAK = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '3210', '1212', '2580', '1122', '12345', '54321', '123456', '654321', '1234567', '12345678', '00000000']);
const weakPin = p => WEAK.has(p) || /^(.)\1+$/.test(p);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no look-alike letters, same set the ERP always used
const newRecoveryCode = () => Array.from({ length: 8 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');

// 4 to 8 characters, not obviously guessable. Returns an error sentence, or '' when fine.
function badNewPin(p) {
  if(p.length < 4 || p.length > 8) return 'The new PIN must be 4 to 8 characters.';
  if(weakPin(p)) return 'That PIN is too easy to guess (like 1234 or 0000). Choose another.';
  return '';
}

async function storePin(hash, recoveryHash, by) {
  const rec = { hash, recoveryHash, setAt: new Date().toISOString(), lockoutUntil: null };
  await db.prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('owner_pin', ?, ?, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()")
    .run(JSON.stringify(rec), by || null);
  pin.clearLock();
  return rec;
}

// Any staff login may ask "is this the Owner PIN?" (a manager or rep hands the Owner the phone to approve something).
// The shared door counts every wrong try, whoever types it.
router.post('/verify', requireSupabaseAuth(), async (req, res) => {
  try {
    const r = await pin.checkSecret(req, 'pin', req.body && req.body.pin, 'an ERP override box');
    if(!r.ok) return res.status(r.status).json(r.body);
    res.json({ ok: true });
  } catch(e) { console.error('[owner-pin] verify failed:', e.message); res.status(500).json({ error: 'The PIN could not be checked just now. Try again.' }); }
});

router.post('/change', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  try {
    const current = String((req.body && req.body.currentPin) || '');
    const next = String((req.body && req.body.newPin) || '');
    const bad = badNewPin(next);
    if(bad) return res.status(400).json({ error: bad });          // a form mistake never costs a try
    const stored = await pin.getStored();
    if(stored && stored.hash) {                                    // the very first PIN ever set needs no proof
      const r = await pin.checkSecret(req, 'pin', current, 'the Change PIN box');
      if(!r.ok) return res.status(r.status).json(r.body);
    }
    const recoveryCode = newRecoveryCode();
    const rec = await storePin(pin.hashSecret(next), pin.hashSecret(recoveryCode), pin.who(req));
    const now = Date.now();
    await pc.logServerEvent({ entryId: `srv-ownerpin-changed-${now}`, category: 'security', level: 'warn', message: 'Owner PIN changed in Settings', detail: { by: pin.who(req) } });
    await pin.raiseAlert({ kind: 'pin_changed', key: `pinchanged-${now}`,
      message: `The Owner PIN was changed in Settings (signed in as ${pin.who(req)}). If this was not you, change your password now.`,
      detail: { by: pin.who(req) }, pushTitle: '\u{1F6A8} Owner PIN changed', pushBody: `The Owner PIN was changed by ${pin.who(req)}. Not you? Change your password now.` });
    res.json({ ok: true, recoveryCode, setAt: rec.setAt });
  } catch(e) { console.error('[owner-pin] change failed:', e.message); res.status(500).json({ error: 'The PIN could not be changed just now. Nothing was changed. Try again.' }); }
});

router.post('/recover', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const next = String((req.body && req.body.newPin) || '');
    if(code.length !== 8) return res.status(400).json({ error: 'Type your 8-character recovery code.' });
    const bad = badNewPin(next);
    if(bad) return res.status(400).json({ error: bad });
    const r = await pin.checkSecret(req, 'recovery', code, 'the recovery-code box');
    if(!r.ok) return res.status(r.status).json(r.body);
    const recoveryCode = newRecoveryCode();                         // the used code is dead; a new one replaces it
    const rec = await storePin(pin.hashSecret(next), pin.hashSecret(recoveryCode), pin.who(req));
    const now = Date.now();
    await pc.logServerEvent({ entryId: `srv-ownerpin-recovered-${now}`, category: 'security', level: 'warn', message: 'Owner PIN reset with the recovery code', detail: { by: pin.who(req) } });
    await pin.raiseAlert({ kind: 'pin_recovered', key: `pinrecovered-${now}`,
      message: `The Owner PIN was reset with the recovery code (signed in as ${pin.who(req)}). If this was not you, change your password now.`,
      detail: { by: pin.who(req) }, pushTitle: '\u{1F6A8} Owner PIN reset', pushBody: `The Owner PIN was reset with the recovery code by ${pin.who(req)}. Not you? Change your password now.` });
    res.json({ ok: true, recoveryCode, setAt: rec.setAt });
  } catch(e) { console.error('[owner-pin] recover failed:', e.message); res.status(500).json({ error: 'The PIN could not be reset just now. Nothing was changed. Try again.' }); }
});

module.exports = router;
