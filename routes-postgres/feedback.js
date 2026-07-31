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

module.exports = router;
