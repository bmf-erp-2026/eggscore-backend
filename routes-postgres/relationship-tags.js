const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');
const router = express.Router();

// ERP-only — records one relationship tag (advocacy, feedback,
// product_trial, respectful_conduct, communication). Append-only ledger,
// not an upsert — a customer can legitimately get the same tag_type
// logged multiple times over time (mirrors wallet_transactions, not
// respect_events). clientId is logRelationshipTag()'s own 'rt'+Date.now()
// id — same role as wallet's clientId, letting the self-healing retry
// tell already-synced entries from never-synced ones. ON CONFLICT makes
// a retried POST safe — it won't create a duplicate row.
router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { customerId, tagType, note, createdBy, clientId } = req.body;

  if(!customerId || !tagType) {
    return res.status(400).json({ error: 'customerId and tagType are required.' });
  }

  await db.prepare(`
    INSERT INTO relationship_tags (customer_id, tag_type, note, created_by, client_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (client_id) DO NOTHING
  `).run(customerId, tagType, note || null, createdBy || null, clientId || null);

  const row = clientId
    ? await db.prepare('SELECT * FROM relationship_tags WHERE client_id = ?').get(clientId)
    : await db.prepare('SELECT * FROM relationship_tags WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(customerId);

  res.status(201).json(row);
});

// ERP-only — every relationship tag across all customers, for the ERP's
// self-healing retry (mirrors wallet's bulk GET / — one fetch instead
// of looping per-customer).
router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM relationship_tags ORDER BY created_at DESC').all());
});

module.exports = router;
