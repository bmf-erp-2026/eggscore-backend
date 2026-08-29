const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Mounted at '/system-events', deliberately NOT '/events' — server.js
// already mounts '/events' for a different thing entirely (funnel/
// analytics tracking events, per routes/events.js). Reusing that path
// would have silently collided with it.
//
// Append-only, same ON CONFLICT DO NOTHING pattern as the other 2 new
// tables here — a logged event never changes after it's created.
router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { entryId, category, level, message, detail, at } = req.body;

  if(!entryId || !message) {
    return res.status(400).json({ error: 'entryId and message are required.' });
  }

  const row = await db.prepare(`
    INSERT INTO system_events (
      entry_id, category, level, message, detail, client_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (entry_id) DO NOTHING
    RETURNING *
  `).run(
    entryId, category || null, level || null, message,
    JSON.stringify(detail || null), at || null
  );

  res.status(201).json(row);
});

// Full-log pull for cross-device sync — same shape/intent as
// GET /settlements. This table can grow faster than the other two
// (every automatic tier check, badge hold, etc. logs an entry) — a
// LIMIT keeps a busy install's first sync fast; the client already
// caps its own local copy at EVLOG_MAX (100) and merges by entry_id,
// so anything older than this cap simply won't be pulled down again,
// same as it already isn't kept locally past that cap today.
router.get('/', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM system_events ORDER BY created_at DESC LIMIT 500').all();
  res.json(rows);
});

module.exports = router;
