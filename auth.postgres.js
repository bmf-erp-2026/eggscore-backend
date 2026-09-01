// auth.postgres.js — same role/key logic as auth.js, adapted for a
// real async database connection. Every db call now needs `await`.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { db } = require('./db.postgres');

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function extractBearerToken(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

// Real, per-person authentication for the ERP — replaces the shared
// API key that any rep could use interchangeably with no way to tell
// who actually did what. This is the traceability piece specifically.
// Uses Supabase's own recommended server-side verification pattern:
// asking Supabase directly whether this token corresponds to a real,
// currently-valid session, rather than attempting to verify the JWT
// signature manually here.
//
// role (Sep 1 2026, Sales Rep Access project): read from the Supabase
// user's own app_metadata.role, set via the Supabase Admin API when an
// account is created/edited — never trust a client-supplied role, since
// req.body/req.headers are fully attacker-controlled. Defaults to
// 'owner' when app_metadata.role is missing entirely — this is
// deliberate backward compatibility: every account that exists today
// (Bob's own login) predates this feature and has no role set at all;
// defaulting the ABSENT case to 'rep' would silently lock out every
// existing session. New rep accounts must have role:'rep' explicitly
// set at creation time — only an explicit tag narrows access, an
// absent one never does.
function requireSupabaseAuth() {
  return async (req, res, next) => {
    if(!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set.' });
    const token = extractBearerToken(req);
    if(!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token> header.' });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if(error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session — please log in again.' });

    req.user = {
      id: data.user.id,
      email: data.user.email,
      role: data.user.app_metadata?.role || 'owner',
    };
    req.apiKeyRole = 'erp'; // downstream role checks stay unchanged
    next();
  };
}

// Gate for finance-sensitive routes — must run AFTER requireSupabaseAuth()
// in the same route (relies on req.user.role already being set). A rep
// hitting a gated route gets a clean 403, same shape as the existing
// requireAuth() role-mismatch response, not a generic auth failure —
// so the ERP's error handling doesn't need two different code paths.
// Deliberately NOT usable standalone: if req.user is missing entirely
// (requireSupabaseAuth wasn't called first, or failed), this fails
// closed with 401 rather than silently treating a missing user as
// either role.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if(!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if(!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Your role (${req.user.role}) cannot access this endpoint.` });
    }
    next();
  };
}

// For the handful of endpoints both the customer portal and the ERP
// call — accepts either a real ERP login or the portal's existing
// shared key. Tries the real login first; only falls back to the
// shared key if no valid session was presented at all.
function requireEitherAuth() {
  return async (req, res, next) => {
    const token = extractBearerToken(req);
    if(token && supabaseAdmin) {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if(!error && data?.user) {
        req.user = {
          id: data.user.id,
          email: data.user.email,
          role: data.user.app_metadata?.role || 'owner',
        };
        req.apiKeyRole = 'erp';
        return next();
      }
    }
    return requireAuth('portal', 'erp')(req, res, next);
  };
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

async function createApiKey(role, label) {
  const rawKey = 'egs_' + crypto.randomBytes(24).toString('hex');
  const keyHash = hashKey(rawKey);
  await db.prepare('INSERT INTO api_keys (key_hash, role, label) VALUES (?, ?, ?)').run(keyHash, role, label);
  return rawKey;
}

function requireAuth(...allowedRoles) {
  return async (req, res, next) => {
    const rawKey = (req.headers['x-api-key'] || '').trim();
    if(!rawKey) return res.status(401).json({ error: 'Missing X-API-Key header.' });

    const keyHash = hashKey(rawKey);
    const record = await db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
    if(!record) return res.status(401).json({ error: 'Invalid API key.' });
    if(allowedRoles.length && !allowedRoles.includes(record.role)) {
      return res.status(403).json({ error: `This key's role (${record.role}) cannot access this endpoint.` });
    }

    await db.prepare("UPDATE api_keys SET last_used_at = now() WHERE id = ?").run(record.id);
    req.apiKeyRole = record.role;
    next();
  };
}

module.exports = { createApiKey, requireAuth, requireSupabaseAuth, requireEitherAuth, requireRole, hashKey };
