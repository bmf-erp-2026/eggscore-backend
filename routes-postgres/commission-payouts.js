const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');

const router = express.Router();

// Append-only log — unlike settlements (which support reversal, hence
// an ON CONFLICT...DO UPDATE there), a commission payout entry never
// changes after it's created. ON CONFLICT (entry_id) DO NOTHING makes
// re-posting the same entry (the client's self-healing retry) a
// harmless no-op instead of an error, without ever mutating a row.
//
// Owner-only (Sep 1 2026, Sales Rep Access): recording a payout means
// confirming money was actually disbursed to a rep — that's always an
// owner decision, unlike sales.js's POST (a rep recording their OWN
// sale is a normal operational action). There's no legitimate case for
// a rep to create their own payout record.
router.post('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { entryId, repName, monthKey, amount, recordedBy, at } = req.body;

  if(!entryId || !repName || !monthKey) {
    return res.status(400).json({ error: 'entryId, repName and monthKey are required.' });
  }

  const row = await db.prepare(`
    INSERT INTO commission_payouts (
      entry_id, rep_name, month_key, amount, recorded_by, client_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (entry_id) DO NOTHING
    RETURNING *
  `).run(
    entryId, repName, monthKey, amount || 0, recordedBy || null, at || null
  );

  res.status(201).json(row);
});

// Full-log pull for cross-device sync — same shape/intent as
// GET /settlements. Small append-only table, full pull is fine.
//
// "Own earnings only" for reps (Sep 1 2026, Sales Rep Access) — same
// email-linked-name approach as sales.js. A rep with no linked rep
// record sees an empty list rather than an error or every rep's payouts.
router.get('/', requireSupabaseAuth(), async (req, res) => {
  let rows;
  if(req.user.role === 'owner') {
    rows = await db.prepare('SELECT * FROM commission_payouts ORDER BY created_at DESC').all();
  } else {
    const repRow = await db.prepare('SELECT name FROM reps WHERE email = ?').get(req.user.email);
    rows = repRow
      ? await db.prepare('SELECT * FROM commission_payouts WHERE rep_name = ? ORDER BY created_at DESC').all(repRow.name)
      : [];
  }
  // Same NUMERIC-comes-back-as-string guard already proven necessary
  // for settlements (see settlements.js) — cast here so every
  // consumer gets a real number, not a string to sum by mistake.
  res.json(rows.map(r => ({ ...r, amount: Number(r.amount) || 0 })));
});

module.exports = router;
