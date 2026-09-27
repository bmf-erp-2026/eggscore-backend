const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Sep 27 2026 — Preferred Delivery Day architecture, mirrors
// routes-postgres/service-areas.js exactly (same reasons: staff grow/shrink
// the list from the ERP instead of a hardcoded array in famad-order.html).
//
// A delivery day is just a plain weekday name ("Wednesday", "Saturday") —
// no address, no coordinates, never linked to a specific order or customer.
// Bob's instruction was explicit: don't hardcode which days the fleet runs,
// because that will change as demand grows. This table is the single source
// of truth for "which days can a customer pick," both in the ERP admin
// panel and on the customer-facing portal.
//
// GET /public is unauthenticated on purpose, same as service-areas — the
// portal has no staff login, only its x-api-key, so this route must answer
// without requireSupabaseAuth() or it silently falls back to whatever
// FALLBACK_DELIVERY_DAYS is hardcoded to in famad-order.html.

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { name } = req.body;
  if(!name || !name.trim()) return res.status(400).json({ error: 'name is required.' });

  const info = await db.prepare(`
    INSERT INTO delivery_days (name, active) VALUES (?, true)
  `).run(name.trim());

  res.status(201).json(await db.prepare('SELECT * FROM delivery_days WHERE id = ?').get(info.lastInsertRowid));
});

// Staff view — every day, active or not, so the ERP can list & toggle.
router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM delivery_days ORDER BY id ASC').all());
});

router.patch('/:id', requireSupabaseAuth(), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM delivery_days WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Delivery day not found.' });

  const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim() : existing.name;
  const active = typeof req.body.active === 'boolean' ? req.body.active : existing.active;

  await db.prepare('UPDATE delivery_days SET name = ?, active = ? WHERE id = ?').run(name, active, req.params.id);
  res.json(await db.prepare('SELECT * FROM delivery_days WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireSupabaseAuth(), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM delivery_days WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Delivery day not found.' });
  await db.prepare('DELETE FROM delivery_days WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// PUBLIC — no auth gate, reachable by anyone, same as any other static
// asset on the portal. Bare minimum: plain name strings for days staff have
// switched on, in display order (id order — the order they were added).
router.get('/public', async (req, res) => {
  const rows = await db.prepare('SELECT name FROM delivery_days WHERE active = true ORDER BY id ASC').all();
  res.json(rows.map(r => r.name));
});

module.exports = router;
