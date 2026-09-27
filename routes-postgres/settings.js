const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth, requireRole } = require('../auth.postgres');

const router = express.Router();

// Read is open to either auth (ERP staff and the customer-facing portal
// both need to know the live price) — write is owner-only (Sep 1 2026,
// Sales Rep Access), same as every other route in this file.
router.get('/selling-price', requireEitherAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'selling_price'").get();
  if(!row) return res.json({ price: null });
  res.json({ price: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});

router.patch('/selling-price', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

// Sep 27 2026 — the "small sync route" for the special-volume crate
// threshold (Preferred Delivery Day feature). Exact same shape as
// selling-price above: a single number the portal needs to read (to decide
// whether an order qualifies for any-day delivery) and only the owner can
// change. Before this route existed, the ERP's Logistics settings panel
// saved this number locally only — famad-order.html carried its own,
// separately-hardcoded copy (SPECIAL_VOLUME_THRESHOLD_CRATES = 250) that
// had no way to learn about a change made in the ERP. Same class of bug as
// the Time-Value rate/band mismatch just above; fixed the same way, by
// giving the two sides one real source of truth to read from.
router.get('/special-volume-threshold', requireEitherAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'special_volume_threshold_crates'").get();
  if(!row) return res.json({ crates: null });
  res.json({ crates: parseInt(row.value, 10), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/special-volume-threshold', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { crates, updatedBy } = req.body;
  if(!Number.isInteger(crates) || crates < 1) {
    return res.status(400).json({ error: 'crates must be a whole number, 1 or more.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('special_volume_threshold_crates', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(crates), updatedBy || null);
  res.json({ ok: true, crates });
});

// Read is open to either auth, same reasoning and same pattern as
// selling-price above — order policies are published content shown
// directly to customers on the portal (each one adhered to earns bonus
// respect points), not internal configuration, so the portal's own
// shared key needs to read this too, not just ERP staff of any role.
// Write is owner-only — changing what's published to customers is a
// business decision. Added Sep 4 2026: this route was referenced by
// the ERP client (syncOrderPoliciesFromBackend()) but had never
// actually been built — a genuine pre-existing gap, unrelated to the
// Sales Rep Access work, caught via a live 404 in the console.
router.get('/order-policies', requireEitherAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'order_policies'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});

router.patch('/order-policies', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('order_policies', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
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
router.get('/loyalty-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'loyalty_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});

router.patch('/loyalty-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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
router.get('/scorecard-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'scorecard_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});

router.patch('/scorecard-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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
router.get('/price-watch-threshold', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'price_watch_threshold'").get();
  if(!row) return res.json({ threshold: null });
  res.json({ threshold: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/price-watch-threshold', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/stop-loss-ceiling', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'stop_loss_ceiling'").get();
  if(!row) return res.json({ ceiling: null });
  res.json({ ceiling: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/stop-loss-ceiling', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/price-floor', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'price_floor'").get();
  if(!row) return res.json({ floor: null });
  res.json({ floor: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/price-floor', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/target-margin', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'target_margin'").get();
  if(!row) return res.json({ margin: null });
  res.json({ margin: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/target-margin', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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
router.get('/hold-windows', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'hold_windows'").get();
  if(!row) return res.json({ windows: null });
  res.json({ windows: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/hold-windows', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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
router.get('/market-reference-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'market_reference_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/market-reference-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/supplier-scorecard-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'supplier_scorecard_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/supplier-scorecard-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/abuse-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'abuse_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/abuse-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/reservation-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'reservation_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/reservation-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/logistics-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'logistics_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/logistics-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/procurement-reminder-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'procurement_reminder_settings'").get();
  if(!row) return res.json({ threshold: null });
  const parsed = JSON.parse(row.value);
  res.json({ threshold: parsed.largeVolumeThreshold, updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/procurement-reminder-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

router.get('/branding-readiness-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'branding_readiness_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/branding-readiness-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

// Sep 27 2026 fix — real production bug. The rate PATCH below used to
// hardcode "rate must be between 0.25 and 0.30" as a literal, left over
// from before the Time-Value band became owner-editable in the ERP
// (saveTimeValueRateBand() in famad-erp.html). That band change only ever
// touched STATE.timeValueRateBand client-side — nothing told THIS route
// the valid range had moved. Result: an owner could shrink the band to
// 20%-25% in the ERP, set the rate to 23.5%, see it save and even show up
// correctly in the on-screen Rate Change History (all of that is client-
// side) — but postTimeValueRateToBackend()'s PATCH silently got rejected
// by this now-stale 0.25-0.30 check, the backend's stored value never
// moved, and the next page refresh (which pulls FROM the backend via
// syncTimeValueRateFromBackend()) overwrote the correct 23.5% with the
// old, now out-of-band 25%. Exactly the "two hardcoded copies of the same
// number disagree" bug this whole Time-Value rework was meant to retire —
// it just had a second copy here, in a file the ERP work never touched.
//
// Fix: the band itself now lives here too (time_value_rate_band, right
// below) as the actual single source of truth, and this route reads it
// instead of a literal. TIME_VALUE_RATE_DEFAULT_BAND is only the seed for
// an install that predates this fix and has never synced a band yet —
// once one is set, it's used from here on.
const TIME_VALUE_RATE_DEFAULT_BAND = { min: 0.25, max: 0.30 };
async function getTimeValueRateBandRow() {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'time_value_rate_band'").get();
  if(!row) return TIME_VALUE_RATE_DEFAULT_BAND;
  try {
    const parsed = JSON.parse(row.value);
    if(typeof parsed?.min === 'number' && typeof parsed?.max === 'number') return parsed;
  } catch(parseErr) {}
  return TIME_VALUE_RATE_DEFAULT_BAND;
}

router.get('/time-value-rate', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'time_value_rate'").get();
  if(!row) return res.json({ rate: null });
  res.json({ rate: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/time-value-rate', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { rate, updatedBy } = req.body;
  const band = await getTimeValueRateBandRow();
  if(typeof rate !== 'number' || rate < band.min || rate > band.max) {
    return res.status(400).json({ error: `rate must be between ${band.min} and ${band.max} (the current band).` });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('time_value_rate', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(rate), updatedBy || null);
  res.json({ ok: true, rate });
});

// The band itself — GET/PATCH mirror every other JSON-blob setting in this
// file. Owner-only both ways, same as the rate above; the portal never
// needs this, only the ERP's own Time-Value panel.
router.get('/time-value-rate-band', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const band = await getTimeValueRateBandRow();
  res.json({ band });
});
router.patch('/time-value-rate-band', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { min, max, updatedBy } = req.body;
  if(typeof min !== 'number' || typeof max !== 'number' || min < 0 || max <= 0 || min >= max || max > 1) {
    return res.status(400).json({ error: 'min/max must be numbers, 0 <= min < max <= 1 (fractions, e.g. 0.20 for 20%).' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('time_value_rate_band', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify({ min, max }), updatedBy || null);
  res.json({ ok: true, band: { min, max } });
});

// Owner PIN — hash and recovery hash only, NEVER plaintext (matches the
// ERP's own client-side handling: submitChangePin() hashes before this
// route is ever called and explicitly nulls any legacy plaintext).
// lockoutUntil syncs too (deliberate decision — closes the gap where a
// lockout on one device wouldn't stop a retry on another).
router.get('/owner-pin', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'owner_pin'").get();
  if(!row) return res.json({ pin: null });
  res.json({ pin: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/owner-pin', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
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

// Distribution pricing — added after the fact, found during Phase 2E
// verification (missed in the original 15-area audit, same local-only
// category as the other 13). 6-field singleton object.
router.get('/distribution-pricing-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'distribution_pricing_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/distribution-pricing-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('distribution_pricing_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

// Price ramp (daily step %), commission tier structure, and shipper
// details — 3 more genuine singleton gaps found during Phase 2E
// verification (commission tiers was actually the original audit
// trigger, dropped somewhere along the way; ramp step and shipper
// details are new finds). Same pattern as everything above.
router.get('/price-ramp-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'price_ramp_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/price-ramp-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('price_ramp_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

router.get('/commission-tier-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'commission_tier_settings'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/commission-tier-settings', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('commission_tier_settings', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

router.get('/shipper-details', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'shipper_details'").get();
  if(!row) return res.json({ settings: null });
  res.json({ settings: JSON.parse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});
router.patch('/shipper-details', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { settings, updatedBy } = req.body;
  if(!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('shipper_details', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(JSON.stringify(settings), updatedBy || null);
  res.json({ ok: true, settings });
});

module.exports = router;
