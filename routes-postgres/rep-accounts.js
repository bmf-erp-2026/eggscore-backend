// routes-postgres/rep-accounts.js — which login belongs to which sales rep (Oct 13 2026). Owner only.
//
// A sales rep's login is linked to their record in the reps table by e-mail address (reps.email). The server
// reads that link on every request to decide whose sales, customers and orders a rep may see.
//   GET  /rep-accounts          every rep with the state of their login, plus rep logins nobody is linked to
//   POST /rep-accounts/link     { repId, email }  link an existing login to a rep ({ email: null } unlinks)
//   POST /rep-accounts/create   { repId, email }  make a NEW login for a rep (role rep) and link it; the
//                               one-time starting password is shown to the Owner once and never stored or logged
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');

const router = express.Router();

// The test suite replaces this; in production it talks to Supabase with the service key.
let admin = null;
function setAdmin(a) { admin = a; }
function realAdmin() {
  if(!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) return null;
  const { createClient } = require('@supabase/supabase-js');
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return {
    async listUsers() {
      const { data, error } = await c.auth.admin.listUsers({ page: 1, perPage: 200 });
      if(error || !data) throw new Error(error ? error.message : 'no user list');
      return data.users.map(u => ({ email: u.email, role: (u.app_metadata && u.app_metadata.role) || 'owner' }));
    },
    async createUser(email, password) {
      const { data, error } = await c.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: 'rep' } });
      if(error) throw new Error(error.message);
      return { email: data.user.email };
    },
  };
}
const adm = () => admin || (admin = realAdmin());

const norm = e => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const reps = await db.prepare('SELECT rep_id, name, zone, status, email FROM reps ORDER BY created_at ASC').all();
  let logins = null, loginError = null;
  try { const a = adm(); logins = a ? await a.listUsers() : null; if(!a) loginError = 'The server cannot list logins (Supabase keys not set).'; }
  catch(e) { loginError = e.message; }
  const byEmail = new Map((logins || []).map(u => [norm(u.email), u]));
  const linked = new Set(reps.filter(r => r.email).map(r => norm(r.email)));
  res.json({
    reps: reps.map(r => {
      const u = r.email ? byEmail.get(norm(r.email)) : null;
      return { repId: r.rep_id, name: r.name, zone: r.zone, status: r.status || 'active', email: r.email || null,
               loginFound: logins ? !!u : null, loginRole: u ? u.role : null };
    }),
    // Logins tagged as reps that no rep record points at yet — candidates to link.
    freeLogins: (logins || []).filter(u => u.role === 'rep' && !linked.has(norm(u.email))).map(u => u.email),
    loginError,
  });
});

router.post('/link', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { repId } = req.body || {};
  const email = req.body && req.body.email ? norm(req.body.email) : null;
  const rep = await db.prepare('SELECT rep_id, name, email FROM reps WHERE rep_id = ?').get(String(repId || ''));
  if(!rep) return res.status(404).json({ error: 'Rep not found.' });
  if(email) {
    if(!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That does not look like an e-mail address.' });
    const other = await db.prepare('SELECT name FROM reps WHERE LOWER(email) = ? AND rep_id <> ?').get(email, rep.rep_id);
    if(other) return res.status(409).json({ error: `That login is already linked to ${other.name}.` });
    const a = adm();
    if(a) {
      let users = [];
      try { users = await a.listUsers(); } catch(e) { return res.status(502).json({ error: 'Could not check the login list: ' + e.message }); }
      const u = users.find(x => norm(x.email) === email);
      if(!u) return res.status(404).json({ error: 'No login with that e-mail exists yet. Use "Create login" instead.' });
      if(u.role !== 'rep') return res.status(400).json({ error: `That login's role is "${u.role}", not "rep". Only logins made as sales reps can be linked.` });
    }
  }
  await db.prepare('UPDATE reps SET email = ? WHERE rep_id = ?').run(email, rep.rep_id);
  console.log(`[audit] Rep ${rep.name} ${email ? 'linked to login ' + email : 'unlinked'} by ${req.user.email}`);
  res.json({ ok: true, repId: rep.rep_id, name: rep.name, email });
});

router.post('/create', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { repId } = req.body || {};
  const email = norm(req.body && req.body.email);
  const rep = await db.prepare('SELECT rep_id, name, email FROM reps WHERE rep_id = ?').get(String(repId || ''));
  if(!rep) return res.status(404).json({ error: 'Rep not found.' });
  if(!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Type the rep\'s e-mail address.' });
  if(rep.email) return res.status(409).json({ error: `${rep.name} already has a login (${rep.email}). Unlink it first if it should change.` });
  const other = await db.prepare('SELECT name FROM reps WHERE LOWER(email) = ?').get(email);
  if(other) return res.status(409).json({ error: `That e-mail is already linked to ${other.name}.` });
  const a = adm();
  if(!a) return res.status(500).json({ error: 'The server cannot create logins (Supabase keys not set).' });
  const password = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, 'x') + '7a';
  try { await a.createUser(email, password); }
  catch(e) { return res.status(502).json({ error: 'Could not create the login: ' + e.message }); }
  await db.prepare('UPDATE reps SET email = ? WHERE rep_id = ?').run(email, rep.rep_id);
  console.log(`[audit] Login created for rep ${rep.name} (${email}) by ${req.user.email}`);
  res.status(201).json({ ok: true, repId: rep.rep_id, name: rep.name, email, startingPassword: password });
});

router.setAdmin = setAdmin;
module.exports = router;
