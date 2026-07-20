const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const VALID_EVENTS = ['viewed_form', 'set_crates', 'reached_checkout', 'submitted_order', 'blocked_cap'];

// POST /events — the portal logs a step. No personal data required —
// session_id is a random client-generated value, not tied to a name
// or phone unless the visitor actually reaches submitted_order.
router.post('/', requireAuth('portal', 'erp'), (req, res) => {
  const { sessionId, eventType, orderRef, crates, metadata } = req.body;

  if(!sessionId || !VALID_EVENTS.includes(eventType)) {
    return res.status(400).json({ error: `sessionId required; eventType must be one of ${VALID_EVENTS.join(', ')}.` });
  }

  db.prepare(`
    INSERT INTO funnel_events (session_id, event_type, order_ref, crates, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, eventType, orderRef || null, crates || null, metadata ? JSON.stringify(metadata) : null);

  res.status(201).json({ ok: true });
});

// GET /events/funnel — the actual funnel shape: how many sessions
// reached each step, computed fresh from real rows, not a running
// counter that could drift from what actually happened.
router.get('/funnel', requireAuth('erp'), (req, res) => {
  const { from, to } = req.query;
  const dateFilter = from && to ? 'WHERE date(created_at) BETWEEN ? AND ?' : '';
  const params = from && to ? [from, to] : [];

  const counts = {};
  for(const step of VALID_EVENTS) {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as c FROM funnel_events
      WHERE event_type = ? ${dateFilter ? 'AND date(created_at) BETWEEN ? AND ?' : ''}
    `).get(step, ...params);
    counts[step] = row.c;
  }
  res.json({ period: { from: from || 'all-time', to: to || 'all-time' }, funnel: counts });
});

// GET /events/session/:sessionId — full step-by-step trail for one
// visitor session, useful for understanding exactly where a specific
// abandoned attempt stopped.
router.get('/session/:sessionId', requireAuth('erp'), (req, res) => {
  const rows = db.prepare('SELECT * FROM funnel_events WHERE session_id = ? ORDER BY created_at ASC').all(req.params.sessionId);
  res.json(rows);
});

module.exports = router;
