const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');
const { geocodeAddress } = require('../lib/geocode');

const router = express.Router();

// Sep 23 2026, Geolocation Delivery System Phase 1 — a Destination
// Reference entry has only ever been a name + a manually-typed
// distance in km (fuel-cost math input, nothing more). Geocoding it
// on the way in turns the same list into real map pins, with zero
// change to how Bob actually uses the form: he still just types a
// destination name and a distance and hits Add — geocoding happens
// here, silently, in the background. Before GOOGLE_MAPS_SERVER_KEY is
// configured (or if this one address just doesn't resolve),
// geocodeAddress() returns null and the row saves exactly as it
// always did, with latitude/longitude simply left blank — never a
// reason to block adding the destination itself.
router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { name, distanceKm } = req.body;
  if(!name) return res.status(400).json({ error: 'name is required.' });

  const geo = await geocodeAddress(name);

  const info = await db.prepare(`
    INSERT INTO destinations (name, distance_km, latitude, longitude, formatted_address, geocoded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, distanceKm || null, geo?.latitude ?? null, geo?.longitude ?? null, geo?.formattedAddress ?? null, geo ? new Date().toISOString() : null);

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

// Backfill route — for the ~40 destinations already on the list
// (added back when no key existed, or from before this feature at
// all) so Bob doesn't have to delete and re-add every one by hand
// once GOOGLE_MAPS_SERVER_KEY is live. Only touches rows that are
// still missing a pin; already-geocoded rows are left untouched (no
// wasted, billed re-geocoding of the same address). Runs sequentially
// rather than in parallel — this list is small (tens, not thousands
// of rows) and Google's Geocoding API has a per-second rate limit
// that a burst of concurrent calls could trip.
router.post('/geocode-missing', requireSupabaseAuth(), async (req, res) => {
  const missing = await db.prepare('SELECT * FROM destinations WHERE latitude IS NULL ORDER BY id ASC').all();
  let geocoded = 0, failed = 0;
  for(const dest of missing) {
    const geo = await geocodeAddress(dest.name);
    if(geo) {
      await db.prepare(`
        UPDATE destinations SET latitude = ?, longitude = ?, formatted_address = ?, geocoded_at = ?
        WHERE id = ?
      `).run(geo.latitude, geo.longitude, geo.formattedAddress, new Date().toISOString(), dest.id);
      geocoded++;
    } else {
      failed++;
    }
  }
  res.json({ attempted: missing.length, geocoded, failed });
});

module.exports = router;
