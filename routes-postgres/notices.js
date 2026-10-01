const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');

const router = express.Router();

// Command Centre Notice Board (Oct 1 2026) — an owner-authored, all-staff-
// visible board for things worth remembering but not acting on today
// (e.g. "revisit the Google Ads $300 credit once we're doing serious
// volume"). Read access is any logged-in staff member — the whole point
// is that reps see it too, not just Bob — but every write is owner-only,
// same split as suppliers.js/promotions.js: a rep can look, only an
// owner can post, edit, or dismiss.

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM command_centre_notices ORDER BY created_at DESC').all());
});

router.post('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { title, note, category, link, revisit } = req.body;

  if(!title || !note) {
    return res.status(400).json({ error: 'title and note are required.' });
  }

  const info = await db.prepare(`
    INSERT INTO command_centre_notices (title, note, category, link, revisit, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `).run(title, note, category || null, link || null, revisit || null, req.user?.email || null);

  res.status(201).json(await db.prepare('SELECT * FROM command_centre_notices WHERE id = ?').get(info.lastInsertRowid));
});

// Generic partial update, same shape as promotions.js's PATCH — covers
// both an edit (title/note/category/link/revisit) and a dismiss
// (status:'dismissed') through one route rather than two, since neither
// is a high-stakes enough action to need separating.
router.patch('/:id', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { title, note, category, link, revisit, status } = req.body;
  const existing = await db.prepare('SELECT * FROM command_centre_notices WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Notice not found.' });

  const fields = [], values = [];
  if(title    !== undefined) { fields.push('title = ?');    values.push(title); }
  if(note     !== undefined) { fields.push('note = ?');     values.push(note); }
  if(category !== undefined) { fields.push('category = ?'); values.push(category); }
  if(link     !== undefined) { fields.push('link = ?');     values.push(link); }
  if(revisit  !== undefined) { fields.push('revisit = ?');  values.push(revisit); }
  if(status   !== undefined) {
    fields.push('status = ?'); values.push(status);
    if(status === 'dismissed') fields.push('dismissed_at = now()');
  }

  if(fields.length === 0) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.id);
  await db.prepare(`UPDATE command_centre_notices SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  res.json(await db.prepare('SELECT * FROM command_centre_notices WHERE id = ?').get(req.params.id));
});

module.exports = router;
