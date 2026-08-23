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
  const rows = await db.prepare('SELECT * FROM settlements ORDER BY created_at DESC').all();
  // NUMERIC columns come back from the Postgres driver as strings, not
  // JS numbers, to avoid float precision loss — confirmed live Aug 23
  // to cause silent balance corruption client-side the moment a sale
  // has 2+ settlement entries (string concatenation instead of
  // addition, e.g. "1246050"+"100000" = "1246050100000", which then
  // parses as one enormous number and floors every balance to 0).
  // Casting here means every consumer of this endpoint gets real
  // numbers, not just whichever client happens to remember to convert.
  res.json(rows.map(r => ({
    ...r,
    amount: Number(r.amount) || 0,
    gross_due: Number(r.gross_due) || 0,
    balance_before: Number(r.balance_before) || 0,
    balance_after: Number(r.balance_after) || 0,
  })));
});

module.exports = router;
