const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth, requireRole } = require('../auth.postgres');
const push = require('../lib/push');

const router = express.Router();

const digitsOf = s => String(s || '').replace(/\D/g, '');
const last10 = s => digitsOf(s).slice(-10);
const cleanLang = l => (l === 'pcm' ? 'pcm' : 'en');

// ════════════════════════════════════════════════════════════════════════
// CUSTOMER-FACING (portal x-api-key) — a phone says yes / no to notifications
// ════════════════════════════════════════════════════════════════════════

// The portal needs the public half of the VAPID key to ask the phone for a
// subscription. (Public by design — it is not a secret.)
router.get('/public-key', requireEitherAuth(), (req, res) => {
  res.json({ enabled: push.isEnabled(), publicKey: push.getPublicKey() });
});

// Saves (or refreshes) a device's subscription and links it to the customer.
// The customer is identified by EITHER the order they just placed (orderRef +
// the phone number on it) OR their saved customer ID (cid + phone). The phone
// number must match the one on file, so one customer can't casually attach
// their phone to someone else's account by guessing an order reference.
router.post('/subscribe', requireEitherAuth(), async (req, res) => {
  if(!push.isEnabled()) return res.status(503).json({ error: 'Push notifications are not switched on yet.' });
  const { subscription, language, orderRef, cid, phone } = req.body || {};

  const endpoint = subscription && subscription.endpoint;
  const p256dh = subscription && subscription.keys && subscription.keys.p256dh;
  const auth = subscription && subscription.keys && subscription.keys.auth;
  if(!endpoint || !p256dh || !auth || typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 2048) {
    return res.status(400).json({ error: 'A valid push subscription is required.' });
  }

  let customerId = null, customerName = null;
  if(orderRef && phone) {
    const order = await db.prepare('SELECT customer_id, customer_name, phone FROM orders WHERE ref = ?').get(String(orderRef));
    if(!order) return res.status(404).json({ error: 'Order not found yet — try again in a moment.' });
    if(last10(order.phone) && last10(order.phone) !== last10(phone)) {
      return res.status(403).json({ error: 'Phone number does not match that order.' });
    }
    customerId = order.customer_id || null;
    customerName = order.customer_name || null;
  } else if(cid && phone) {
    const cust = await db.prepare('SELECT id, name, phone FROM customers WHERE cid = ?').get(String(cid));
    if(!cust || !last10(cust.phone) || last10(cust.phone) !== last10(phone)) {
      return res.status(403).json({ error: 'Customer ID and phone number do not match.' });
    }
    customerId = cust.id;
    customerName = cust.name;
  } else {
    return res.status(400).json({ error: 'orderRef + phone, or cid + phone, is required.' });
  }

  await db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, customer_id, customer_name, language, user_agent, active, failure_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, true, 0)
    ON CONFLICT (endpoint) DO UPDATE SET
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      customer_id = COALESCE(EXCLUDED.customer_id, push_subscriptions.customer_id),
      customer_name = COALESCE(EXCLUDED.customer_name, push_subscriptions.customer_name),
      language = EXCLUDED.language,
      user_agent = EXCLUDED.user_agent,
      active = true,
      failure_count = 0
  `).run(endpoint, p256dh, auth, customerId, customerName, cleanLang(language),
         String(req.headers['user-agent'] || '').slice(0, 300));

  res.status(201).json({ ok: true });
});

// Customer changed their portal language — keep their notifications in step.
router.post('/language', requireEitherAuth(), async (req, res) => {
  const { endpoint, language } = req.body || {};
  if(!endpoint) return res.status(400).json({ error: 'endpoint is required.' });
  await db.prepare('UPDATE push_subscriptions SET language = ? WHERE endpoint = ?').run(cleanLang(language), String(endpoint));
  res.json({ ok: true });
});

// Customer switched notifications off.
router.post('/unsubscribe', requireEitherAuth(), async (req, res) => {
  const { endpoint } = req.body || {};
  if(!endpoint) return res.status(400).json({ error: 'endpoint is required.' });
  await db.prepare('UPDATE push_subscriptions SET active = false WHERE endpoint = ?').run(String(endpoint));
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════
// OWNER-ONLY (ERP login) — the Push Notifications screen
// ════════════════════════════════════════════════════════════════════════
const ownerOnly = [requireSupabaseAuth(), requireRole('owner')];

router.get('/summary', ...ownerOnly, async (req, res) => {
  const counts = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE active)::int AS active,
      COUNT(*) FILTER (WHERE active AND language = 'pcm')::int AS pidgin,
      COUNT(*) FILTER (WHERE NOT active)::int AS inactive
    FROM push_subscriptions
  `).get();
  const subscribers = await db.prepare(`
    SELECT s.id, s.customer_name, s.language, s.created_at, s.last_success_at, s.user_agent, c.cid
    FROM push_subscriptions s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.active = true ORDER BY s.created_at DESC LIMIT 200
  `).all();
  const log = await db.prepare('SELECT * FROM push_log ORDER BY created_at DESC LIMIT 30').all();
  res.json({
    enabled: push.isEnabled(),
    counts,
    subscribers,
    log,
    settings: await push.getSettings(),
  });
});

router.get('/settings', ...ownerOnly, async (req, res) => {
  res.json(await push.getSettings());
});

router.put('/settings', ...ownerOnly, async (req, res) => {
  res.json(await push.saveSettings(req.body || {}, req.user && req.user.email));
});

// Owner broadcast. Send { dryRun: true } first to learn how many devices a
// message would reach without sending anything.
router.post('/broadcast', ...ownerOnly, async (req, res) => {
  if(!push.isEnabled()) return res.status(503).json({ error: 'Push is not switched on — VAPID keys are missing on the server.' });
  const b = req.body || {};
  const titleEn = String(b.titleEn || '').trim();
  const bodyEn = String(b.bodyEn || '').trim();
  const titlePcm = String(b.titlePcm || '').trim();
  const bodyPcm = String(b.bodyPcm || '').trim();
  if(!b.dryRun) {
    if(!titleEn || !bodyEn) return res.status(400).json({ error: 'An English title and message are required.' });
    if(titleEn.length > 65 || titlePcm.length > 65) return res.status(400).json({ error: 'Titles must be 65 characters or fewer.' });
    if(bodyEn.length > 200 || bodyPcm.length > 200) return res.status(400).json({ error: 'Messages must be 200 characters or fewer.' });
    if((titlePcm && !bodyPcm) || (!titlePcm && bodyPcm)) return res.status(400).json({ error: 'Fill in both the Pidgin title and message, or leave both blank.' });
  }
  let url = '/famad-order.html';
  if(typeof b.url === 'string' && /^\/[A-Za-z0-9._~\-\/?=&#%]*$/.test(b.url) && !b.url.startsWith('//')) url = b.url;

  const allowed = ['all', 'wholesalers', 'inactive', 'highvolume', 'customer'];
  const audience = b.audience && allowed.includes(b.audience.type)
    ? { type: b.audience.type, phone: b.audience.phone }
    : { type: 'all' };
  if(audience.type === 'customer' && digitsOf(audience.phone).length < 7) {
    return res.status(400).json({ error: 'Enter the customer\'s phone number for a single-customer test.' });
  }

  const result = await push.broadcast({
    titleEn, bodyEn, titlePcm, bodyPcm, url, audience,
    createdBy: req.user && req.user.email, dryRun: !!b.dryRun,
  });
  console.log(`[audit] Push ${b.dryRun ? 'preview' : 'broadcast'} (${audience.type}) by ${req.user && req.user.email}: targeted ${result.targeted}, delivered ${result.delivered}`);
  res.json(result);
});

module.exports = router;
