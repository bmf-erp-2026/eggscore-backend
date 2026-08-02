const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { name, distanceKm } = req.body;
  if(!name) return res.status(400).json({ error: 'name is required.' });

  const info = await db.prepare(`
    INSERT INTO destinations (name, distance_km)
    VALUES (?, ?)
  `).run(name, distanceKm || null);

  res.status(201).json(await db.prepare('SELECT * FROM destinations WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM destinations ORDER BY id ASC').all());
});

router.delete('/:id', requireSupabaseAuth(), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM destinations WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Destination not found.' });
  await db.prepare('DELETE FROM destinations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
