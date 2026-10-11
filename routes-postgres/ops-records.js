const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Oct 11 2026 — the stock movement log and the selling-price history used to exist
// only in the browser that made the entry, so a Stock Movement Register printed on
// a second device had gaps, and the "new batch — price review needed" check read an
// incomplete history. Both now live here. Records are saved once and never changed.
//
//   stock_move  receipts, dispatches and damage. Any signed-in staff member may add
//               one (a rep's dispatch writes a "sell" entry). The cost per crate is
//               only ever sent back to the Owner.
//   price_set   every selling-price change. Owner only, both ways: it carries the
//               batch cost and margin.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanBatches(arr) {
  if(!Array.isArray(arr)) return undefined;
  return arr.slice(0, 40).map(b => {
    const o = {};
    if(b && typeof b === 'object') {
      if(typeof b.batchId === 'string') o.batchId = b.batchId.slice(0, 60);
      if(typeof b.supplier === 'string') o.supplier = b.supplier.slice(0, 160);
      if(typeof b.cost === 'number' && Number.isFinite(b.cost)) o.cost = b.cost;
      if(typeof b.qty === 'number' && Number.isFinite(b.qty)) o.qty = b.qty;
    }
    return o;
  });
}

const KINDS = {
  stock_move: {
    idRe: /^sm[A-Za-z0-9_]{6,80}$/,
    str: { date: 10, type: 30, ref: 80, supplier: 160, notes: 500, at: 40 },
    num: ['qty', 'cost'],
    ownerOnlyFields: ['cost'],
    required: d => DATE_RE.test(d.date || '') && d.type && Number.isFinite(d.qty),
    readRoles: null,          // any signed-in staff
    writeRoles: null,
  },
  price_set: {
    idRe: /^ps[A-Za-z0-9_]{6,80}$/,
    str: { setAt: 10, setBy: 80, reasonCategory: 40, note: 500, batchId: 60, at: 40 },
    num: ['price', 'batchCost', 'margin'],
    ownerOnlyFields: [],
    required: d => DATE_RE.test(d.setAt || '') && d.price > 0,
    readRoles: ['owner'],
    writeRoles: ['owner'],
  },
};

function clean(kind, id, b) {
  const spec = KINDS[kind];
  const data = { id };
  for(const [k, max] of Object.entries(spec.str)) {
    if(typeof b[k] === 'string') data[k] = b[k].slice(0, max);
  }
  for(const k of spec.num) {
    if(typeof b[k] === 'number' && Number.isFinite(b[k])) data[k] = b[k];
    else if(b[k] === null) data[k] = null;
  }
  if(kind === 'stock_move') {
    const bs = cleanBatches(b.batches);
    if(bs) data.batches = bs;
  }
  if(!spec.required(data)) return { error: `That ${kind.replace('_', ' ')} is missing required details.` };
  return { data };
}

function fromRow(r, role, spec) {
  const d = (r.data && typeof r.data === 'object') ? { ...r.data } : {};
  if(role !== 'owner') {
    (spec.ownerOnlyFields || []).forEach(k => { delete d[k]; });
    if(Array.isArray(d.batches)) d.batches = d.batches.map(b => { const c = { ...b }; delete c.cost; return c; });
  }
  return { ...d, id: r.id, serverCreatedAt: r.created_at && new Date(r.created_at).toISOString() };
}

function allowed(roles, req) { return !roles || roles.includes(req.user && req.user.role); }

function kindOr400(req, res) {
  const kind = String(req.params.kind || '');
  if(!KINDS[kind]) { res.status(400).json({ error: 'Unknown record kind.' }); return null; }
  return kind;
}

// ?since=<ISO time> returns only rows saved after that moment, so a device that
// refreshes every 75 seconds does not download the whole history each time.
router.get('/:kind', requireSupabaseAuth(), async (req, res) => {
  const kind = kindOr400(req, res); if(!kind) return;
  const spec = KINDS[kind];
  if(!allowed(spec.readRoles, req)) return res.status(403).json({ error: 'Your role cannot read these records.' });
  const role = req.user && req.user.role;
  let rows;
  const since = req.query && req.query.since ? new Date(String(req.query.since)) : null;
  if(since && !isNaN(since.getTime())) {
    rows = await db.prepare('SELECT * FROM ops_records WHERE kind = ? AND created_at > ?::timestamptz ORDER BY created_at DESC LIMIT 5000').all(kind, since.toISOString());
  } else {
    rows = await db.prepare('SELECT * FROM ops_records WHERE kind = ? ORDER BY created_at DESC LIMIT 5000').all(kind);
  }
  res.json(rows.map(r => fromRow(r, role, spec)));
});

router.put('/:kind/:id', requireSupabaseAuth(), async (req, res) => {
  const kind = kindOr400(req, res); if(!kind) return;
  const spec = KINDS[kind];
  if(!allowed(spec.writeRoles, req)) return res.status(403).json({ error: 'Your role cannot save these records.' });
  const id = String(req.params.id || '');
  if(!spec.idRe.test(id)) return res.status(400).json({ error: 'Invalid record id.' });
  const c = clean(kind, id, req.body || {});
  if(c.error) return res.status(400).json({ error: c.error });
  const by = (req.user && req.user.email) || null;
  // Saved once, never changed: a repeat of the same id is simply ignored.
  await db.prepare(`
    INSERT INTO ops_records (kind, id, data, created_by)
    VALUES (?, ?, ?::jsonb, ?)
    ON CONFLICT (kind, id) DO NOTHING
  `).run(kind, id, JSON.stringify(c.data), by);
  const row = await db.prepare('SELECT * FROM ops_records WHERE kind = ? AND id = ?').get(kind, id);
  res.status(201).json(fromRow(row, req.user && req.user.role, spec));
});

module.exports = router;
