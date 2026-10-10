const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Large first-timer alerts (Oct 10 2026). When a brand-new customer tries to
// reserve more crates than the new-customer limit, the portal now sends an
// alert here instead of keeping it in the customer's own phone, so staff on
// any device see it. Same shape as volume-requests.js.
const REF_RE = /^BEL-LFT-\d{6}-\d{6}$/;
const STATUSES = ['new', 'handled'];
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const digitsOf = s => String(s || '').replace(/\D/g, '');
const isoOrNull = v => { if(typeof v !== 'string') return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

function fromRow(r) {
  const d = (r.data && typeof r.data === 'object') ? r.data : {};
  return {
    ...d,
    ref: r.ref, name: r.name, phone: r.phone, location: r.location || '',
    crates: r.crates, cap: r.cap, status: r.status,
    at: d.at || (r.alerted_at && new Date(r.alerted_at).toISOString()),
    serverUpdatedAt: r.updated_at && new Date(r.updated_at).toISOString(),
  };
}

function clean(b, trustedClock) {
  const ref = str(b.ref, 40);
  if(!REF_RE.test(ref)) return { error: 'A valid alert reference is required.' };
  const name = str(b.name, 120);
  if(!name) return { error: 'name is required.' };
  const phone = str(b.phone, 30);
  if(digitsOf(phone).length < 10) return { error: 'A valid phone number is required.' };
  const crates = toInt(b.crates);
  if(crates < 1 || crates > 100000) return { error: 'crates must be between 1 and 100000.' };
  let at = isoOrNull(b.at);
  const skew = at ? Date.now() - new Date(at).getTime() : null;
  const off = skew === null || (trustedClock ? skew < -2 * 86400000 : Math.abs(skew) > 2 * 86400000);
  if(off) at = new Date().toISOString();
  const data = { ref, name, phone, location: str(b.location, 200), crates, cap: Math.max(0, toInt(b.cap)), at, status: 'new' };
  return { ref, name, phone, crates, cap: data.cap, location: data.location, at, data };
}

// Customer's phone (portal key) — raise an alert.
router.post('/', requireEitherAuth(), async (req, res) => {
  const c = clean(req.body || {});
  if(c.error) return res.status(400).json({ error: c.error });
  const existing = await db.prepare('SELECT * FROM large_first_timer_alerts WHERE ref = ?').get(c.ref);
  if(existing) return res.status(200).json(fromRow(existing));

  const recent = await db.prepare(`
    SELECT COUNT(*)::int AS n FROM large_first_timer_alerts
    WHERE RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ? AND alerted_at > now() - interval '1 hour'
  `).get(digitsOf(c.phone).slice(-10));
  if(recent && recent.n >= 10) return res.status(429).json({ error: 'Too many alerts from this phone number.' });

  await db.prepare(`
    INSERT INTO large_first_timer_alerts (ref, name, phone, location, crates, cap, status, data, alerted_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?::jsonb, ?)
    ON CONFLICT (ref) DO NOTHING
  `).run(c.ref, c.name, c.phone, c.location, c.crates, c.cap, JSON.stringify(c.data), c.at);
  res.status(201).json(fromRow(await db.prepare('SELECT * FROM large_first_timer_alerts WHERE ref = ?').get(c.ref)));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM large_first_timer_alerts ORDER BY alerted_at DESC LIMIT 1000').all();
  res.json(rows.map(fromRow));
});

// Staff — mark handled (or adopt an alert that only existed in one browser).
router.put('/:ref', requireSupabaseAuth(), async (req, res) => {
  const ref = str(req.params.ref, 40);
  if(!REF_RE.test(ref)) return res.status(400).json({ error: 'Invalid alert reference.' });
  const b = req.body || {};
  const status = STATUSES.includes(b.status) ? b.status : null;
  if(!status) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}.` });
  const by = (req.user && req.user.email) || null;

  const existing = await db.prepare('SELECT * FROM large_first_timer_alerts WHERE ref = ?').get(ref);
  if(existing) {
    // Handled is final; an out-of-date browser copy cannot reopen it.
    if(existing.status === 'handled' && status !== 'handled') return res.json(fromRow(existing));
    await db.prepare(`
      UPDATE large_first_timer_alerts SET status = ?, data = data || ?::jsonb, updated_at = now(), updated_by = ? WHERE ref = ?
    `).run(status, JSON.stringify({ status }), by, ref);
    return res.json(fromRow(await db.prepare('SELECT * FROM large_first_timer_alerts WHERE ref = ?').get(ref)));
  }
  const c = clean({ ...b, ref }, true);
  if(c.error) return res.status(400).json({ error: c.error });
  await db.prepare(`
    INSERT INTO large_first_timer_alerts (ref, name, phone, location, crates, cap, status, data, alerted_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
    ON CONFLICT (ref) DO NOTHING
  `).run(ref, c.name, c.phone, c.location, c.crates, c.cap, status, JSON.stringify({ ...c.data, status }), c.at, by);
  console.log(`[audit] Large first-timer alert ${ref} adopted from a browser copy by ${by}`);
  res.status(201).json(fromRow(await db.prepare('SELECT * FROM large_first_timer_alerts WHERE ref = ?').get(ref)));
});

module.exports = router;
