const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();
const VALID_EVENTS = ['viewed_form', 'set_crates', 'reached_checkout', 'submitted_order', 'blocked_cap'];

router.post('/', requireEitherAuth(), async (req, res) => {
  const { sessionId, eventType, orderRef, crates, metadata } = req.body;
  if(!sessionId || !VALID_EVENTS.includes(eventType)) {
    return res.status(400).json({ error: `sessionId required; eventType must be one of ${VALID_EVENTS.join(', ')}.` });
  }
  await db.prepare(`
    INSERT INTO funnel_events (session_id, event_type, order_ref, crates, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, eventType, orderRef || null, crates || null, metadata ? JSON.stringify(metadata) : null);
  res.status(201).json({ ok: true });
});

router.get('/funnel', requireSupabaseAuth(), async (req, res) => {
  const { from, to } = req.query;
  const counts = {};
  for(const step of VALID_EVENTS) {
    const row = from && to
      ? await db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM funnel_events WHERE event_type = ? AND created_at::date BETWEEN ? AND ?`).get(step, from, to)
      : await db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM funnel_events WHERE event_type = ?`).get(step);
    counts[step] = parseInt(row.c);
  }
  res.json({ period: { from: from || 'all-time', to: to || 'all-time' }, funnel: counts });
});

router.get('/session/:sessionId', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM funnel_events WHERE session_id = ? ORDER BY created_at ASC').all(req.params.sessionId);
  res.json(rows);
});

module.exports = router;
