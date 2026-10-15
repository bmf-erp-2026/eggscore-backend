// lib/staff-hours.js — Oct 12 2026
// Staff (everyone except the Owner) can use the ERP Monday to Saturday, 06:00 to 18:30 Lagos time.
//   * 18:00 is close of business; the 30 minutes after it are the grace period to file reports
//   * from 18:30 the server refuses staff requests and the ERP signs them out
//   * Sundays are closed
//   * the Owner can grant a staff member a one-day exception (table staff_hours_exceptions) that runs
//     until an end time the Owner picks (default 8:00 PM Lagos, never later than 11:59 PM)
// The Owner's own sign-in is never restricted. Everything here is decided by the SERVER clock,
// so changing a device's clock gets nobody extra time.
const { db } = require('../db.postgres');

const OPEN_MIN = 6 * 60;           // 06:00
const COB_MIN = 18 * 60;           // 18:00 close of business (reports reminder)
const DEFAULT_UNTIL_MIN = 20 * 60; // a late permission ends at 20:00 unless the Owner picks another time (Oct 15 2026)
const CLOSE_MIN = 18 * 60 + 30;    // 18:30 hard stop
const LAGOS_MS = 3600000;          // Africa/Lagos = UTC+1, no daylight saving
const DAY_MS = 86400000;

let clock = () => Date.now();                       // replaced only by the test suite
function setClock(fn) { clock = fn || (() => Date.now()); }

const lagos = ms => new Date(ms + LAGOS_MS);
const ymd = ms => lagos(ms).toISOString().slice(0, 10);

function isOpen(ms = clock()) {
  const l = lagos(ms);
  if(l.getUTCDay() === 0) return false;
  const m = l.getUTCHours() * 60 + l.getUTCMinutes();
  return m >= OPEN_MIN && m < CLOSE_MIN;
}

// UTC instant of HH:MM Lagos on the Lagos date of `ms` plus `addDays`.
function lagosInstant(ms, addDays, minutes) {
  const d = lagos(ms);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + addDays);
  return base + minutes * 60000 - LAGOS_MS;
}

// Next moment the ERP opens for staff (now, if it is open).
function nextOpening(ms = clock()) {
  if(isOpen(ms)) return ms;
  for(let add = 0; add <= 7; add++) {
    const t = lagosInstant(ms, add, OPEN_MIN);
    if(t > ms && lagos(t).getUTCDay() !== 0) return t;
  }
  return null;
}

function windowStatus(ms = clock()) {
  const open = isOpen(ms);
  const iso = t => (t == null ? null : new Date(t).toISOString());
  return {
    open,
    now: new Date(ms).toISOString(),
    cobAt: open ? iso(lagosInstant(ms, 0, COB_MIN)) : null,         // 18:00 today
    closesAt: open ? iso(lagosInstant(ms, 0, CLOSE_MIN)) : null,    // 18:30 today
    opensAt: open ? null : iso(nextOpening(ms)),
  };
}

const norm = e => String(e || '').trim().toLowerCase();

// The Owner's late permission for this person today, or null. `untilMin` is minutes after midnight, Lagos
// (a row saved before Oct 15 2026 has none and keeps its old promise: until midnight).
async function exceptionFor(email, ms = clock()) {
  if(!norm(email)) return null;
  let r = null;
  try {
    r = await db.prepare('SELECT until_min FROM staff_hours_exceptions WHERE email = ? AND day = ?').get(norm(email), ymd(ms));
  } catch(e) {
    try {   // the until_min column is not there yet: behave as before (until midnight)
      const o = await db.prepare('SELECT 1 AS ok FROM staff_hours_exceptions WHERE email = ? AND day = ?').get(norm(email), ymd(ms));
      r = o ? { until_min: null } : null;
    } catch(e2) { console.error('[staff-hours] exception lookup failed:', e2.message); return null; }
  }
  if(!r) return null;
  const untilMin = r.until_min == null ? 24 * 60 : Number(r.until_min);
  const l = lagos(ms);
  const nowMin = l.getUTCHours() * 60 + l.getUTCMinutes();
  if(nowMin >= untilMin) return null;                // the permission has run out
  return { untilMin, untilAt: untilMin >= 24 * 60 ? lagosInstant(ms, 1, 0) : lagosInstant(ms, 0, untilMin) };
}
async function hasException(email, ms = clock()) { return !!(await exceptionFor(email, ms)); }

// "20:00" -> 1200; anything unusable -> the default. Kept between 18:30 and 23:59.
function parseUntil(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if(!m) return DEFAULT_UNTIL_MIN;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if(!(mins >= CLOSE_MIN && mins <= 23 * 60 + 59)) return DEFAULT_UNTIL_MIN;
  return mins >= 23 * 60 + 59 ? 24 * 60 : mins;        // "11:59 PM" means through to midnight
}
const fmtMin = mins => { const m = Math.min(Number(mins), 24 * 60 - 1); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

// ── Who is calling? Only looked up OUTSIDE working hours, so normal days cost nothing extra. ──
let resolveUser = null;   // (token) => { email, role } | null ; set below or by the test suite
function setUserResolver(fn) { resolveUser = fn; }
const cache = new Map();  // token -> { at, user }
function defaultResolver() {
  if(!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) return null;
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return async token => {
    const { data, error } = await admin.auth.getUser(token);
    if(error || !data || !data.user) return null;
    return { email: data.user.email, role: (data.user.app_metadata && data.user.app_metadata.role) || 'owner' };
  };
}
async function whoIs(token) {
  const hit = cache.get(token);
  if(hit && Date.now() - hit.at < 60000) return hit.user;
  if(!resolveUser) resolveUser = defaultResolver();
  if(!resolveUser) return undefined;                 // cannot check: let the route's own login check decide
  const user = await resolveUser(token);
  cache.set(token, { at: Date.now(), user });
  if(cache.size > 500) cache.clear();
  return user;
}

const EXEMPT = ['/staff-hours/status',   // the screen that explains the lock must still be reachable
                '/attendance/out'];      // the clock-out note must still get through at 6:30 PM

// Express middleware, mounted before the routes. Anything without a staff login token
// (customer portal, public pages, delivery confirmation) passes untouched.
function guard() {
  return async (req, res, next) => {
    try {
      const ms = clock();
      if(isOpen(ms)) return next();
      if(EXEMPT.some(p => req.path === p)) return next();
      const header = req.headers['authorization'] || '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
      if(!token) return next();
      const user = await whoIs(token);
      if(!user) return next();                       // invalid token or cannot verify: the route answers (401)
      if(user.role === 'owner') return next();
      if(await hasException(user.email, ms)) return next();
      const w = windowStatus(ms);
      return res.status(403).json({
        error: 'EggScore is closed for staff right now. Staff hours are Monday to Saturday, 6:00 AM to 6:30 PM. Ask the Owner if you need to work late.',
        code: 'OUTSIDE_HOURS', opensAt: w.opensAt,
      });
    } catch(e) {
      console.error('[staff-hours] guard error:', e.message);
      next();
    }
  };
}

module.exports = { isOpen, nextOpening, windowStatus, hasException, exceptionFor, parseUntil, fmtMin, lagosInstant, DEFAULT_UNTIL_MIN, CLOSE_MIN, guard, setClock, setUserResolver, ymd, norm, clock: () => clock() };
