// auth.js — API keys, checked against a hash, never the raw key.
// This is genuinely new — nothing client-side ever distinguished
// "the ERP is asking" from "a customer is asking." Two roles:
//   erp     — full read/write, used only by famad-erp.html
//   portal  — can create orders and funnel events, cannot read
//             financial data (sales, commission, credit) at all
const crypto = require('crypto');
const { db } = require('./db');

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Generates a real key, stores only its hash, returns the raw value
// exactly once — the same pattern every real API provider uses,
// since a raw key that's recoverable from the database isn't a secret.
function createApiKey(role, label) {
  const rawKey = 'egs_' + crypto.randomBytes(24).toString('hex');
  const keyHash = hashKey(rawKey);
  db.prepare('INSERT INTO api_keys (key_hash, role, label) VALUES (?, ?, ?)').run(keyHash, role, label);
  return rawKey; // shown once, at creation time only
}

function requireAuth(...allowedRoles) {
  return (req, res, next) => {
    const rawKey = (req.headers['x-api-key'] || '').trim();
    if(!rawKey) return res.status(401).json({ error: 'Missing X-API-Key header.' });

    const keyHash = hashKey(rawKey);
    const record = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
    if(!record) return res.status(401).json({ error: 'Invalid API key.' });
    if(allowedRoles.length && !allowedRoles.includes(record.role)) {
      return res.status(403).json({ error: `This key's role (${record.role}) cannot access this endpoint.` });
    }

    db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?').run(record.id);
    req.apiKeyRole = record.role;
    next();
  };
}

module.exports = { createApiKey, requireAuth, hashKey };
