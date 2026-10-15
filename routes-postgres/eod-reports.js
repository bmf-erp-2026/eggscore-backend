const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');
const hours = require('../lib/staff-hours');
const push = require('../lib/push');
const attendance = require('./attendance');

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
function cleanReport(b, issueLog) {
  b = b || {};
  issueLog = Array.isArray(issueLog) ? issueLog : [];
  const f = b.figures || {};
  const data = {
    v: 1,
    figures: {
      salesCount: num(f.salesCount, 100000), cratesSold: num(f.cratesSold, 10000000), salesValue: num(f.salesValue, 1e12),
      paymentsCount: num(f.paymentsCount, 100000), paymentsTotal: num(f.paymentsTotal, 1e12),
      openOrders: num(f.openOrders, 100000), unreadMessages: num(f.unreadMessages, 100000),
      owedToday: num(f.owedToday, 1e12), awaitingReply: num(f.awaitingReply, 100000),
    },
    accurate: b.accurate === true,
    cashHandover: ['yes', 'no', 'none'].includes(b.cashHandover) ? b.cashHandover : '',
    cashNote: txt(b.cashNote, 300),
    damagedCrates: num(b.damagedCrates, 100000),
    noIssues: b.noIssues === true,
    issues: composeIssues(issueLog, txt(b.issues, 1500)),
    issueLog: issueLog.map(e => ({ at: e.at, text: e.text })),
    lookahead: txt(b.lookahead, 1500),
    other: txt(b.other, 1500),
  };
  const errors = [];
  if(!data.accurate) errors.push('Tick "These figures are accurate" (or correct them in Issues first).');
  if(!data.cashHandover) errors.push('Say what happened to the cash and transfers collected today.');
  if(data.cashHandover === 'no' && !data.cashNote) errors.push('Explain where the cash is now.');
  if(data.noIssues && issueLog.length) errors.push('You logged ' + issueLog.length + ' issue' + (issueLog.length === 1 ? '' : 's') + ' today. Untick "No issues today".');
  if(!data.noIssues && !data.issues) errors.push('Describe the issues, or tick "No issues today".');
  return { data, errors };
}


// ── Oct 13 2026 — drafts and the issue log ──
// A staff member can write an issue down the moment it happens (a timestamped entry that is saved at once)
// and can save the half-finished form. Both live in eod_drafts until the report is filed; filing folds the
// logged issues into the report's Issues section and deletes the draft.
const hhmm = iso => { const l = lagos(Date.parse(iso)); return String(l.getUTCHours()).padStart(2, '0') + ':' + String(l.getUTCMinutes()).padStart(2, '0'); };
function composeIssues(log, freeText) {
  const lines = (log || []).map(e => '[' + hhmm(e.at) + '] ' + e.text);
  return [...lines, freeText].filter(Boolean).join('\n').slice(0, 4000);
}
const MAX_LOG = 30;
function cleanDraft(b, keepLog) {
  b = b || {};
  return {
    v: 1,
    cashHandover: ['yes', 'no', 'none'].includes(b.cashHandover) ? b.cashHandover : '',
    cashNote: txt(b.cashNote, 300),
    damagedCrates: num(b.damagedCrates, 100000),
    noIssues: b.noIssues === true,
    issues: txt(b.issues, 1500),
    lookahead: txt(b.lookahead, 1500),
    other: txt(b.other, 1500),
    issueLog: keepLog || [],
  };
}
const draftOut = r => r ? ({ updatedAt: new Date(r.updated_at).toISOString(), ...(typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {})) }) : null;
async function getDraft(email, day) { return db.prepare('SELECT * FROM eod_drafts WHERE email = ? AND day = ?').get(email, day); }
async function saveDraft(email, name, day, data) {
  await db.prepare(`INSERT INTO eod_drafts (day, email, name, data, updated_at) VALUES (?, ?, ?, ?::jsonb, now())
    ON CONFLICT (email, day) DO UPDATE SET data = EXCLUDED.data, name = EXCLUDED.name, updated_at = now()`)
    .run(day, email, name, JSON.stringify(data));
  return draftOut(await getDraft(email, day));
}
async function staffName(email) {
  const staff = (await expectedStaff().catch(() => [])).find(s => s.email === email);
  return (staff && staff.name) || email.split('@')[0];
}
// shared checks for the three draft routes
async function draftContext(req, res) {
  if(req.user.role === 'owner') { res.status(403).json({ error: 'The Owner does not file End-of-Day reports.' }); return null; }
  const ms = hours.clock();
  if(!isWorkingDay(ms)) { res.status(400).json({ error: 'There is no End-of-Day report on Sundays.' }); return null; }
  const day = hours.ymd(ms), email = hours.norm(req.user.email);
  const filed = await db.prepare("SELECT id FROM eod_reports WHERE email = ? AND day = ? AND status <> 'excused'").get(email, day);
  if(filed) { res.status(409).json({ error: 'Today\'s report is already filed. Edit it and update it instead.' }); return null; }
  return { ms, day, email };
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
  const draft = (row && row.status !== 'excused') ? null : draftOut(await getDraft(email, day));
  res.json({
    day, role: req.user.role, exempt: req.user.role === 'owner',
    workingDay: isWorkingDay(ms), dueBy: '18:00',
    filed: !!row && row.status !== 'excused', report: row ? rowOut(row) : null, draft,
  });
});

// Staff: save the form as it stands (no required fields). Keeps the logged issues as they are.
router.put('/me/draft', requireSupabaseAuth(), async (req, res) => {
  const c = await draftContext(req, res); if(!c) return;
  // the logged issues are never touched here (kept by the database itself, so a save-draft and a save-issue arriving together cannot overwrite each other)
  const data = cleanDraft(req.body, []);   // issueLog [] only matters for a brand-new row; an existing row keeps its own (see below)
  await db.prepare(`INSERT INTO eod_drafts (day, email, name, data, updated_at) VALUES (?, ?, ?, ?::jsonb, now())
    ON CONFLICT (email, day) DO UPDATE SET data = EXCLUDED.data || jsonb_build_object('issueLog', COALESCE(eod_drafts.data->'issueLog', '[]'::jsonb)),
      name = EXCLUDED.name, updated_at = now()`).run(c.day, c.email, await staffName(c.email), JSON.stringify(data));
  res.json({ day: c.day, draft: draftOut(await getDraft(c.email, c.day)) });
});
// Staff: write one issue down now. Timestamped by the server clock; saved immediately.
router.post('/me/issue', requireSupabaseAuth(), async (req, res) => {
  const c = await draftContext(req, res); if(!c) return;
  const text = txt(req.body && req.body.text, 600);
  if(!text) return res.status(400).json({ error: 'Type the issue first.' });
  const cur0 = draftOut(await getDraft(c.email, c.day));
  if(cur0 && Array.isArray(cur0.issueLog) && cur0.issueLog.length >= MAX_LOG) return res.status(400).json({ error: 'That is the most issues one day can hold. Put the rest in the report.' });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entry = { id, at: new Date(c.ms).toISOString(), text };
  const blank = cleanDraft({}, []);
  blank.issueLog = [entry];
  await db.prepare(`INSERT INTO eod_drafts (day, email, name, data, updated_at) VALUES (?, ?, ?, ?::jsonb, now())
    ON CONFLICT (email, day) DO UPDATE SET
      data = jsonb_set(eod_drafts.data, '{issueLog}', COALESCE(eod_drafts.data->'issueLog', '[]'::jsonb) || ?::jsonb) || '{"noIssues": false}'::jsonb,
      updated_at = now()`).run(c.day, c.email, await staffName(c.email), JSON.stringify(blank), JSON.stringify([entry]));
  res.status(201).json({ day: c.day, draft: draftOut(await getDraft(c.email, c.day)) });
});
router.delete('/me/issue/:id', requireSupabaseAuth(), async (req, res) => {
  const c = await draftContext(req, res); if(!c) return;
  const cur = draftOut(await getDraft(c.email, c.day));
  if(!cur) return res.json({ day: c.day, draft: null });
  const base = { ...cur }; delete base.updatedAt;
  base.issueLog = (cur.issueLog || []).filter(e => e.id !== String(req.params.id));
  res.json({ day: c.day, draft: await saveDraft(c.email, await staffName(c.email), c.day, base) });
});

// Staff: file or update today's report
router.post('/me', requireSupabaseAuth(), async (req, res) => {
  if(req.user.role === 'owner') return res.status(403).json({ error: 'The Owner does not file End-of-Day reports.' });
  const ms = hours.clock();
  if(!isWorkingDay(ms)) return res.status(400).json({ error: 'There is no End-of-Day report on Sundays.' });
  const day = hours.ymd(ms);
  const email = hours.norm(req.user.email);
  const draftRow = await getDraft(email, day);
  const draftLog = draftRow ? (draftOut(draftRow).issueLog || []) : [];
  const { data, errors } = cleanReport(req.body, draftLog);
  if(errors.length) return res.status(400).json({ error: errors[0], errors });
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
  await db.prepare('DELETE FROM eod_drafts WHERE email = ? AND day = ?').run(email, day);
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
  // Oct 13 2026 — what each person has saved but not filed (issues logged during the day, the half-filled form)
  try {
    const drafts = await db.prepare('SELECT * FROM eod_drafts WHERE day = ?').all(day);
    const byEmail = new Map(drafts.map(d => [d.email, draftOut(d)]));
    out.forEach(r => {
      const d = byEmail.get(r.email);
      const filed = r.status === 'on_time' || r.status === 'late';
      r.draft = (!filed && d && ((d.issueLog && d.issueLog.length) || d.issues || d.lookahead || d.other || d.cashHandover)) ? d : null;
    });
  } catch(e) { console.error('[eod] draft lookup failed:', e.message); }
  // Oct 13 2026 — clock-in / clock-out beside each person (null = never signed in that day)
  let att = new Map();
  try { att = await attendance.forDay(day, nowMs); } catch(e) { console.error('[eod] attendance lookup failed:', e.message); }
  out.forEach(r => { r.attendance = att.get(r.email) || null; });
  // Someone who filed but is not in the expected list (role changed since) still shows.
  const order = { missing: 0, pending: 1, late: 2, on_time: 3, excused: 4 };
  out.sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
  const count = s => out.filter(r => r.status === s).length;
  const expected = out.filter(r => r.status !== 'excused').length;
  return {
    day, workingDay: working, closed,
    attendance: { signedIn: out.filter(r => r.attendance).length, lateArrivals: out.filter(r => r.attendance && r.attendance.late).length, afterHours: out.filter(r => r.attendance && r.attendance.afterHours).length, lateAfter: '08:00' },
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
router.composeIssues = composeIssues;
router.setStaffLister = setStaffLister;

const tickMs = Number(process.env.EOD_TICK_MS) || 60000;
const timer = setInterval(() => { sendDigestIfDue().catch(e => console.error('[eod] digest failed:', e.message)); }, tickMs);
if(timer.unref) timer.unref();

module.exports = router;
