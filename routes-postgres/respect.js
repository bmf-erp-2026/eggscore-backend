const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');
const router = express.Router();

// ERP-only — records (or overwrites) one customer's quarterly conduct
// record. Unlike wallet_transactions this is an upsert, not an
// append-only ledger: (customer_id, quarter) is the natural key, same
// as recordQuarterlyRespect()'s own find-or-create-by-quarter logic on
// the client. Re-submitting the same customer+quarter updates the
// existing row instead of creating a duplicate.
router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { customerId, quarter, noIncidentFlag, policiesAdhered, createdBy } = req.body;

  if(!customerId || !quarter) {
    return res.status(400).json({ error: 'customerId and quarter are required.' });
  }

  await db.prepare(`
    INSERT INTO respect_events (customer_id, quarter, no_incident_flag, policies_adhered, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (customer_id, quarter) DO UPDATE SET
      no_incident_flag = EXCLUDED.no_incident_flag,
      policies_adhered = EXCLUDED.policies_adhered,
      created_by = EXCLUDED.created_by,
      created_at = now()
  `).run(customerId, quarter, !!noIncidentFlag, JSON.stringify(policiesAdhered || []), createdBy || null);

  const row = await db.prepare(
    'SELECT * FROM respect_events WHERE customer_id = ? AND quarter = ?'
  ).get(customerId, quarter);

  res.status(201).json(row);
});

// ERP-only — every respect record across all customers, for the ERP's
// sync (mirrors wallet's bulk GET / — one fetch instead of looping
// per-customer, merged client-side by customerName+quarter).
router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM respect_events ORDER BY created_at DESC').all());
});

module.exports = router;
