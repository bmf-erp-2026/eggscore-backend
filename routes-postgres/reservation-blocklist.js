const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');
const { normPhone } = require('../lib/portal-checks');

const router = express.Router();

// The blocklist (Oct 10 2026). Phone numbers staff have blocked from
// ordering or reserving. It used to exist only in the one ERP browser where
// it was typed in, so the customer portal — a different device entirely —
// never saw it and blocked nobody. Now the server holds the list and checks
// it on every portal order itself.
//
// Staff only: the customer side never reads this list (it only learns "this
// could not be completed", never why).
const ID_RE = /^bl[0-9A-Za-z]{4,40}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function fromRow(r) {
  return {
    id: r.id, phone: r.phone, name: r.name || '', reason: r.reason || '',
    blockedBy: r.blocked_by || '', blockedAt: r.blocked_at && new Date(r.blocked_at).toISOString(),
  };
}

router.get('/', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM reservation_blocklist ORDER BY blocked_at DESC LIMIT 2000').all();
  res.json(rows.map(fromRow));
});

// Add (or re-save) one entry. Any signed-in staff may block a number.
router.put('/:id', requireSupabaseAuth(), async (req, res) => {
  const id = String(req.params.id || '');
  if(!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid blocklist id.' });
  const b = req.body || {};
  const phone = str(b.phone, 30);
  const norm = normPhone(phone);
  if(norm.length < 7) return res.status(400).json({ error: 'A valid phone number is required.' });
  const blockedAt = b.blockedAt && !isNaN(new Date(b.blockedAt).getTime()) ? new Date(b.blockedAt).toISOString() : null;
  const by = (req.user && req.user.email) || null;

  const existing = await db.prepare('SELECT id FROM reservation_blocklist WHERE id = ?').get(id);
  if(existing) {
    await db.prepare(`
      UPDATE reservation_blocklist SET phone = ?, phone_norm = ?, name = ?, reason = ?, updated_at = now() WHERE id = ?
    `).run(phone, norm, str(b.name, 160), str(b.reason, 300), id);
  } else {
    await db.prepare(`
      INSERT INTO reservation_blocklist (id, phone, phone_norm, name, reason, blocked_by, blocked_at)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?::timestamptz, now()))
      ON CONFLICT (id) DO NOTHING
    `).run(id, phone, norm, str(b.name, 160), str(b.reason, 300), str(b.blockedBy, 80) || by, blockedAt);
    console.log(`[audit] Phone blocklisted (${id}) by ${by}`);
  }
  res.status(existing ? 200 : 201).json(fromRow(await db.prepare('SELECT * FROM reservation_blocklist WHERE id = ?').get(id)));
});

// Lifting a block is the Owner's decision.
router.delete('/:id', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const id = String(req.params.id || '');
  if(!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid blocklist id.' });
  await db.prepare('DELETE FROM reservation_blocklist WHERE id = ?').run(id);
  console.log(`[audit] Phone unblocked (${id}) by ${(req.user && req.user.email) || 'unknown'}`);
  res.json({ ok: true });
});

module.exports = router;
