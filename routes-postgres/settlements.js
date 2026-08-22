const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Single upsert endpoint handles both creating a new settlement
// posting AND updating one in place (the reversal flow mutates an
// existing entry's reversed_at/reversal_reason rather than only
// adding a new row) — same ON CONFLICT...DO UPDATE convention already
// used for the settings table elsewhere in this codebase. entryId is
// client-generated once and never changes, so re-posting the same
// entry after a local mutation naturally becomes an update, not a
// duplicate row.
router.post('/', requireSupabaseAuth(), async (req, res) => {
  const {
    entryId, saleId, saleRef, customerName, action, amount, grossDue,
    balanceBefore, balanceAfter, method, recordedBy, note, previousPayment,
    reversible, reversedAt, reversalReason, reversalNotes, scope, at,
  } = req.body;

  if(!entryId || !action) {
    return res.status(400).json({ error: 'entryId and action are required.' });
  }

  const row = await db.prepare(`
    INSERT INTO settlements (
      entry_id, sale_id, sale_ref, customer_name, action, amount, gross_due,
      balance_before, balance_after, method, recorded_by, note, previous_payment,
      reversible, reversed_at, reversal_reason, reversal_notes, scope, client_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (entry_id) DO UPDATE SET
      balance_after   = EXCLUDED.balance_after,
      reversed_at     = EXCLUDED.reversed_at,
      reversal_reason = EXCLUDED.reversal_reason,
      reversal_notes  = EXCLUDED.reversal_notes
    RETURNING *
  `).run(
    entryId, saleId || null, saleRef || null, customerName || null, action,
    amount || 0, grossDue || null, balanceBefore || null, balanceAfter || null,
    method || null, recordedBy || null, note || null, previousPayment || null,
    reversible !== false, reversedAt || null, reversalReason || null,
    reversalNotes || null, scope || null, at || null
  );

  res.status(201).json(row);
});

// Full-log pull for cross-device sync — same shape/intent as
// GET /sales and GET /orders. No date filtering yet; the settlement
// log is small enough (one row per posting, not per day) that a full
// pull is fine for now.
router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM settlements ORDER BY created_at DESC').all());
});

module.exports = router;
