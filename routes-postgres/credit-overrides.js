const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Covers 5 genuinely different entry shapes on the client (credit
// terms change, order-abuse override, time-value rate change, credit
// limit override, PIN change) — rather than 5 tables or a wide sparse
// one, the type-specific fields travel as one JSONB blob (`detail`)
// and get restored as-is client-side. Append-only, same ON CONFLICT
// DO NOTHING pattern as commission_payouts — an override entry never
// changes after it's created.
router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { entryId, type, customerName, recordedBy, at, detail } = req.body;

  if(!entryId) {
    return res.status(400).json({ error: 'entryId is required.' });
  }

  const row = await db.prepare(`
    INSERT INTO credit_overrides (
      entry_id, type, customer_name, recorded_by, client_at, detail
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (entry_id) DO NOTHING
    RETURNING *
  `).run(
    entryId, type || null, customerName || null, recordedBy || null,
    at || null, JSON.stringify(detail || {})
  );

  res.status(201).json(row);
});

// Full-log pull for cross-device sync — same shape/intent as
// GET /settlements. Small append-only table, full pull is fine.
router.get('/', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM credit_overrides ORDER BY created_at DESC').all();
  res.json(rows);
});

module.exports = router;
