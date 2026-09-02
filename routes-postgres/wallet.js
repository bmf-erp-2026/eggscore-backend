const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireEitherAuth, requireRole } = require('../auth.postgres');
const router = express.Router();

// ERP-only — records a wallet transaction (credit, applied, refund_pending,
// or info). This is the ERP's write path; the portal never creates
// transactions, only reads a balance (see /balance below).
// clientId is the ERP's own 'wt'+Date.now() id — stored so the ERP's
// self-healing retry can tell which local transactions the backend has
// already seen, same role ref/inv/cid play for Orders/Sales/Customers.
// ON CONFLICT makes a retried POST safe — it won't create a duplicate row.
//
// Type-level role split (Sep 1 2026, Sales Rep Access): a rep applying
// EXISTING wallet credit to an order they're processing is normal,
// everyday sales work — Bob's own call: "wallet money is already
// banked... no harm for rep to see and apply." But 'credit' and
// 'refund_pending' both CREATE or return money the wallet didn't
// already have — that's the same trust step as verifying a real bank
// deposit landed (see the Verify Payment modal's own warning elsewhere
// in this app), and stays owner-only regardless of who's logged in.
// 'info' doesn't move money at all (excluded from the /balance sum
// below) so it's harmless either way.
const OWNER_ONLY_WALLET_TYPES = ['credit', 'refund_pending'];

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { customerId, amount, type, orderRef, createdBy, clientId } = req.body;

  if(!customerId || amount == null || !type) {
    return res.status(400).json({ error: 'customerId, amount, and type are required.' });
  }
  if(!['credit', 'applied', 'refund_pending', 'info'].includes(type)) {
    return res.status(400).json({ error: 'type must be one of credit, applied, refund_pending, info.' });
  }
  if(OWNER_ONLY_WALLET_TYPES.includes(type) && req.user.role !== 'owner') {
    return res.status(403).json({ error: `Your role cannot create a '${type}' wallet transaction.` });
  }

  await db.prepare(`
    INSERT INTO wallet_transactions (customer_id, amount, type, order_ref, created_by, client_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (client_id) DO NOTHING
  `).run(customerId, amount, type, orderRef || null, createdBy || null, clientId || null);

  const row = clientId
    ? await db.prepare('SELECT * FROM wallet_transactions WHERE client_id = ?').get(clientId)
    : await db.prepare('SELECT * FROM wallet_transactions WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(customerId);

  res.status(201).json(row);
});

// ERP-only — every wallet transaction across ALL customers. Owner-only
// (Sep 1 2026, Sales Rep Access): this is company-wide wallet exposure
// in one list, not the single-customer context a rep needs to do a
// sale — that's /balance and /:customerId below, both left open.
router.get('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM wallet_transactions ORDER BY created_at DESC').all());
});

// ── Portal-facing balance lookup ──────────────────────────────────────
// Deliberately narrow, same philosophy as customers.js's /search,
// /by-code, /by-referral: only the one number the portal actually
// needs, never the transaction list itself (no order_ref, no dates,
// no created_by). Balance computed live via SUM at query time — no
// cached balance column, so there's no cache-vs-ledger drift possible.
// 'info' transactions are excluded from the reduce below — they're
// audit-trail entries for money that never passed through the wallet.
//
// NOTE: declared BEFORE /:customerId below — Express matches routes in
// declaration order, and "/balance" would otherwise be swallowed by the
// /:customerId param slot (treating "balance" as a literal customer ID).
router.get('/balance', requireEitherAuth(), async (req, res) => {
  const customerName = (req.query.customer || '').trim();
  if(!customerName) return res.json({ balance: 0 });

  const customer = await db.prepare('SELECT id FROM customers WHERE name = ?').get(customerName);
  if(!customer) return res.json({ balance: 0 });

  const rows = await db.prepare(
    `SELECT type, amount FROM wallet_transactions WHERE customer_id = ?`
  ).all(customer.id);

  const balance = rows.reduce((a, t) => {
    if(t.type === 'credit') return a + Number(t.amount);
    if(t.type === 'applied' || t.type === 'refund_pending') return a - Number(t.amount);
    return a;
  }, 0);

  res.json({ balance });
});

// ERP-only — full transaction history for one customer, for the ERP's
// own sync-with-retry (mirrors how Customers/Orders/Sales/Batches sync).
// Deliberately left open to reps (not owner-gated) — the ERP's own
// "Apply wallet credit" UI a rep uses during a normal sale likely
// depends on this sync path to know the correct amount/dedup against
// what's already applied; gating it would risk silently breaking the
// exact feature Bob confirmed reps should keep.
router.get('/:customerId', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare(
    'SELECT * FROM wallet_transactions WHERE customer_id = ? ORDER BY created_at DESC'
  ).all(req.params.customerId));
});

module.exports = router;
