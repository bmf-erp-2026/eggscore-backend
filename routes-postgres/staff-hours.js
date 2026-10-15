const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');
const hours = require('../lib/staff-hours');

const router = express.Router();

// Oct 12 2026 — staff working hours. The server refuses staff requests outside Mon-Sat
// 06:00-18:30 Lagos time (see lib/staff-hours.js, mounted in server.postgres.js). These routes
// tell the ERP where things stand, and let the Owner allow one person to work late for one day.

// Any signed-in person: "may I be in right now, and when does the day close?"
// Reachable even when closed (the guard exempts this path) so the ERP can explain the lock.
router.get('/status', requireSupabaseAuth(), async (req, res) => {
  const role = req.user.role;
  const w = hours.windowStatus();
  const ex = role === 'owner' ? null : await hours.exceptionFor(req.user.email);
  const exception = !!ex;
  res.json({ ...w, role, exception, exceptionUntil: ex ? new Date(ex.untilAt).toISOString() : null, allowed: role === 'owner' || w.open || exception });
});

// ── Owner only: one-day exceptions ──
const ownerOnly = [requireSupabaseAuth(), requireRole('owner')];

router.get('/exceptions', ...ownerOnly, async (req, res) => {
  let rows;
  try { rows = await db.prepare('SELECT id, email, note, granted_by, created_at, until_min FROM staff_hours_exceptions WHERE day = ? ORDER BY id DESC').all(hours.ymd(hours.clock())); }
  catch(e) { rows = await db.prepare('SELECT id, email, note, granted_by, created_at FROM staff_hours_exceptions WHERE day = ? ORDER BY id DESC').all(hours.ymd(hours.clock())); }
  res.json(rows.map(r => ({ id: Number(r.id), email: r.email, note: r.note || '', grantedBy: r.granted_by || '', at: new Date(r.created_at).toISOString(), until: hours.fmtMin(r.until_min == null ? 24 * 60 - 1 : Number(r.until_min)) })));
});

router.post('/exceptions', ...ownerOnly, async (req, res) => {
  const email = hours.norm(req.body && req.body.email);
  const note = String((req.body && req.body.note) || '').trim().slice(0, 140);
  if(!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter the staff member\'s sign-in email address.' });
  const untilMin = hours.parseUntil(req.body && req.body.until);
  const day = hours.ymd(hours.clock());
  try {
    await db.prepare(`INSERT INTO staff_hours_exceptions (email, day, note, granted_by, until_min) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email, day) DO UPDATE SET note = EXCLUDED.note, granted_by = EXCLUDED.granted_by, until_min = EXCLUDED.until_min`)
      .run(email, day, note || null, req.user.email || null, untilMin);
  } catch(e) {   // until_min column not added yet: save the old way (until midnight)
    await db.prepare(`INSERT INTO staff_hours_exceptions (email, day, note, granted_by) VALUES (?, ?, ?, ?) ON CONFLICT (email, day) DO UPDATE SET note = EXCLUDED.note, granted_by = EXCLUDED.granted_by`)
      .run(email, day, note || null, req.user.email || null);
  }
  console.log(`[audit] After-hours exception for ${email} (${day}) until ${hours.fmtMin(untilMin)} granted by ${req.user.email}`);
  let row;
  try { row = await db.prepare('SELECT id, email, note, granted_by, created_at, until_min FROM staff_hours_exceptions WHERE email = ? AND day = ?').get(email, day); }
  catch(e) { row = await db.prepare('SELECT id, email, note, granted_by, created_at FROM staff_hours_exceptions WHERE email = ? AND day = ?').get(email, day); }
  res.status(201).json({ id: Number(row.id), email: row.email, note: row.note || '', grantedBy: row.granted_by || '', at: new Date(row.created_at).toISOString(), until: hours.fmtMin(row.until_min == null ? 24 * 60 - 1 : Number(row.until_min)) });
});

router.delete('/exceptions/:id', ...ownerOnly, async (req, res) => {
  const id = Number(req.params.id);
  if(!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });
  const r = await db.prepare('DELETE FROM staff_hours_exceptions WHERE id = ?').run(id);
  console.log(`[audit] After-hours exception ${id} revoked by ${req.user.email}`);
  res.json({ ok: true, removed: r.changes || 0 });
});

module.exports = router;
