const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Read is open to either auth (ERP staff and the customer-facing portal
// both need to know the live price) — write is owner/staff-only, same
// as the batches write routes.
router.get('/selling-price', requireEitherAuth(), async (req, res) => {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = 'selling_price'").get();
  if(!row) return res.json({ price: null });
  res.json({ price: parseFloat(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at });
});

router.patch('/selling-price', requireSupabaseAuth(), async (req, res) => {
  const { price, updatedBy } = req.body;
  if(typeof price !== 'number' || price <= 0) {
    return res.status(400).json({ error: 'price must be a positive number.' });
  }
  await db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ('selling_price', ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `).run(String(price), updatedBy || null);
  res.json({ ok: true, price });
});

module.exports = router;
