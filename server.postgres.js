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

// Oct 12 2026 — staff working hours: outside Monday to Saturday 06:00-18:30 (Lagos) every request
// that carries a staff login is refused unless the person is the Owner or has a one-day exception.
// Customer-portal and public requests carry no staff login and are never affected.
try { app.use(require('./lib/staff-hours').guard()); }
catch(e) { console.error('[startup] WARNING: staff hours guard did not load:', e && e.message); }

app.get('/', (req, res) => res.redirect('/famad-order.html'));

// Oct 10 2026 (Stage 2) — startup safeguard. Each route file is loaded on its
// own. If one is missing or has a mistake in it, the server logs a clear
// warning, leaves that one feature switched off, and keeps every other part
// of the app running — instead of crashing the whole backend, which is what
// happened when a file was uploaded to the wrong folder. /health lists
// anything that did not load ("degraded"), so a glance after every release
// shows whether everything came up.
const failedRoutes = [];
function mount(path, file) {
  try {
    app.use(path, require(file));
  } catch(e) {
    failedRoutes.push({ path, file, error: String(e && e.message || e).split('\n')[0].slice(0, 200) });
    console.error(`[startup] WARNING: ${path} did not load (${file}): ${e && e.message}`);
  }
}

// Oct 17 2026 (0.60) — the Owner PIN can only be swapped with proof of the current PIN or the recovery code, so a stolen
// Owner login cannot overwrite it. This sits ahead of the Settings routes and lets valid requests fall through to them.
try { app.patch('/settings/owner-pin', require('./lib/owner-pin').guardPinChange()); }
catch(e) { failedRoutes.push({ path: '/settings/owner-pin', file: './lib/owner-pin', error: String(e && e.message || e).split('\n')[0].slice(0, 200) }); console.error('[startup] WARNING: owner PIN guard did not load:', e && e.message); }

// Oct 16 2026 — the official EggScore bank accounts, the "Check an account" answer and the Pay Code.
mount('/payment-accounts', './routes-postgres/payment-accounts');
// Oct 17 2026 (0.64) — the Owner PIN is checked on the server only; no browser is sent the PIN's hash any more.
mount('/owner-pin', './routes-postgres/owner-pin');
mount('/orders', './routes-postgres/orders');
mount('/events', './routes-postgres/events');
mount('/sales', './routes-postgres/sales');
mount('/inventory', './routes-postgres/inventory');
mount('/customers', './routes-postgres/customers');
mount('/settlements', './routes-postgres/settlements');
mount('/reps', './routes-postgres/reps');
// Oct 13 2026 — which login belongs to which sales rep (Owner only).
mount('/rep-accounts', './routes-postgres/rep-accounts');
mount('/suppliers', './routes-postgres/suppliers');
mount('/promotions', './routes-postgres/promotions');
mount('/vehicles', './routes-postgres/vehicles');
mount('/drivers', './routes-postgres/drivers');
mount('/destinations', './routes-postgres/destinations');
mount('/dispatch-origins', './routes-postgres/dispatch-origins');
mount('/service-areas', './routes-postgres/service-areas');
mount('/delivery-days', './routes-postgres/delivery-days');
mount('/delivery-batches', './routes-postgres/delivery-batches');
mount('/settings', './routes-postgres/settings');
mount('/wallet', './routes-postgres/wallet');
mount('/respect', './routes-postgres/respect');
mount('/relationship-tags', './routes-postgres/relationship-tags');
mount('/feedback', './routes-postgres/feedback');
mount('/loyalty', './routes-postgres/loyalty');
// Oct 15 2026 — read-only patronage-level progress for the customer portal (Part payment, Stage 1).
mount('/patronage', './routes-postgres/patronage');
mount('/part-payment', './routes-postgres/part-payment');
// Oct 15 2026 — Owner approval for a sale that did not come through the Orders Inbox.
mount('/sale-approvals', './routes-postgres/sale-approvals');
mount('/notices', './routes-postgres/notices');
mount('/ai', './routes-postgres/ai');
mount('/theme-views', './routes-postgres/theme-views');
mount('/push', './routes-postgres/push');
// Oct 10 2026 — Volume Requests (customer phone -> ERP) and Payment Holds /
// Pending Transfers (ERP device -> every ERP device) now live on the server
// instead of in whichever single browser created them.
mount('/volume-requests', './routes-postgres/volume-requests');
mount('/payment-holds', './routes-postgres/payment-holds');
// Oct 10 2026 — portal persistence: the portal now reads its prices,
// promotions, policies and limits from the server (/portal-config); the
// blocklist and large first-timer alerts live on the server too.
mount('/portal-config', './routes-postgres/portal-config');
mount('/reservation-blocklist', './routes-postgres/reservation-blocklist');
mount('/large-first-timers', './routes-postgres/large-first-timers');
// Oct 10 2026 (Stage 2) — commission disputes, overpayments and write-offs
// live on the server too (Owner only).
mount('/owner-records', './routes-postgres/owner-records');
mount('/ops-records', './routes-postgres/ops-records');
// Oct 12 2026 — a customer can message EggScore about one order; staff reply from the ERP.
mount('/order-messages', './routes-postgres/order-messages');
// Oct 12 2026 — staff devices opt in to a "New customer message" alert that works with the ERP closed.
mount('/staff-push', './routes-postgres/staff-push');
// Oct 12 2026 — staff working hours status and the Owner's one-day exceptions.
mount('/staff-hours', './routes-postgres/staff-hours');
// Oct 12 2026 — End-of-Day reports (staff file one a day; the Owner reads the roll-up and gets a 6:30 PM summary alert).
mount('/eod-reports', './routes-postgres/eod-reports');
mount('/attendance', './routes-postgres/attendance');

// Aug 29 — 3 previously local-only-forever logs migrated to real
// backend persistence: Commission Payout status, the System Overrides
// & Security Log, and the System Event Log. Mounted at
// '/system-events' rather than '/events' since that path is already
// taken above by the funnel/analytics events route — a different
// thing entirely.
mount('/commission-payouts', './routes-postgres/commission-payouts');
mount('/credit-overrides', './routes-postgres/credit-overrides');
mount('/system-events', './routes-postgres/system-events');

app.get('/health', (req, res) => res.json({
  ok: true, service: 'eggscore-backend', mode: 'postgres', time: new Date().toISOString(),
  // empty / absent = every route loaded. Anything listed here is switched off.
  ...(failedRoutes.length ? { degraded: failedRoutes } : {}),
}));

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
  try { require('./lib/push').startScheduler(); }
  catch(e) { console.error('[startup] WARNING: push scheduler did not start:', e && e.message); }
});

module.exports = app;
