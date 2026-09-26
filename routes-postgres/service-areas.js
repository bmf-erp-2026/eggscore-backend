const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Sep 26 2026 — Coverage Card architecture, so Bob/staff can grow the
// "Where We Deliver" list from the ERP (type a name, hit Add, flip a
// switch) instead of editing a JS array inside famad-order.html by hand
// every time coverage widens. This is a DIFFERENT kind of data from
// Destination Reference and deliberately lives in its own table:
//
//   - A service area is just a plain name — "Woji", "Elelenwa", a
//     corridor or LGA. There is no address field, no latitude/longitude
//     column, and geocodeAddress() is never called anywhere in this file.
//   - It is never linked to a Destination Reference row, an order, or a
//     customer record — adding, renaming, or removing one here cannot
//     expose or affect anyone's real delivery point.
//   - The `active` flag below is what the old, retired
//     `show_on_customer_map` flag on `destinations` was trying and
//     failing to be: here it's safe to let staff flip it, because
//     flipping it only ever reveals a district name, never a coordinate
//     or an address. See migration-retire-customer-map-flag.sql and the
//     Sep 26 2026 policy note in destinations.js for why that one couldn't
//     be salvaged and had to be removed outright instead.
//
// GET /public is the one anonymous route here — same requireSupabaseAuth()
// gate (accepts the portal's x-api-key) the rest of this app's read
// routes already use — and it returns nothing but an array of plain
// strings for areas marked active. No id, no timestamp, no coordinate.

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { name } = req.body;
  if(!name || !name.trim()) return res.status(400).json({ error: 'name is required.' });

  const info = await db.prepare(`
    INSERT INTO service_areas (name, active) VALUES (?, true)
  `).run(name.trim());

  res.status(201).json(await db.prepare('SELECT * FROM service_areas WHERE id = ?').get(info.lastInsertRowid));
});

// Staff view — every area, active or not, so the ERP can list & toggle.
router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM service_areas ORDER BY id ASC').all());
});

router.patch('/:id', requireSupabaseAuth(), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM service_areas WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Service area not found.' });

  const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim() : existing.name;
  const active = typeof req.body.active === 'boolean' ? req.body.active : existing.active;

  await db.prepare('UPDATE service_areas SET name = ?, active = ? WHERE id = ?').run(name, active, req.params.id);
  res.json(await db.prepare('SELECT * FROM service_areas WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireSupabaseAuth(), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM service_areas WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Service area not found.' });
  await db.prepare('DELETE FROM service_areas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// PUBLIC — reachable by the customer portal's x-api-key. Deliberately the
// bare minimum: an array of plain name strings for areas staff have
// switched on, in display order, nothing else attached.
router.get('/public', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT name FROM service_areas WHERE active = true ORDER BY id ASC').all();
  res.json(rows.map(r => r.name));
});

module.exports = router;
