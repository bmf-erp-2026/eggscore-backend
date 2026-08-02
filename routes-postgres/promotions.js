const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// ERP-only, same as suppliers — promotions are never portal-facing.
router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { name, segment, discount, minCrates, until, desc, created } = req.body;

  if(!name) {
    return res.status(400).json({ error: 'name is required.' });
  }

  const info = await db.prepare(`
    INSERT INTO promotions (name, segment, discount, min_crates, until, description, active, created)
    VALUES (?, ?, ?, ?, ?, ?, true, ?)
  `).run(name, segment || null, discount || 0, minCrates || 0, until || '—', desc || null, created || null);

  res.status(201).json(await db.prepare('SELECT * FROM promotions WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM promotions ORDER BY id DESC').all());
});

// Only ever used to flip active/expiredAt/expiredHow (auto-expiry engine
// or manual "End Promotion") — promotions aren't otherwise edited once
// created, but this stays a generic partial-update route like the others
// rather than a narrow expire-only endpoint, in case that changes later.
router.patch('/:id', requireSupabaseAuth(), async (req, res) => {
  const { active, expiredAt, expiredHow } = req.body;
  const existing = await db.prepare('SELECT * FROM promotions WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Promotion not found.' });

  const fields = [], values = [];
  if(active !== undefined)      { fields.push('active = ?');      values.push(active); }
  if(expiredAt !== undefined)   { fields.push('expired_at = ?');  values.push(expiredAt); }
  if(expiredHow !== undefined)  { fields.push('expired_how = ?'); values.push(expiredHow); }

  if(fields.length === 0) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.id);
  await db.prepare(`UPDATE promotions SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  res.json(await db.prepare('SELECT * FROM promotions WHERE id = ?').get(req.params.id));
});

module.exports = router;
