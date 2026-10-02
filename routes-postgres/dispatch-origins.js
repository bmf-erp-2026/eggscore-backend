const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Dispatch Origins (Oct 2 2026) — a saved, reusable list of departure
// points for waybills, same spirit as Vehicles/Drivers below Destination
// Reference in Logistics. No geocoding here (unlike destinations.js) — a
// dispatch origin is only ever handed to /orders/cluster-distance as a
// plain address string, which geocodes it itself at calc time.

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { name, address } = req.body;
  if(!name || !address) return res.status(400).json({ error: 'name and address are required.' });

  const info = await db.prepare(`
    INSERT INTO dispatch_origins (name, address) VALUES (?, ?)
  `).run(name, address);

  res.status(201).json(await db.prepare('SELECT * FROM dispatch_origins WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM dispatch_origins ORDER BY id ASC').all());
});

router.delete('/:id', requireSupabaseAuth(), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM dispatch_origins WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Dispatch origin not found.' });
  await db.prepare('DELETE FROM dispatch_origins WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
