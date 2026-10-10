// server.postgres.js — the real production entry point, pointed at
// Supabase/Postgres instead of the local SQLite file used for
// zero-account development testing (server.js).
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createApiKey } = require('./auth.postgres');

const app = express();

// service-worker.js MUST always be revalidated — a stale cached copy of
// this exact file is what caused a live production incident (a POST to
// /suppliers got silently intercepted and 404'd by an old worker version
// that predated its own method-check guard). express.static's default
// caching isn't aggressive enough to have prevented that on its own, but
// this removes any ambiguity: this one file is never served from cache.
app.get('/service-worker.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile('service-worker.js', { root: 'public' });
});

app.use(express.static('public'));
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.redirect('/famad-order.html'));

app.use('/orders', require('./routes-postgres/orders'));
app.use('/events', require('./routes-postgres/events'));
app.use('/sales', require('./routes-postgres/sales'));
app.use('/inventory', require('./routes-postgres/inventory'));
app.use('/customers', require('./routes-postgres/customers'));
app.use('/settlements', require('./routes-postgres/settlements'));
app.use('/reps', require('./routes-postgres/reps'));
app.use('/suppliers', require('./routes-postgres/suppliers'));
app.use('/promotions', require('./routes-postgres/promotions'));
app.use('/vehicles', require('./routes-postgres/vehicles'));
app.use('/drivers', require('./routes-postgres/drivers'));
app.use('/destinations', require('./routes-postgres/destinations'));
app.use('/dispatch-origins', require('./routes-postgres/dispatch-origins'));
app.use('/service-areas', require('./routes-postgres/service-areas'));
app.use('/delivery-days', require('./routes-postgres/delivery-days'));
app.use('/delivery-batches', require('./routes-postgres/delivery-batches'));
app.use('/settings', require('./routes-postgres/settings'));
app.use('/wallet', require('./routes-postgres/wallet'));
app.use('/respect', require('./routes-postgres/respect'));
app.use('/relationship-tags', require('./routes-postgres/relationship-tags'));
app.use('/feedback', require('./routes-postgres/feedback'));
app.use('/loyalty', require('./routes-postgres/loyalty'));
app.use('/notices', require('./routes-postgres/notices'));
app.use('/ai', require('./routes-postgres/ai'));
app.use('/theme-views', require('./routes-postgres/theme-views'));
app.use('/push', require('./routes-postgres/push'));
// Oct 10 2026 — Volume Requests (customer phone -> ERP) and Payment Holds /
// Pending Transfers (ERP device -> every ERP device) now live on the server
// instead of in whichever single browser created them.
app.use('/volume-requests', require('./routes-postgres/volume-requests'));
app.use('/payment-holds', require('./routes-postgres/payment-holds'));
// Oct 10 2026 — portal persistence: the portal now reads its prices,
// promotions, policies and limits from the server (/portal-config); the
// blocklist and large first-timer alerts live on the server too.
app.use('/portal-config', require('./routes-postgres/portal-config'));
app.use('/reservation-blocklist', require('./routes-postgres/reservation-blocklist'));
app.use('/large-first-timers', require('./routes-postgres/large-first-timers'));

// Aug 29 — 3 previously local-only-forever logs migrated to real
// backend persistence: Commission Payout status, the System Overrides
// & Security Log, and the System Event Log. Mounted at
// '/system-events' rather than '/events' since that path is already
// taken above by the funnel/analytics events route — a different
// thing entirely.
app.use('/commission-payouts', require('./routes-postgres/commission-payouts'));
app.use('/credit-overrides', require('./routes-postgres/credit-overrides'));
app.use('/system-events', require('./routes-postgres/system-events'));

app.get('/health', (req, res) => res.json({ ok: true, service: 'eggscore-backend', mode: 'postgres', time: new Date().toISOString() }));

app.post('/admin/create-key', async (req, res) => {
  if(req.headers['x-setup-secret'] !== process.env.SETUP_SECRET) {
    return res.status(403).json({ error: 'Invalid or missing setup secret.' });
  }
  const { role, label } = req.body;
  if(!['erp', 'portal'].includes(role)) {
    return res.status(400).json({ error: "role must be 'erp' or 'portal'." });
  }
  const rawKey = await createApiKey(role, label || '');
  res.json({ apiKey: rawKey, role, warning: 'Store this now — it is not recoverable and will not be shown again.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`EggScore backend (Postgres mode) listening on port ${PORT}`);
  // Oct 9 2026 — starts the delivery-reminder / win-back timer for push
  // notifications. Does nothing unless the VAPID keys are set in Railway.
  require('./lib/push').startScheduler();
});

module.exports = app;
