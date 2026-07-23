// server.postgres.js — the real production entry point, pointed at
// Supabase/Postgres instead of the local SQLite file used for
// zero-account development testing (server.js).
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createApiKey } = require('./auth.postgres');

const app = express();
app.use(express.static('public'));
app.use(cors());
app.use(express.json());

app.use('/orders', require('./routes-postgres/orders'));
app.use('/events', require('./routes-postgres/events'));
app.use('/sales', require('./routes-postgres/sales'));
app.use('/inventory', require('./routes-postgres/inventory'));

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
