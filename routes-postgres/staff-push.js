const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');
const push = require('../lib/push');

const router = express.Router();

// Oct 12 2026 — Staff alerts. A staff member taps "Turn on message alerts" in the
// ERP sidebar on a device; that device then gets a "New customer message" push
// even when the ERP is closed. Any signed-in staff member can switch their own
// devices on or off. The alert never contains the customer's message.

router.get('/public-key', requireSupabaseAuth(), (req, res) => {
  res.json({ enabled: push.isEnabled(), publicKey: push.getPublicKey() });
});

router.post('/subscribe', requireSupabaseAuth(), async (req, res) => {
  if(!push.isEnabled()) return res.status(503).json({ error: 'Push notifications are not switched on on the server.' });
  const sub = (req.body && req.body.subscription) || {};
  const endpoint = sub.endpoint;
  const p256dh = sub.keys && sub.keys.p256dh;
  const auth = sub.keys && sub.keys.auth;
  if(!endpoint || !p256dh || !auth || typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 2048) {
    return res.status(400).json({ error: 'A valid push subscription is required.' });
  }
  const email = (req.user && req.user.email) || null;
  const role = (req.user && req.user.role) || null;
  await db.prepare(`
    INSERT INTO staff_push_subscriptions (endpoint, p256dh, auth, user_email, role, user_agent, active, failure_count)
    VALUES (?, ?, ?, ?, ?, ?, true, 0)
    ON CONFLICT (endpoint) DO UPDATE SET
      p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
      user_email = EXCLUDED.user_email, role = EXCLUDED.role,
      user_agent = EXCLUDED.user_agent, active = true, failure_count = 0
  `).run(endpoint, p256dh, auth, email, role, String(req.headers['user-agent'] || '').slice(0, 300));
  res.status(201).json({ ok: true });
});

router.post('/unsubscribe', requireSupabaseAuth(), async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if(!endpoint) return res.status(400).json({ error: 'endpoint is required.' });
  await db.prepare('UPDATE staff_push_subscriptions SET active = false WHERE endpoint = ?').run(String(endpoint));
  res.json({ ok: true });
});

module.exports = router;
