const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');
const hours = require('../lib/staff-hours');
const push = require('../lib/push');

const router = express.Router();

// Oct 12 2026 — End-of-Day reports.
//   * Every staff login except the Owner files one report per working day (Monday to Saturday).
//   * Filed before 6:00 PM Lagos = on time. From 6:00 PM (the 30-minute grace period, or later if the
//     Owner allowed late access) = late. Nothing filed by 6:30 PM = missing. The Owner can excuse a day.
//   * A report can be edited until the staff member is signed out; editing never changes on time/late.
//   * The Owner reads the roll-up (GET /day) and gets ONE alert at 6:30 PM with the totals.
// The report body is stored as JSON so a section can be added later without a database change.

const COB_MIN = 18 * 60;
const CLOSE_MIN = 18 * 60 + 30;
const LAGOS_MS = 3600000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const lagos = ms => new Date(ms + LAGOS_MS);
const minutesOf = ms => { const l = lagos(ms); return l.getUTCHours() * 60 + l.getUTCMinutes(); };
const isWorkingDay = ms => lagos(ms).getUTCDay() !== 0;

// ── who is expected to file ──
// Every login whose role is not owner, except a Sales Rep who has been deboarded.
let staffLister = null;          // () => [{ email, role }]; the test suite replaces it
function setStaffLister(fn) { staffLister = fn; staffCache = null; }
let staffCache = null;
async function defaultLister() {
  if(!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) return [];
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if(error || !data) throw new Error(error ? error.message : 'no user list');
  return data.users.map(u => ({ email: u.email, role: (u.app_metadata && u.app_metadata.role) || 'owner' }));
}
async function expectedStaff() {
  if(staffCache && Date.now() - staffCache.at < 60000) return staffCache.list;
  const all = await (staffLister || defaultLister)();
  let reps = [];
  try { reps = await db.prepare('SELECT name, email, status FROM reps').all(); } catch(e) { reps = []; }
  const byEmail = new Map(reps.filter(r => r.email).map(r => [hours.norm(r.email), r]));
  const list = all
    .filter(u => u.email && u.role !== 'owner')
    .map(u => {
      const r = byEmail.get(hours.norm(u.email));
      const local = String(u.email).split('@')[0];
      return { email: hours.norm(u.email), role: u.role, name: (r && r.name) || local, deboarded: !!(r && r.status && r.status !== 'active') };
    })
    .filter(u => !u.deboarded);
  staffCache = { at: Date.now(), list };
  return list;
}

// ── report body: validate and trim ──
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(0, Math.round(n)), max) : 0; };
const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
function cleanReport(b) {
  b = b || {};
  const f = b.figures || {};
  const data = {
    v: 1,
    figures: {
      salesCount: num(f.salesCount, 100000), cratesSold: num(f.cratesSold, 10000000), salesValue: num(f.salesValue, 1e12),
      paymentsCount: num(f.paymentsCount, 100000), paymentsTotal: num(f.paymentsTotal, 1e12),
      openOrders: num(f.openOrders, 100000), unreadMessages: num(f.unreadMessages, 100000),
    },
    accurate: b.accurate === true,
    cashHandover: ['yes', 'no', 'none'].includes(b.cashHandover) ? b.cashHandover : '',
    cashNote: txt(b.cashNote, 300),
    damagedCrates: num(b.damagedCrates, 100000),
    noIssues: b.noIssues === true,
    issues: txt(b.issues, 1500),
    lookahead: txt(b.lookahead, 1500),
    other: txt(b.other, 1500),
  };
  const errors = [];
  if(!data.accurate) errors.push('Tick "These figures are accurate" (or correct them in Issues first).');
  if(!data.cashHandover) errors.push('Say what happened to the cash and transfers collected today.');
  if(data.cashHandover === 'no' && !data.cashNote) errors.push('Explain where the cash is now.');
  if(!data.noIssues && !data.issues) errors.push('Describe the issues, or tick "No issues today".');
  return { data, errors };
}

const rowOut = r => ({
  id: Number(r.id), email: r.email, name: r.name || r.email, role: r.role || '', status: r.status,
  firstSubmittedAt: new Date(r.first_submitted_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  data: typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {}), excusedBy: r.excused_by || null,
});

// Staff: today's report state
router.get('/me', requireSupabaseAuth(), async (req, res) => {
  const ms = hours.clock();
  const day = hours.ymd(ms);
  const email = hours.norm(req.user.email);
  const row = await db.prepare('SELECT * FROM eod_reports WHERE email = ? AND day = ?').get(email, day);
  res.json({
    day, role: req.user.role, exempt: req.user.role === 'owner',
    workingDay: isWorkingDay(ms), dueBy: '18:00',
    filed: !!row && row.status !== 'excused', report: row ? rowOut(row) : null,
  });
});

// Staff: file or update today's report
router.post('/me', requireSupabaseAuth(), async (req, res) => {
  if(req.user.role === 'owner') return res.status(403).json({ error: 'The Owner does not file End-of-Day reports.' });
  const ms = hours.clock();
  if(!isWorkingDay(ms)) return res.status(400).json({ error: 'There is no End-of-Day report on Sundays.' });
  const { data, errors } = cleanReport(req.body);
  if(errors.length) return res.status(400).json({ error: errors[0], errors });
  const day = hours.ymd(ms);
  const email = hours.norm(req.user.email);
  const existing = await db.prepare('SELECT * FROM eod_reports WHERE email = ? AND day = ?').get(email, day);
  const staff = (await expectedStaff().catch(() => [])).find(s => s.email === email);
  const name = (staff && staff.name) || email.split('@')[0];
  if(existing && existing.status !== 'excused') {
    await db.prepare('UPDATE eod_reports SET data = ?::jsonb, updated_at = now(), name = ?, role = ? WHERE id = ?')
      .run(JSON.stringify(data), name, req.user.role, existing.id);
  } else {
    const status = minutesOf(ms) < COB_MIN ? 'on_time' : 'late';
    await db.prepare(`INSERT INTO eod_reports (day, email, name, role, status, first_submitted_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
      ON CONFLICT (email, day) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, name = EXCLUDED.name, role = EXCLUDED.role,
        first_submitted_at = EXCLUDED.first_submitted_at, updated_at = EXCLUDED.updated_at, excused_by = NULL`)
      .run(day, email, name, req.user.role, status, new Date(ms).toISOString(), new Date(ms).toISOString(), JSON.stringify(data));
  }
  const row = await db.prepare('SELECT * FROM eod_reports WHERE email = ? AND day = ?').get(email, day);
  console.log(`[eod] report ${existing ? 'updated' : 'filed'} by ${email} for ${day} (${row.status})`);
  res.status(existing && existing.status !== 'excused' ? 200 : 201).json({ day, report: rowOut(row) });
});

// ── Owner: the roll-up for a day ──
const ownerOnly = [requireSupabaseAuth(), requireRole('owner')];

async function rollup(day, nowMs) {
  const working = isWorkingDay(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 12));
  const rows = (await db.prepare('SELECT * FROM eod_reports WHERE day = ? ORDER BY first_submitted_at').all(day)).map(rowOut);
  const staff = working ? await expectedStaff() : [];
  const today = hours.ymd(nowMs);
  const closed = day < today || (day === today && minutesOf(nowMs) >= CLOSE_MIN);
  const filedEmails = new Set(rows.map(r => r.email));
  const out = rows.map(r => ({ ...r }));
  staff.filter(s => !filedEmails.has(s.email)).forEach(s => {
    out.push({ id: null, email: s.email, name: s.name, role: s.role, status: closed ? 'missing' : 'pending', firstSubmittedAt: null, updatedAt: null, data: null, excusedBy: null });
  });
  // Someone who filed but is not in the expected list (role changed since) still shows.
  const order = { missing: 0, pending: 1, late: 2, on_time: 3, excused: 4 };
  out.sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
  const count = s => out.filter(r => r.status === s).length;
  const expected = out.filter(r => r.status !== 'excused').length;
  return {
    day, workingDay: working, closed,
    counts: { expected, filed: count('on_time') + count('late'), onTime: count('on_time'), late: count('late'), missing: count('missing'), pending: count('pending'), excused: count('excused') },
    rows: out,
  };
}

router.get('/day', ...ownerOnly, async (req, res) => {
  const now = hours.clock();
  const day = DATE_RE.test(String(req.query.date || '')) ? String(req.query.date) : hours.ymd(now);
  res.json(await rollup(day, now));
});

router.post('/excuse', ...ownerOnly, async (req, res) => {
  const now = hours.clock();
  const email = hours.norm(req.body && req.body.email);
  const day = DATE_RE.test(String((req.body && req.body.day) || '')) ? String(req.body.day) : hours.ymd(now);
  const note = txt(req.body && req.body.note, 140);
  const staff = (await expectedStaff().catch(() => [])).find(s => s.email === email);
  if(!staff) return res.status(400).json({ error: 'That is not a staff sign-in email.' });
  const data = JSON.stringify({ v: 1, excusedNote: note });
  await db.prepare(`INSERT INTO eod_reports (day, email, name, role, status, data, excused_by)
    VALUES (?, ?, ?, ?, 'excused', ?::jsonb, ?)
    ON CONFLICT (email, day) DO UPDATE SET status = 'excused', data = EXCLUDED.data, excused_by = EXCLUDED.excused_by, updated_at = now()
    WHERE eod_reports.status = 'excused'`)
    .run(day, email, staff.name, staff.role, data, req.user.email || null);
  const row = await db.prepare('SELECT * FROM eod_reports WHERE email = ? AND day = ?').get(email, day);
  if(row.status !== 'excused') return res.status(409).json({ error: 'That report was already filed.' });
  console.log(`[audit] End-of-Day report for ${email} (${day}) excused by ${req.user.email}`);
  res.status(201).json(rowOut(row));
});

router.delete('/excuse/:id', ...ownerOnly, async (req, res) => {
  const id = Number(req.params.id);
  if(!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });
  const r = await db.prepare("DELETE FROM eod_reports WHERE id = ? AND status = 'excused'").run(id);
  res.json({ ok: true, removed: r.changes || 0 });
});

// ── the one 6:30 PM alert to the Owner ──
async function sendDigestIfDue() {
  const ms = hours.clock();
  if(!isWorkingDay(ms)) return { sent: false, why: 'sunday' };
  const m = minutesOf(ms);
  if(m < CLOSE_MIN || m > CLOSE_MIN + 120) return { sent: false, why: 'not-time' };   // no stale alerts after a late restart
  const day = hours.ymd(ms);
  const claimed = await db.prepare('INSERT INTO eod_digest_log (day) VALUES (?) ON CONFLICT (day) DO NOTHING RETURNING day').run(day);
  if(!claimed.changes) return { sent: false, why: 'already' };
  const r = await rollup(day, ms);
  const c = r.counts;
  const missing = r.rows.filter(x => x.status === 'missing').map(x => x.name);
  let body = c.expected === 0 ? 'No staff reports expected today.' : `${c.filed} of ${c.expected} reports filed`;
  if(c.late) body += `, ${c.late} late`;
  if(missing.length) body += `. Missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`;
  await db.prepare('UPDATE eod_digest_log SET expected = ?, filed = ? WHERE day = ?').run(c.expected, c.filed, day);
  const result = await push.notifyOwners({
    title: '📋 End-of-Day reports', body, url: '/famad-erp.html?eod=1', tag: `eod-${day}`, kind: 'eod_summary',
  });
  console.log(`[eod] 6:30 PM summary for ${day}: ${body} (devices: ${JSON.stringify(result)})`);
  return { sent: true, body, result };
}
router.sendDigestIfDue = sendDigestIfDue;
router.setStaffLister = setStaffLister;

const tickMs = Number(process.env.EOD_TICK_MS) || 60000;
const timer = setInterval(() => { sendDigestIfDue().catch(e => console.error('[eod] digest failed:', e.message)); }, tickMs);
if(timer.unref) timer.unref();

module.exports = router;
