const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');
const push = require('../lib/push');

const router = express.Router();

// Oct 15 2026 — Owner approval for a sale that did not come through the Orders Inbox.
//
// A rep (or manager) who records a sale in Record Sale or Quick Entry with no order behind it, or with a live order that
// skipped the Orders Inbox checks (payment verified, payment terms, waybill delivered), cannot save it until the Owner
// approves. The rep's screen sends the request, waits, and saves the sale once it is approved. The Owner never needs one.
//
// 1. POST /sale-approvals            any staff login: ask for approval (or get the one already open for the same sale).
// 2. GET  /sale-approvals/mine/:id   the person who asked (or the Owner): where it stands.
// 3. GET  /sale-approvals/owner      Owner only: waiting requests, plus what was decided in the last day.
// 4. POST /sale-approvals/:id/decision  Owner only: approve or decline.
// 5. POST /sale-approvals/:id/used   the person who asked: the sale was saved with this approval (one use only).
//
// An approval lasts 30 minutes; a request nobody answers lapses after 12 hours.

const APPROVAL_MINUTES = 30;
const PENDING_HOURS = 12;
const naira = n => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function shape(r) {
  const now = Date.now();
  let status = r.status;
  if(status === 'pending' && now - new Date(r.requested_at).getTime() > PENDING_HOURS * 3600000) status = 'expired';
  if(status === 'approved' && r.decided_at && now - new Date(r.decided_at).getTime() > APPROVAL_MINUTES * 60000) status = 'expired';
  return {
    id: r.id, status, kind: r.kind, orderRef: r.order_ref, requestedBy: r.requested_by, rep: r.rep_name, customer: r.customer_name,
    crates: Number(r.crates), price: Number(r.price_per_crate), delivery: Number(r.delivery_per_crate), payment: r.payment,
    requestedAt: r.requested_at, decidedBy: r.decided_by, decidedAt: r.decided_at, declineReason: r.decline_reason,
  };
}

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const b = req.body || {};
  const me = req.user && req.user.email;
  if(!me) return res.status(401).json({ error: 'Sign in first.' });
  if(req.user.role === 'owner') return res.status(400).json({ error: 'The Owner does not need approval.' });
  const customer = clean(b.customer, 200);
  const crates = parseInt(b.crates, 10);
  const price = Number(b.price);
  const delivery = Number(b.delivery) || 0;
  if(!customer) return res.status(400).json({ error: 'Customer is required.' });
  if(!Number.isInteger(crates) || crates < 1 || crates > 100000) return res.status(400).json({ error: 'Crates must be a whole number from 1 to 100000.' });
  if(!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Price is required.' });
  const kind = b.kind === 'skipped_inbox' ? 'skipped_inbox' : 'no_order';
  const rep = clean(b.rep, 120) || null;
  const payment = clean(b.payment, 40) || null;
  const orderRef = clean(b.orderRef, 80) || null;

  // The same sale asked for twice (a second tap, a reload) gets the request that is already open.
  const open = await db.prepare(`
    SELECT * FROM sale_approvals
    WHERE lower(requested_by) = lower(?) AND lower(customer_name) = lower(?) AND crates = ? AND price_per_crate = ? AND delivery_per_crate = ?
      AND COALESCE(payment, '') = COALESCE(?, '') AND COALESCE(rep_name, '') = COALESCE(?, '')
      AND ((status = 'pending' AND requested_at > now() - interval '${PENDING_HOURS} hours')
        OR (status = 'approved' AND decided_at > now() - interval '${APPROVAL_MINUTES} minutes'))
    ORDER BY id DESC LIMIT 1`).get(me, customer, crates, price, delivery, payment, rep);
  if(open) return res.json(shape(open));

  const row = await db.prepare(`
    INSERT INTO sale_approvals (requested_by, rep_name, customer_name, crates, price_per_crate, delivery_per_crate, payment, kind, order_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(me, rep, customer, crates, price, delivery, payment, kind, orderRef);
  const id = row && (row.lastInsertRowid || row.id);
  const saved = await db.prepare('SELECT * FROM sale_approvals WHERE id = ?').get(id);
  console.log(`[audit] Sale approval #${id} asked by ${me}: ${customer} · ${crates} crates (${kind})`);
  push.notifyOwners({
    title: '🔔 A sale needs your approval',
    body: `${rep || me} · ${customer} · ${crates} crates · ${naira((price + delivery) * crates)}`,
    url: '/famad-erp.html', tag: 'sale-approval-' + id, kind: 'sale_approval',
  }).catch(e => console.error('[sale-approvals] push failed:', e.message));
  res.status(201).json(shape(saved));
});

router.get('/owner', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT * FROM sale_approvals
    WHERE (status = 'pending' AND requested_at > now() - interval '${PENDING_HOURS} hours')
       OR requested_at > now() - interval '24 hours'
    ORDER BY id DESC LIMIT 200`).all();
  res.json(rows.map(shape));
});

router.get('/mine/:id', requireSupabaseAuth(), async (req, res) => {
  const row = await db.prepare('SELECT * FROM sale_approvals WHERE id = ?').get(parseInt(req.params.id, 10) || 0);
  if(!row) return res.status(404).json({ error: 'Request not found.' });
  const me = String((req.user && req.user.email) || '').toLowerCase();
  if(req.user.role !== 'owner' && String(row.requested_by).toLowerCase() !== me) return res.status(404).json({ error: 'Request not found.' });
  res.json(shape(row));
});

router.post('/:id/decision', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const action = String((req.body && req.body.action) || '');
  if(action !== 'approve' && action !== 'decline') return res.status(400).json({ error: 'action must be approve or decline.' });
  const reason = clean(req.body && req.body.reason, 300) || null;
  const by = (req.user && req.user.email) || null;
  const row = await db.prepare('SELECT * FROM sale_approvals WHERE id = ?').get(id);
  if(!row) return res.status(404).json({ error: 'Request not found.' });
  const want = action === 'approve' ? 'approved' : 'declined';
  if(row.status === want) return res.json({ ...shape(row), unchanged: true });
  if(row.status !== 'pending') return res.status(409).json({ error: 'That request has already been ' + row.status + '.' });
  if(shape(row).status === 'expired') return res.status(409).json({ error: 'That request is too old. Ask the rep to send it again.' });
  await db.prepare(`UPDATE sale_approvals SET status = ?, decided_by = ?, decided_at = now(), decline_reason = ? WHERE id = ? AND status = 'pending'`)
    .run(want, by, action === 'decline' ? reason : null, id);
  console.log(`[audit] Sale approval #${id} ${want} by ${by}`);
  res.json(shape(await db.prepare('SELECT * FROM sale_approvals WHERE id = ?').get(id)));
});

router.post('/:id/used', requireSupabaseAuth(), async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const row = await db.prepare('SELECT * FROM sale_approvals WHERE id = ?').get(id);
  const me = String((req.user && req.user.email) || '').toLowerCase();
  if(!row || String(row.requested_by).toLowerCase() !== me) return res.status(404).json({ error: 'Request not found.' });
  if(row.status === 'used') return res.json({ ...shape(row), unchanged: true });
  if(row.status !== 'approved') return res.status(409).json({ error: 'That request is not approved.' });
  await db.prepare(`UPDATE sale_approvals SET status = 'used', used_at = now(), inv_ref = ? WHERE id = ? AND status = 'approved'`).run(clean(req.body && req.body.inv, 80) || null, id);
  res.json(shape(await db.prepare('SELECT * FROM sale_approvals WHERE id = ?').get(id)));
});

module.exports = router;
