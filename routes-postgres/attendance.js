const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');
const hours = require('../lib/staff-hours');

const router = express.Router();

// Oct 13 2026 — staff clock-in / clock-out.
//   * Every staff login except the Owner's sends a "still here" ping about every 2 minutes while the ERP
//     is open (POST /ping). The first ping of the Lagos day is the clock-in.
//   * Log Out, the idle lock and the 6:30 PM automatic sign-out tell the server (POST /out).
//   * If someone just closes the browser, the last ping stands in for the clock-out.
//   * The Owner reads it inside Daily Reports (routes-postgres/eod-reports.js calls forDay()).
// Times use the SERVER clock, so a wrong device clock changes nothing.

const LATE_AFTER_MIN = 8 * 60;       // signing in after 8:00 AM Lagos is tagged Late (Owner's default; one constant)
const ONLINE_WITHIN_MS = 5 * 60000;  // seen in the last 5 minutes and not signed out = online now
const LAGOS_MS = 3600000;

// A ping that arrives within this long after a sign-out is a straggler from the page that just closed,
// not a new sign-in, so it must not undo the sign-out.
const STRAGGLER_MS = 20000;

router.post('/ping', requireSupabaseAuth(), async (req, res) => {
  if(!req.user || req.user.role === 'owner') return res.json({ ok: true, tracked: false });
  const ms = hours.clock(), at = new Date(ms).toISOString(), day = hours.ymd(ms), email = hours.norm(req.user.email);
  if(!email) return res.json({ ok: true, tracked: false });
  await db.prepare(`INSERT INTO staff_attendance (day, email, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (email, day) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      pings = staff_attendance.pings + 1,
      signed_out_at = CASE WHEN staff_attendance.signed_out_at IS NOT NULL
                            AND staff_attendance.signed_out_at > ?::timestamptz
                           THEN staff_attendance.signed_out_at ELSE NULL END`)
    .run(day, email, at, at, new Date(ms - STRAGGLER_MS).toISOString());
  res.json({ ok: true, tracked: true });
});

router.post('/out', requireSupabaseAuth(), async (req, res) => {
  if(!req.user || req.user.role === 'owner') return res.json({ ok: true, tracked: false });
  const ms = hours.clock(), at = new Date(ms).toISOString(), day = hours.ymd(ms), email = hours.norm(req.user.email);
  if(!email) return res.json({ ok: true, tracked: false });
  // Only a day the person actually worked, and only the first sign-out of a stretch: a later
  // sign-out call (for instance a page opened after closing time) never overwrites it.
  await db.prepare(`UPDATE staff_attendance SET last_seen_at = ?, signed_out_at = ?
    WHERE email = ? AND day = ? AND signed_out_at IS NULL`).run(at, at, email, day);
  res.json({ ok: true, tracked: true });
});

// For the Owner's Daily Reports: email -> { clockIn, clockOut, online, estimated, minutes, late }
async function forDay(day, nowMs) {
  const rows = await db.prepare('SELECT * FROM staff_attendance WHERE day = ?').all(day);
  const out = new Map();
  const iso = v => new Date(v).toISOString();
  rows.forEach(r => {
    const first = new Date(r.first_seen_at).getTime(), last = new Date(r.last_seen_at).getTime();
    const signedOut = r.signed_out_at ? new Date(r.signed_out_at).getTime() : null;
    const sameDay = hours.ymd(nowMs) === day;
    const online = !signedOut && sameDay && (nowMs - last) < ONLINE_WITHIN_MS;
    const end = signedOut != null ? signedOut : last;
    const l = new Date(first + LAGOS_MS);
    // Oct 15 2026: minutes worked after the 6:30 PM stop (only possible with the Owner's late permission)
    const afterMin = Math.max(0, Math.round(((online ? nowMs : end) - Math.max(first, hours.lagosInstant(first, 0, hours.CLOSE_MIN))) / 60000));
    out.set(hours.norm(r.email), {
      clockIn: iso(first),
      clockOut: online ? null : iso(end),
      online,
      estimated: !online && signedOut == null,          // closed without signing out: last activity shown
      minutes: Math.max(0, Math.round(((online ? nowMs : end) - first) / 60000)),
      late: (l.getUTCHours() * 60 + l.getUTCMinutes()) > LATE_AFTER_MIN,
      afterHours: afterMin >= 1,
      afterMinutes: afterMin >= 1 ? afterMin : 0,
    });
  });
  return out;
}

module.exports = router;
module.exports.forDay = forDay;
module.exports.LATE_AFTER_MIN = LATE_AFTER_MIN;
