const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth } = require('../auth.postgres');
const pc = require('../lib/portal-checks');

const router = express.Router();

// GET /portal-config (Oct 10 2026)
//
// One safe, read-only page of everything a customer's phone needs to show
// the right price, promotions, policies and limits. Before this, the portal
// looked for these in its own browser storage (which a customer's phone does
// not have) and quietly used built-in defaults instead.
//
// What is deliberately NOT here: your margin floor, target margin and
// costs. Selling price minus target margin would reveal your cost, and this
// route is reachable with the portal key that sits in the page. Only the
// finished volume-discount curve (maximum discount + half-life) is sent.
router.get('/', requireEitherAuth(), async (req, res) => {
  const pricing = await pc.getPricing();
  const promotions = await pc.getActivePromotions();

  const policiesRaw = await pc.getSettingJson('order_policies', null);
  const specialVolume = await pc.getSettingNumber('special_volume_threshold_crates');

  const dist = await pc.getSettingJson('distribution_pricing_settings', {});
  const deliveryPerCrate = Number(dist.ceilingPerCrate) > 0 ? Number(dist.ceilingPerCrate) : null;

  const abuse = await pc.getSettingJson('abuse_settings', {});
  const newCustomerMaxCrates = Number(abuse.newCustomerMaxCrates) > 0 ? Number(abuse.newCustomerMaxCrates) : 50;

  const hold = await pc.getSettingJson('hold_windows', {});
  const flv = hold.firstTimeLargeVolume || {};
  const resv = await pc.getSettingJson('reservation_settings', {});

  // Demand in the last 24 hours: crates promised on open orders, against
  // crates in stock. Shortens reservation windows when stock is moving fast.
  const committed = await db.prepare(`
    SELECT COALESCE(SUM(crates), 0)::int AS n FROM orders
    WHERE status NOT IN ('fulfilled','rejected','cancelled','expired')
      AND created_at >= now() - interval '24 hours'
  `).get();
  const stock = await db.prepare('SELECT COALESCE(SUM(remaining), 0)::int AS n FROM batches').get();
  const denom = (committed?.n || 0) + (stock?.n || 0);
  const velocity = denom > 0 ? (committed?.n || 0) / denom : 0;

  res.set('Cache-Control', 'no-store');
  res.json({
    generatedAt: new Date().toISOString(),
    sellingPrice: pricing.sellingPrice,
    maxDiscount: pricing.maxDiscount,
    halfLife: pricing.halfLife,
    deliveryPerCrate,
    specialVolumeThreshold: specialVolume,
    orderPolicies: Array.isArray(policiesRaw) ? policiesRaw : null,
    promotions,
    newCustomerMaxCrates,
    commitmentWindow: {
      floorHours: Number(flv.floorHours) > 0 ? Number(flv.floorHours) : 1,
      ceilingHours: Number(flv.ceilingHours) > 0 ? Number(flv.ceilingHours) : 3,
    },
    reservation: {
      newBaselineHours: resv.newBaselineHours ?? 6,
      returningBaselineHours: resv.returningBaselineHours ?? 24,
      newFloorHours: resv.newFloorHours ?? 1,
      returningFloorHours: resv.returningFloorHours ?? 4,
      velocityHalfPoint: resv.velocityHalfPoint ?? 0.3,
    },
    velocity,
  });
});

module.exports = router;
