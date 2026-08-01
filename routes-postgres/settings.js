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

/* ═══════════════════════════════════════════════════════
   PHASE 2E — local-only settings migration
   All 13 keys below are ERP-only (requireSupabaseAuth on
   both read and write — none of these are portal-facing,
   unlike selling-price). Same generic-settings convention:
   INSERT ... ON CONFLICT (key) DO UPDATE.
═══════════════════════════════════════════════════════ */

// Pricing guardrails — kept as 4 SEPARATE keys rather than one bundled
// object. The 4 ERP save functions (savePriceWatchThreshold,
// saveStopLossCeiling, saveFloor, saveTargetMargin) fire independently
// today, each on its own field — bundling would force a fetch-merge-PATCH
// on every single-field save, or risk one device's edit clobbering
// another's untouched fields. Separate keys match the existing
// independent-save behavior exactly, same as selling-price.
router.get('/price-watch-threshold', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'price_watch_threshold'").get();
  if(!row) return res.json({ threshold: null });
  res.json({ threshold: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/price-watch-threshold', requireSupabaseAuth(), async (req, res) => {
  const { threshold, updatedBy } = req.body;
  if(typeof threshold !== 'number' || threshold < 0) {
    return res.status(400).json({ error: 'threshold must be a non-negative number.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('price_watch_threshold', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(threshold), updatedBy || null);
  res.json({ ok: true, threshold });
});

router.get('/stop-loss-ceiling', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'stop_loss_ceiling'").get();
  if(!row) return res.json({ ceiling: null });
  res.json({ ceiling: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/stop-loss-ceiling', requireSupabaseAuth(), async (req, res) => {
  const { ceiling, updatedBy } = req.body;
  if(typeof ceiling !== 'number' || ceiling < 0) {
    return res.status(400).json({ error: 'ceiling must be a non-negative number.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('stop_loss_ceiling', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(ceiling), updatedBy || null);
  res.json({ ok: true, ceiling });
});

router.get('/price-floor', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'price_floor'").get();
  if(!row) return res.json({ floor: null });
  res.json({ floor: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/price-floor', requireSupabaseAuth(), async (req, res) => {
  const { floor, updatedBy } = req.body;
  if(typeof floor !== 'number' || floor < 0) {
    return res.status(400).json({ error: 'floor must be a non-negative number.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('price_floor', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(floor), updatedBy || null);
  res.json({ ok: true, floor });
});

router.get('/target-margin', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'target_margin'").get();
  if(!row) return res.json({ margin: null });
  res.json({ margin: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/target-margin', requireSupabaseAuth(), async (req, res) => {
  const { margin, updatedBy } = req.body;
  if(typeof margin !== 'number' || margin < 0) {
    return res.status(400).json({ error: 'margin must be a non-negative number.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('target_margin', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(margin), updatedBy || null);
  res.json({ ok: true, margin });
});

// Hold windows — full tier→{warn,decide} object (STATE.holdWindows), one
// JSON blob, same convention as loyalty-settings.
router.get('/hold-windows', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'hold_windows'").get();
  if(!row) return res.json({ windows: null });
  res.json({ windows: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/hold-windows', requireSupabaseAuth(), async (req, res) => {
  const { windows, updatedBy } = req.body;
  if(!windows || typeof windows !== 'object') {
    return res.status(400).json({ error: 'windows object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('hold_windows', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(windows), updatedBy || null);
  res.json({ ok: true, windows });
});

// Market reference THRESHOLDS only (ceilingPct/floorPct) — NOT the
// current reference price itself, which also appends to
// marketReferenceHistory[] and is out of scope for this migration pass.
router.get('/market-reference-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'market_reference_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/market-reference-settings', requireSupabaseAuth(), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('market_reference_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

router.get('/supplier-scorecard-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'supplier_scorecard_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/supplier-scorecard-settings', requireSupabaseAuth(), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('supplier_scorecard_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

router.get('/abuse-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'abuse_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/abuse-settings', requireSupabaseAuth(), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('abuse_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

router.get('/reservation-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'reservation_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/reservation-settings', requireSupabaseAuth(), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('reservation_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

router.get('/logistics-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'logistics_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/logistics-settings', requireSupabaseAuth(), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('logistics_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

router.get('/procurement-reminder-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'procurement_reminder_settings'").get();
  if(!row) return res.json({ threshold: null });
  const parsed = JSON.parse(row.value);
  res.json({ threshold: parsed.largeVolumeThreshold, updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/procurement-reminder-settings', requireSupabaseAuth(), async (req, res) => {
  const { threshold, updatedBy } = req.body;
  if(typeof threshold !== 'number' || threshold <= 0) {
    return res.status(400).json({ error: 'threshold must be a positive number.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('procurement_reminder_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify({ largeVolumeThreshold: threshold }), updatedBy || null);
  res.json({ ok: true, threshold });
});

router.get('/branding-readiness-settings', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'branding_readiness_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/branding-readiness-settings', requireSupabaseAuth(), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('branding_readiness_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

router.get('/time-value-rate', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'time_value_rate'").get();
  if(!row) return res.json({ rate: null });
  res.json({ rate: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/time-value-rate', requireSupabaseAuth(), async (req, res) => {
  const { rate, updatedBy } = req.body;
  if(typeof rate !== 'number' || rate < 0.25 || rate > 0.30) {
    return res.status(400).json({ error: 'rate must be between 0.25 and 0.30.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('time_value_rate', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(rate), updatedBy || null);
  res.json({ ok: true, rate });
});

// Owner PIN — hash and recovery hash only, NEVER plaintext (matches the
// ERP's own client-side handling: submitChangePin() hashes before this
// route is ever called and explicitly nulls any legacy plaintext).
// lockoutUntil syncs too (deliberate decision — closes the gap where a
// lockout on one device wouldn't stop a retry on another).
router.get('/owner-pin', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'owner_pin'").get();
  if(!row) return res.json({ pin: null });
  res.json({ pin: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/owner-pin', requireSupabaseAuth(), async (req, res) => {
  const { pin, updatedBy } = req.body;
  if(!pin || typeof pin !== 'object' || !pin.hash) {
    return res.status(400).json({ error: 'pin object with hash is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('owner_pin', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(pin), updatedBy || null);
  res.json({ ok: true });
});

module.exports = router;
