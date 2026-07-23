// server.js — EggScore Backend, MVP
//
// Covers the P0 domains from the ERP scan: orders, funnel events,
// sales ledger, inventory/batches. Everything else on the itemized
// list stays client-side for now, deliberately — P1/P2 items migrate
// in a later pass once this core is live and proven.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSchema } = require('./db');
const { createApiKey } = require('./auth');

const app = express();
app.use(express.static('public'));
app.use(cors());
app.use(express.json());

initSchema();

app.use('/orders', require('./routes/orders'));
app.use('/events', require('./routes/events'));
app.use('/sales', require('./routes/sales'));
app.use('/inventory', require('./routes/inventory'));

app.get('/health', (req, res) => res.json({ ok: true, service: 'eggscore-backend', time: new Date().toISOString() }));

// One-time admin route to mint a fresh API key — deliberately requires
// a setup secret from the environment, not open to the internet, so
// this can't be used by anyone who simply finds the URL.
app.post('/admin/create-key', (req, res) => {
  if(req.headers['x-setup-secret'] !== process.env.SETUP_SECRET) {
    return res.status(403).json({ error: 'Invalid or missing setup secret.' });
  }
  const { role, label } = req.body;
  if(!['erp', 'portal'].includes(role)) {
    return res.status(400).json({ error: "role must be 'erp' or 'portal'." });
  }
  const rawKey = createApiKey(role, label || '');
  res.json({ apiKey: rawKey, role, warning: 'Store this now — it is not recoverable and will not be shown again.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`EggScore backend listening on port ${PORT}`));

module.exports = app;
