const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Volume Requests (Oct 10 2026) — a customer whose need is bigger than the
// stock shown on the portal can leave a request. Until now that request was
// written ONLY into the browser the customer used, so the Owner's ERP never
// saw it unless it happened to be the very same browser. This route is the
// missing bridge, copying the pattern feedback.js already proves:
//   * the portal POSTs a new request (x-api-key, no login)
//   * staff read the list and update progress (real ERP login)
// The full record is kept as JSON in `data`, with the few fields staff filter
// on (ref, status, phone ...) also held as plain columns.

const REF_RE = /^BEL-VOL-\d{6}-\d{6}$/;
const STATUSES = ['new', 'contacted', 'resolved', 'declined'];

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const digitsOf = s => String(s || '').replace(/\D/g, '');
const isoOrNull = v => {
  if(typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// One row -> the object shape the ERP already works with.
function fromRow(row) {
  const d = (row.data && typeof row.data === 'object') ? row.data : {};
  return {
    ...d,
    ref: row.ref,
    customerName: row.customer_name,
    phone: row.phone,
    qtyRequested: row.qty_requested,
    status: row.status,
    source: row.source,
    submittedAt: d.submittedAt || (row.submitted_at && new Date(row.submitted_at).toISOString()),
    serverUpdatedAt: row.updated_at && new Date(row.updated_at).toISOString(),
  };
}

// The fields a customer's phone is allowed to set — and nothing else.
// Status is always 'new' here; a customer cannot mark their own request
// contacted or resolved.
function cleanSubmission(b, trustedClock) {
  const ref = str(b.ref, 40);
  if(!REF_RE.test(ref)) return { error: 'A valid request reference is required.' };
  const customerName = str(b.customerName, 120);
  if(!customerName) return { error: 'customerName is required.' };
  const phone = str(b.phone, 30);
  if(digitsOf(phone).length < 10) return { error: 'A valid phone number is required.' };
  const qty = toInt(b.qtyRequested);
  if(qty < 1 || qty > 100000) return { error: 'qtyRequested must be between 1 and 100000.' };

  // A customer's phone clock can be wrong; only trust its timestamp when it is
  // within two days of the server's own. Staff adopting an older record keep
  // its real original date (anything but the future).
  let submittedAt = isoOrNull(b.submittedAt);
  // An older record that only carries a date and time: rebuild the timestamp.
  if(!submittedAt && trustedClock && /^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) {
    submittedAt = isoOrNull(`${b.date}T${/^\d{2}:\d{2}$/.test(b.time || '') ? b.time : '00:00'}:00+01:00`);   // dates on old records are Lagos time (UTC+1, no daylight saving)
  }
  const skew = submittedAt ? Date.now() - new Date(submittedAt).getTime() : null;
  const tooOff = skew === null || (trustedClock ? skew < -2 * 86400000 : Math.abs(skew) > 2 * 86400000);
  if(tooOff) submittedAt = new Date().toISOString();
  const data = {
    ref,
    date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : submittedAt.slice(0, 10),
    time: /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : submittedAt.slice(11, 16),
    customerName, phone,
    qtyRequested: qty,
    stockAvailableAtRequest: Math.max(0, toInt(b.stockAvailableAtRequest)),
    committedAtRequest: Math.max(0, toInt(b.committedAtRequest)),
    physicalStockAtRequest: Math.max(0, toInt(b.physicalStockAtRequest)),
    submittedAt,
    neededBy: /^\d{4}-\d{2}-\d{2}$/.test(b.neededBy || '') ? b.neededBy : null,
    notes: str(b.notes, 1000),
    status: 'new',
    source: 'portal',
  };
  return { ref, customerName, phone, qty, submittedAt, data };
}

// ── Customer's phone (portal key) — submit a request ──────────────────────
router.post('/', requireEitherAuth(), async (req, res) => {
  const c = cleanSubmission(req.body || {});
  if(c.error) return res.status(400).json({ error: c.error });

  // Sending the same request twice (a retry after a poor connection) is fine
  // and returns the saved record, so the portal can stop retrying.
  const existing = await db.prepare('SELECT * FROM volume_requests WHERE ref = ?').get(c.ref);
  if(existing) return res.status(200).json(fromRow(existing));

  // Gentle spam brake: no more than 10 requests per phone number per hour.
  const recent = await db.prepare(`
    SELECT COUNT(*)::int AS n FROM volume_requests
    WHERE RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ?
      AND submitted_at > now() - interval '1 hour'
  `).get(digitsOf(c.phone).slice(-10));
  if(recent && recent.n >= 10) {
    return res.status(429).json({ error: 'Too many requests from this phone number. Please try again later.' });
  }

  await db.prepare(`
    INSERT INTO volume_requests (ref, customer_name, phone, qty_requested, status, source, data, submitted_at)
    VALUES (?, ?, ?, ?, 'new', 'portal', ?::jsonb, ?)
    ON CONFLICT (ref) DO NOTHING
  `).run(c.ref, c.customerName, c.phone, c.qty, JSON.stringify(c.data), c.submittedAt);

  res.status(201).json(fromRow(await db.prepare('SELECT * FROM volume_requests WHERE ref = ?').get(c.ref)));
});

// ── Staff — every request, newest first ───────────────────────────────────
router.get('/', requireSupabaseAuth(), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM volume_requests ORDER BY submitted_at DESC LIMIT 1000').all();
  res.json(rows.map(fromRow));
});

// ── Staff — save progress on a request ────────────────────────────────────
// Also used by the ERP to "adopt" requests that were created before this route
// existed and are still sitting in one browser's own storage. Only the
// follow-up fields can change on a request that already exists; what the
// customer originally asked for is never overwritten.
const WORKFLOW_STR = ['respondedAt', 'closedAt', 'resolvedAt', 'resolvedVia', 'linkedInvoice', 'declineReason', 'declineNotes'];

router.put('/:ref', requireSupabaseAuth(), async (req, res) => {
  const ref = str(req.params.ref, 40);
  if(!REF_RE.test(ref)) return res.status(400).json({ error: 'Invalid request reference.' });
  const b = req.body || {};
  const status = STATUSES.includes(b.status) ? b.status : null;
  if(!status) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}.` });

  const patch = {};
  for(const k of WORKFLOW_STR) {
    if(typeof b[k] === 'string' && b[k]) patch[k] = b[k].slice(0, k === 'declineNotes' ? 1000 : 120);
  }
  const by = (req.user && req.user.email) || null;

  const existing = await db.prepare('SELECT * FROM volume_requests WHERE ref = ?').get(ref);
  if(existing) {
    // "Resolved" has to be earned by a real recorded sale; never walk it back.
    if(existing.status === 'resolved' && status !== 'resolved') return res.json(fromRow(existing));
    await db.prepare(`
      UPDATE volume_requests
      SET status = ?, data = data || ?::jsonb, updated_at = now(), updated_by = ?
      WHERE ref = ?
    `).run(status, JSON.stringify({ ...patch, status }), by, ref);
    return res.json(fromRow(await db.prepare('SELECT * FROM volume_requests WHERE ref = ?').get(ref)));
  }

  // Not on the server yet: adopt it (staff only), keeping the original fields.
  const base = cleanSubmission({ ...b, ref }, true);
  if(base.error) return res.status(400).json({ error: base.error });
  const data = { ...base.data, ...patch, status };
  await db.prepare(`
    INSERT INTO volume_requests (ref, customer_name, phone, qty_requested, status, source, data, submitted_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
    ON CONFLICT (ref) DO NOTHING
  `).run(ref, base.customerName, base.data.phone, base.qty, status, str(b.source, 20) || 'portal', JSON.stringify(data), base.submittedAt, by);
  console.log(`[audit] Volume request ${ref} adopted from a browser copy by ${by}`);
  res.status(201).json(fromRow(await db.prepare('SELECT * FROM volume_requests WHERE ref = ?').get(ref)));
});

module.exports = router;
