const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { type, plate, trackingProvider, trackingReference } = req.body;
  if(!type) return res.status(400).json({ error: 'type is required.' });

  const info = await db.prepare(`
    INSERT INTO vehicles (type, plate, tracking_provider, tracking_reference)
    VALUES (?, ?, ?, ?)
  `).run(type, plate || null, trackingProvider || null, trackingReference || null);

  res.status(201).json(await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM vehicles ORDER BY id ASC').all());
});

router.delete('/:id', requireSupabaseAuth(), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Vehicle not found.' });
  await db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
