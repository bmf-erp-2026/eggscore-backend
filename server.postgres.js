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
app.use('/settings', require('./routes-postgres/settings'));
app.use('/wallet', require('./routes-postgres/wallet'));
app.use('/respect', require('./routes-postgres/respect'));
app.use('/relationship-tags', require('./routes-postgres/relationship-tags'));
app.use('/feedback', require('./routes-postgres/feedback'));
app.use('/loyalty', require('./routes-postgres/loyalty'));
app.use('/ai', require('./routes-postgres/ai'));
app.use('/theme-views', require('./routes-postgres/theme-views'));

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
app.listen(PORT, () => console.log(`EggScore backend (Postgres mode) listening on port ${PORT}`));

module.exports = app;
