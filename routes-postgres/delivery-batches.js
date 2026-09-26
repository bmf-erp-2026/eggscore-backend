const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Delivery Fulfilment Board, Phase 1 (Sep 26 2026) — staff-only for now.
// A "delivery batch" here is deliberately tiny: which order, which zone
// (a name from Coverage Areas), and a free-typed time window ("Tue
// 9am-12pm"). No customer-facing route exists yet in this file — that's
// Phase 2, and when it's built it will be scoped to one order at a time
// (looked up the same way the portal already looks up wallet balance and
// loyalty points), never a route that lists every order's zone at once.
// A shared board like that would tell any anonymous visitor which other
// businesses buy from Bob and roughly where they cluster — the same
// category of exposure the Sep 26 2026 policy on Destination Reference
// was written to shut down, just with a different kind of data.
//
// All 3 routes below require a staff login — nothing here is reachable
// by the customer portal yet.

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { orderRef, zone, timeWindow } = req.body;
  if(!orderRef || !zone || !timeWindow) {
    return res.status(400).json({ error: 'orderRef, zone, and timeWindow are all required.' });
  }

  await db.prepare(`
    INSERT INTO delivery_batches (order_ref, zone, time_window)
    VALUES (?, ?, ?)
    ON CONFLICT (order_ref) DO UPDATE SET
      zone = EXCLUDED.zone,
      time_window = EXCLUDED.time_window,
      assigned_at = now()
  `).run(orderRef, zone, timeWindow);

  res.status(200).json(await db.prepare('SELECT * FROM delivery_batches WHERE order_ref = ?').get(orderRef));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM delivery_batches ORDER BY assigned_at DESC').all());
});

router.delete('/:orderRef', requireSupabaseAuth(), async (req, res) => {
  await db.prepare('DELETE FROM delivery_batches WHERE order_ref = ?').run(req.params.orderRef);
  res.json({ ok: true });
});

module.exports = router;
