// lib/pay-code.js — the EggScore Pay Code (Oct 16 2026, 0.55).
//
// A short code (like K7M-2QX) worked out from an order reference or invoice number with a secret only the server
// holds. Every genuine payment message from EggScore carries it. Nobody can work it out from the reference, and the
// "Check an account" page never reveals it: a customer types the code from their message and the page only answers
// "matches" or "does not match". A fake message therefore cannot carry a code that checks out.
//
// The secret is created once, stored in the settings table and never sent anywhere.
const crypto = require('crypto');
const { db } = require('../db.postgres');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I, so it reads out loud and types without mistakes
let secretCache = null;

async function secret() {
  if(secretCache) return secretCache;
  let row = await db.prepare("SELECT value FROM settings WHERE key = 'pay_code_secret'").get();
  if(!row) {
    await db.prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('pay_code_secret', ?, 'system', now()) ON CONFLICT (key) DO NOTHING")
      .run(crypto.randomBytes(32).toString('hex'));
    row = await db.prepare("SELECT value FROM settings WHERE key = 'pay_code_secret'").get();
  }
  secretCache = row.value;
  return secretCache;
}

const normRef = ref => String(ref == null ? '' : ref).trim().toUpperCase();
const cleanCode = c => String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '');

async function payCodeFor(ref) {
  const r = normRef(ref);
  if(!r) return null;
  const h = crypto.createHmac('sha256', await secret()).update(r).digest();
  let out = '';
  for(let i = 0; i < 6; i++) out += ALPHA[h[i] % 32];
  return out.slice(0, 3) + '-' + out.slice(3);
}

async function codeMatches(ref, code) {
  const want = await payCodeFor(ref);
  const got = cleanCode(code);
  if(!want || got.length !== 6) return false;
  const a = Buffer.from(want.replace('-', '')), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { payCodeFor, codeMatches, normRef, cleanCode };
