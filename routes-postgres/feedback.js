const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth } = require('../auth.postgres');
const router = express.Router();

// Portal-facing — a customer submitting feedback from their own device.
// Uses requireEitherAuth() like orders.js, since this is a portal write,
// not an ERP one (unlike wallet/respect/relationship-tags). customer_id
// is resolved server-side by name match, same as sales.js's INSERT —
// the portal never has to resolve it itself, and a name that doesn't
// match exactly still leaves it null rather than blocking the submission.
// clientId is submitFeedback()'s own 'fb'+Date.now() id, for retry-safety
// (ON CONFLICT DO NOTHING) — same role as wallet/relationship-tags'
// clientId, in case the portal's own network retries a submission.
router.post('/', requireEitherAuth(), async (req, res) => {
  const { customerName, phone, rating, text, clientId } = req.body;

  if(!customerName || !text) {
    return res.status(400).json({ error: 'customerName and text are required.' });
  }

  const customerRow = await db.prepare('SELECT id FROM customers WHERE name = ?').get(customerName);

  await db.prepare(`
    INSERT INTO feedback_submissions (customer_id, customer_name, phone, rating, text, client_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (client_id) DO NOTHING
  `).run(customerRow?.id || null, customerName, phone || null, rating || 5, text, clientId || null);

  const row = clientId
    ? await db.prepare('SELECT * FROM feedback_submissions WHERE client_id = ?').get(clientId)
    : await db.prepare('SELECT * FROM feedback_submissions WHERE customer_name = ? ORDER BY id DESC LIMIT 1').get(customerName);

  res.status(201).json(row);
});

// ERP-only — every feedback submission across all customers. Not wired
// into anything yet this session (that's read-path sub-phase work —
// computePortalLoyaltyProfile()'s feedback component and
// flagFeedbackImpactful()'s real backend wiring both need it), but
// added now for consistency with the other three data types' bulk GET.
router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM feedback_submissions ORDER BY submitted_at DESC').all());
});

// ERP-only — marks a real, backend-synced feedback submission as bonus-
// worthy. Only reachable now that the ERP actually reads real records
// via GET / above (its own real integer id, not the portal's local
// 'fb'+timestamp string) — flagFeedbackImpactful() previously flagged
// entries in the ERP's own never-synced local copy, which in production
// could only ever be entries created on that same device/browser.
router.patch('/:id/flag-impactful', requireSupabaseAuth(), async (req, res) => {
  const { flaggedBy } = req.body;
  const existing = await db.prepare('SELECT * FROM feedback_submissions WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Feedback record not found.' });
  if(existing.flagged_impactful) return res.status(400).json({ error: 'Already flagged.' });

  await db.prepare(`
    UPDATE feedback_submissions SET flagged_impactful = true, flagged_by = ?, flagged_at = now()
    WHERE id = ?
  `).run(flaggedBy || null, req.params.id);

  res.json(await db.prepare('SELECT * FROM feedback_submissions WHERE id = ?').get(req.params.id));
});

module.exports = router;
