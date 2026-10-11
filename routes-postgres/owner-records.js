const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');

const router = express.Router();

// Money records (Oct 10 2026, Stage 2): commission disputes, overpayments and
// stock write-offs. They used to exist only in the browser that created them,
// so a second device showed no open dispute (and let a payout go ahead that
// should have been held), no refund still owed, and no write-off in the
// profit figures. Owner only — reps never read or write these.
//
// One table, three kinds. Each kind says which fields it accepts and how a
// record may change after it is first saved:
//   comm_dispute  open -> resolved. A resolved dispute is final.
//   overpayment   saved once; the only later change is "refund sent", and a
//                 sent refund can never be turned back into "owed".
//   write_off     saved once and never changed (it is an audit record).
//   bad_debt      (Oct 11 2026) an unpaid credit balance the Owner has written off
//                 after 90 days. Saved once and never changed. The 90-day rule is
//                 checked here too, so a wrong or tampered browser cannot skip it.
//   bad_debt_recovery  money received later against a bad_debt. Saved once and never
//                 changed; the server refuses a recovery that would take the total
//                 recovered above the amount written off.

const KINDS = {
  comm_dispute: {
    idRe: /^DISP-\d{6,20}$/,
    str: { repName: 120, reason: 200, saleRef: 200, notes: 1000, status: 20, raisedAt: 40, resolvedAt: 40, resolvedBy: 80, outcome: 20, resolutionNotes: 1000 },
    num: ['amount', 'adjustedAmount'],
    bool: [],
    required: d => d.repName && d.amount > 0 && ['open', 'resolved'].includes(d.status),
    summary: d => d.status,
  },
  overpayment: {
    idRe: /^op\d{6,20}$/,
    str: { customerName: 160, orderRef: 60, resolution: 30, date: 10, recordedBy: 80, notes: 500, refundExecutedAt: 40, refundExecutedBy: 80 },
    num: ['invoiceAmount', 'amountReceived', 'excess', 'refundDue'],
    bool: ['refundPending', 'refundExecuted'],
    required: d => d.customerName && d.orderRef && d.excess > 0 && ['wallet', 'refund', 'balance'].includes(d.resolution),
    summary: d => d.resolution !== 'refund' ? 'closed' : (d.refundExecuted ? 'refund_sent' : 'refund_pending'),
  },
  write_off: {
    idRe: /^wo\d{6,20}$/,
    str: { batchId: 60, supplier: 160, reason: 60, notes: 500, date: 10, recordedBy: 80 },
    num: ['qty', 'costPerCrate', 'valueLost'],
    bool: [],
    required: d => d.batchId && d.qty > 0 && d.valueLost >= 0,
    summary: () => 'recorded',
  },
  bad_debt: {
    idRe: /^bd\d{6,20}$/,
    str: { saleRef: 80, customerName: 160, repName: 120, saleDate: 10, writtenOffDate: 10, reason: 80, notes: 1000, approvedBy: 80, writtenOffAt: 40 },
    num: ['daysOverdue', 'saleGross', 'paidBeforeWriteOff', 'amount', 'commOnUnpaid', 'commHeld', 'commKept', 'repKeepPct'],
    bool: [],
    required: d => d.saleRef && d.customerName && d.amount > 0 && d.saleDate && d.writtenOffDate
      && /^\d{4}-\d{2}-\d{2}$/.test(d.saleDate) && /^\d{4}-\d{2}-\d{2}$/.test(d.writtenOffDate)
      && daysBetween(d.saleDate, d.writtenOffDate) >= BAD_DEBT_MIN_DAYS
      && (d.commHeld == null || (d.commHeld >= 0 && d.commHeld <= (d.commOnUnpaid == null ? d.commHeld : d.commOnUnpaid) + 0.5)),
    summary: () => 'written_off',
  },
  bad_debt_recovery: {
    idRe: /^bdr\d{6,20}$/,
    str: { badDebtId: 40, customerName: 160, method: 30, date: 10, note: 500, recordedBy: 80, recordedAt: 40 },
    num: ['amount'],
    bool: [],
    required: d => /^bd\d{6,20}$/.test(d.badDebtId || '') && d.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.date || ''),
    summary: () => 'received',
  },
};

// The rule the Owner set: a credit balance can be written off only once 90 days
// have passed since the sale date.
const BAD_DEBT_MIN_DAYS = 90;
function daysBetween(a, b) {
  const t1 = Date.parse(a + 'T00:00:00Z'), t2 = Date.parse(b + 'T00:00:00Z');
  if(!Number.isFinite(t1) || !Number.isFinite(t2)) return -1;
  return Math.floor((t2 - t1) / 86400000);
}

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
  for(const k of spec.bool) {
    if(typeof b[k] === 'boolean') data[k] = b[k];
  }
  if(kind === 'comm_dispute' && data.outcome && !['upheld', 'partial', 'dismissed'].includes(data.outcome)) {
    return { error: 'outcome must be upheld, partial or dismissed.' };
  }
  if(!spec.required(data)) return { error: `That ${kind.replace('_', ' ')} is missing required details.` };
  return { data };
}

function fromRow(r) {
  const d = (r.data && typeof r.data === 'object') ? r.data : {};
  return { ...d, id: r.id, serverUpdatedAt: r.updated_at && new Date(r.updated_at).toISOString() };
}

function kindOr400(req, res) {
  const kind = String(req.params.kind || '');
  if(!KINDS[kind]) { res.status(400).json({ error: 'Unknown record kind.' }); return null; }
  return kind;
}

// Customers who still owe written-off money. NAMES ONLY — no amounts, no reasons —
// and readable by any signed-in staff member, because the person recording a sale
// (a rep) must be told "no credit for this customer". The Owner-only lists below
// stay Owner only.
router.get('/credit-blocked/names', requireSupabaseAuth(), async (req, res) => {
  const debts = await db.prepare("SELECT id, data FROM owner_records WHERE kind = 'bad_debt'").all();
  const recs = await db.prepare("SELECT data FROM owner_records WHERE kind = 'bad_debt_recovery'").all();
  const got = {};
  recs.forEach(r => { const d = r.data || {}; got[d.badDebtId] = (got[d.badDebtId] || 0) + (Number(d.amount) || 0); });
  const names = new Set();
  debts.forEach(r => {
    const d = r.data || {};
    if((Number(d.amount) || 0) - (got[r.id] || 0) > 0.5 && d.customerName) names.add(d.customerName);
  });
  res.json({ names: [...names].sort() });
});

router.get('/:kind', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const kind = kindOr400(req, res); if(!kind) return;
  const rows = await db.prepare('SELECT * FROM owner_records WHERE kind = ? ORDER BY created_at DESC LIMIT 5000').all(kind);
  res.json(rows.map(fromRow));
});

router.put('/:kind/:id', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const kind = kindOr400(req, res); if(!kind) return;
  const spec = KINDS[kind];
  const id = String(req.params.id || '');
  if(!spec.idRe.test(id)) return res.status(400).json({ error: 'Invalid record id.' });
  const c = clean(kind, id, req.body || {});
  if(c.error) return res.status(400).json({ error: c.error });
  const by = (req.user && req.user.email) || null;

  const existing = await db.prepare('SELECT * FROM owner_records WHERE kind = ? AND id = ?').get(kind, id);
  if(!existing && kind === 'bad_debt_recovery') {
    const parent = await db.prepare("SELECT data FROM owner_records WHERE kind = 'bad_debt' AND id = ?").get(c.data.badDebtId);
    if(!parent) return res.status(400).json({ error: 'That bad debt is not on the server yet.' });
    const others = await db.prepare("SELECT data FROM owner_records WHERE kind = 'bad_debt_recovery'").all();
    const already = others.reduce((a, r) => a + (((r.data || {}).badDebtId === c.data.badDebtId) ? (Number((r.data || {}).amount) || 0) : 0), 0);
    if(already + c.data.amount > (Number((parent.data || {}).amount) || 0) + 0.5) {
      return res.status(400).json({ error: 'That recovery is more than the amount still owed.' });
    }
  }
  if(!existing) {
    await db.prepare(`
      INSERT INTO owner_records (kind, id, status, data, updated_by)
      VALUES (?, ?, ?, ?::jsonb, ?)
      ON CONFLICT (kind, id) DO NOTHING
    `).run(kind, id, spec.summary(c.data), JSON.stringify(c.data), by);
    console.log(`[audit] ${kind} ${id} saved by ${by}`);
    return res.status(201).json(fromRow(await db.prepare('SELECT * FROM owner_records WHERE kind = ? AND id = ?').get(kind, id)));
  }

  const old = (existing.data && typeof existing.data === 'object') ? existing.data : {};
  let next = null;
  if(kind === 'comm_dispute') {
    // Open -> resolved is the only move. A resolved dispute cannot be changed or reopened.
    if(old.status === 'open' && c.data.status === 'resolved') next = { ...old, ...c.data };
  } else if(kind === 'overpayment') {
    // The only later change: the refund has been sent. It can never go back to "owed".
    if(old.resolution === 'refund' && !old.refundExecuted && c.data.refundExecuted === true) {
      next = { ...old, refundExecuted: true, refundExecutedAt: c.data.refundExecutedAt || null, refundExecutedBy: c.data.refundExecutedBy || null };
    }
  }
  // write_off: never changes.
  if(!next) return res.json({ ...fromRow(existing), ignored: true });

  await db.prepare(`
    UPDATE owner_records SET status = ?, data = ?::jsonb, updated_at = now(), updated_by = ? WHERE kind = ? AND id = ?
  `).run(spec.summary(next), JSON.stringify(next), by, kind, id);
  console.log(`[audit] ${kind} ${id} -> ${spec.summary(next)} by ${by}`);
  res.json(fromRow(await db.prepare('SELECT * FROM owner_records WHERE kind = ? AND id = ?').get(kind, id)));
});

module.exports = router;
