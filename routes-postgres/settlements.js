const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');
const scope = require('../lib/rep-scope');

const router = express.Router();

// Single upsert endpoint handles both creating a new settlement
// posting AND updating one in place (the reversal flow mutates an
// existing entry's reversed_at/reversal_reason rather than only
// adding a new row) — same ON CONFLICT...DO UPDATE convention already
// used for the settings table elsewhere in this codebase. entryId is
// client-generated once and never changes, so re-posting the same
// entry after a local mutation naturally becomes an update, not a
// duplicate row.
//
// Oct 13 2026 — who may post a payment:
//   owner    anything, including reversals (as before).
//   manager  new payments, for any rep. Never a reversal, and re-sending an entry that is already saved
//            changes nothing.
//   rep      new payments against their OWN sales only (or against a sale not saved yet, because the sale and
//            its payments travel together). The name on the payment is taken from the login. Never a reversal.
// Before this only the Owner could post, so every payment a rep or manager took at the till stayed on that
// device until the Owner happened to sign in there (Oct 13: the Ese YB Shop payments).
router.post('/', requireSupabaseAuth(), requireRole('owner', 'manager', 'rep'), async (req, res) => {
  const {
    entryId, saleId, saleRef, customerName, action, amount, grossDue,
    balanceBefore, balanceAfter, method, recordedBy, note, previousPayment,
    reversible, reversedAt, reversalReason, reversalNotes, scope: scopeField, at,
  } = req.body;

  if(!entryId || !action) {
    return res.status(400).json({ error: 'entryId and action are required.' });
  }

  const isOwner = req.user.role === 'owner';
  let by = recordedBy || null;
  if(!isOwner) {
    if(reversedAt || reversalReason || action === 'reversed') {
      return res.status(403).json({ error: 'Only the Owner can reverse a payment.', code: 'OWNER_ONLY_REVERSAL' });
    }
    if(req.user.role === 'rep') {
      const sc = await scope.scopeOf(req);
      if(!sc.rep) return res.status(403).json(scope.NOT_LINKED);
      const sale = saleRef ? await db.prepare('SELECT rep FROM sales WHERE invoice_ref = ? LIMIT 1').get(String(saleRef)) : null;
      if(sale && sale.rep !== sc.rep) return res.status(403).json({ error: 'That sale belongs to another sales rep.', code: 'NOT_YOUR_SALE' });
      by = sc.rep;
    }
  }

  const conflict = isOwner
    ? `ON CONFLICT (entry_id) DO UPDATE SET
         balance_after   = EXCLUDED.balance_after,
         reversed_at     = EXCLUDED.reversed_at,
         reversal_reason = EXCLUDED.reversal_reason,
         reversal_notes  = EXCLUDED.reversal_notes`
    : 'ON CONFLICT (entry_id) DO NOTHING';
  const row = await db.prepare(`
    INSERT INTO settlements (
      entry_id, sale_id, sale_ref, customer_name, action, amount, gross_due,
      balance_before, balance_after, method, recorded_by, note, previous_payment,
      reversible, reversed_at, reversal_reason, reversal_notes, scope, client_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ${conflict}
    RETURNING *
  `).run(
    entryId, saleId || null, saleRef || null, customerName || null, action,
    amount || 0, grossDue || null, balanceBefore || null, balanceAfter || null,
    method || null, by, note || null, previousPayment || null,
    reversible !== false, reversedAt || null, reversalReason || null,
    reversalNotes || null, scopeField || null, at || null
  );

  if(!isOwner && !row.changes) return res.status(200).json({ ok: true, alreadySaved: true });
  res.status(201).json({ ok: true, ...row });
});

// Full-log pull for cross-device sync — same shape/intent as
// GET /sales and GET /orders. No date filtering yet; the settlement
// log is small enough (one row per posting, not per day) that a full
// pull is fine for now.
router.get('/', requireSupabaseAuth(), requireRole('owner', 'manager', 'rep'), async (req, res) => {
  // A rep sees only the payments on their own sales (or taken under their name).
  const sc = await scope.scopeOf(req);
  if(!sc.all && !sc.rep) return res.json([]);
  const rows = sc.all
    ? await db.prepare('SELECT * FROM settlements ORDER BY created_at DESC').all()
    : await db.prepare(`SELECT * FROM settlements
                         WHERE recorded_by = ? OR sale_ref IN (SELECT invoice_ref FROM sales WHERE rep = ? AND invoice_ref IS NOT NULL)
                         ORDER BY created_at DESC`).all(sc.rep, sc.rep);
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
