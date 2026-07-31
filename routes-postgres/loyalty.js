const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth } = require('../auth.postgres');
const router = express.Router();

// Defaults mirror ensureLoyaltySettings()/ensureScorecardSettings() in
// famad-erp.html exactly — used only if Bob has never saved settings
// from the ERP yet (backend has no row), same fallback role the client
// object literal defaults play there.
const DEFAULT_LOYALTY_SETTINGS = {
  pointsPerReferral: 10, referralCapPerQuarter: 40,
  feedbackFormPoints: 5, feedbackImpactfulBonus: 10, feedbackCapPerQuarter: 30,
  commThirtyMinPoints: 4, commOneHourPoints: 2, commOneDayPoints: 1,
  respectNoIncidentPoints: 5, respectPerPolicyPoints: 1,
  loyaltyLevelThresholds: { silver: 20, gold: 45, platinum: 70 },
};
const DEFAULT_RELATIONSHIP_TAG_POINTS = {
  advocacy: 15, feedback: 12, product_trial: 8, respectful_conduct: 6, communication: 6,
};

function getQuarterKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

// Server-side port of computePortalLoyaltyProfile() — but only for the
// three components that are actually backend-persisted as of tonight:
// feedback, respect, and manual relationship tags. Advocacy and
// Communication are deliberately NOT computed here — they depend on
// referral/reservation-lifecycle fields (referredByCustomerName,
// reservationCustomerType, reservedAt, convertedAt, cancelledAt) that
// don't exist in the backend `orders` table yet (a separate, larger gap
// — see eggscore-erp notes). Callers combine this response with their
// own locally-computed advocacy/communication until that's addressed.
router.get('/:customerName', requireEitherAuth(), async (req, res) => {
  const customerName = req.params.customerName;

  const customer = await db.prepare('SELECT id, referral_code FROM customers WHERE name = ?').get(customerName);

  const lySettingsRow = await db.prepare("SELECT value FROM settings WHERE key = 'loyalty_settings'").get();
  const ly = lySettingsRow ? JSON.parse(lySettingsRow.value) : DEFAULT_LOYALTY_SETTINGS;

  const scSettingsRow = await db.prepare("SELECT value FROM settings WHERE key = 'scorecard_settings'").get();
  const relationshipTagPoints = scSettingsRow
    ? (JSON.parse(scSettingsRow.value).relationshipTagPoints || DEFAULT_RELATIONSHIP_TAG_POINTS)
    : DEFAULT_RELATIONSHIP_TAG_POINTS;

  if(!customer) {
    // No backend-known customer — everything computable here is 0,
    // same as the client function would show for an unrecognized name.
    return res.json({
      referralCode: null, totalOrders: 0,
      breakdown: { feedback: 0, respect: 0, other: 0 },
    });
  }

  // Feedback — capped per quarter, matching the client's fbByQ reduce
  const feedbackRows = await db.prepare(
    'SELECT flagged_impactful, submitted_at FROM feedback_submissions WHERE customer_id = ?'
  ).all(customer.id);
  const fbByQ = {};
  feedbackRows.forEach(f => {
    const q = getQuarterKey(f.submitted_at);
    const pts = ly.feedbackFormPoints + (f.flagged_impactful ? ly.feedbackImpactfulBonus : 0);
    fbByQ[q] = (fbByQ[q] || 0) + pts;
  });
  const feedback = Object.values(fbByQ).reduce((a, p) => a + Math.min(ly.feedbackCapPerQuarter, p), 0);

  // Respect — straight sum, no quarter capping (matches computeRespectPoints())
  const respectRows = await db.prepare(
    'SELECT no_incident_flag, policies_adhered FROM respect_events WHERE customer_id = ?'
  ).all(customer.id);
  const respect = respectRows.reduce((total, r) => {
    let pts = r.no_incident_flag ? ly.respectNoIncidentPoints : 0;
    pts += (r.policies_adhered?.length || 0) * ly.respectPerPolicyPoints;
    return total + pts;
  }, 0);

  // Manual relationship tags — straight sum (matches the client's manualTags reduce)
  const tagRows = await db.prepare(
    'SELECT tag_type FROM relationship_tags WHERE customer_id = ?'
  ).all(customer.id);
  const other = tagRows.reduce((a, t) => a + (relationshipTagPoints[t.tag_type] || 0), 0);

  const totalOrders = (await db.prepare(
    'SELECT COUNT(*) AS count FROM sales WHERE customer_id = ?'
  ).get(customer.id))?.count || 0;

  res.json({
    referralCode: customer.referral_code || null,
    totalOrders: Number(totalOrders),
    breakdown: { feedback, respect, other },
  });
});

module.exports = router;
