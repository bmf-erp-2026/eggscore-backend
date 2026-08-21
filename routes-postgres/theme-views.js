const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth } = require('../auth.postgres');

const router = express.Router();

// Called by the anonymous customer portal on page load — no staff auth
// available there, so this uses the portal API-key path (requireEitherAuth)
// same as orders.js's POST /orders.
router.post('/', requireEitherAuth(), async (req, res) => {
  const { theme } = req.body;
  if(theme !== 'light' && theme !== 'dark') return res.status(400).json({ error: "theme must be 'light' or 'dark'." });

  await db.prepare(`INSERT INTO theme_views (theme) VALUES (?)`).run(theme);
  res.status(201).json({ ok: true });
});

// Staff-only aggregate for the ERP dashboard.
router.get('/summary', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare(`SELECT theme, COUNT(*) AS count FROM theme_views GROUP BY theme`).all();
  const summary = { light: 0, dark: 0 };
  rows.forEach(r => { summary[r.theme] = parseInt(r.count, 10); });
  res.json(summary);
});

module.exports = router;
