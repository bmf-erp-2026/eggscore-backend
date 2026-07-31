const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Read is open to either auth (ERP staff and the customer-facing portal
// both need to know the live price) — write is owner/staff-only, same
// as the batches write routes.
router.get('/selling-price', requireEitherAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'selling_price'").get();
  if(!row) return res.json({ price: null });
  res.json({ price: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});

router.patch('/selling-price', requireSupabaseAuth(), async (req, res) => {
  const { price, updatedBy } = req.body;
  if(typeof price !== 'number' || price <= 0) {
    return res.status(400).json({ error: 'price must be a positive number.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('selling_price', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(price), updatedBy || null);
  res.json({ ok: true, price });
});

// ERP-only — full loyaltySettings object (referral/feedback/communication/
// respect point values + level thresholds). Unlike selling-price, the
// portal never needs to read this directly — it's Bob's own internal
// configuration, consumed by the backend's own /loyalty endpoint
// server-side, and by the ERP for cross-device consistency (same
// reasoning as selling-price: set on whichever device is in front of
// someone, every other device needs to pick it up). Stored as a single
// JSON blob rather than exploded into columns — same generic-settings
// convention as selling-price, just a structured value instead of a
// single number.
router.get('/loyalty-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'loyalty_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});

router.patch('/loyalty-settings', requireSupabaseAuth(), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('loyalty_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

// ERP-only — full scorecardSettings object (credit-scorecard weights plus
// relationshipTagPoints, the only part the /loyalty endpoint actually
// needs). Same JSON-blob convention as loyalty-settings above.
router.get('/scorecard-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'scorecard_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});

router.patch('/scorecard-settings', requireSupabaseAuth(), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('scorecard_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

module.exports = router;
