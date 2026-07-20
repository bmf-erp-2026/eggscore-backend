const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// POST /sales — record a fulfilled sale. erp-only; a customer's
// portal key has no business ever writing to the financial ledger.
router.post('/', requireAuth('erp'), (req, res) => {
  const { orderRef, rep, customerName, crates, pricePerCrate, deliveryTotal, commission,
          batchId, batchCost, paymentMethod, saleDate } = req.body;

  if(!rep || !customerName || !crates || !pricePerCrate || !paymentMethod) {
    return res.status(400).json({ error: 'rep, customerName, crates, pricePerCrate, and paymentMethod are required.' });
  }

  const gross = crates * pricePerCrate;
  const info = db.prepare(`
    INSERT INTO sales (order_ref, rep, customer_name, crates, price_per_crate, gross, delivery_total,
      commission, batch_id, batch_cost, payment_method, sale_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderRef || null, rep, customerName, crates, pricePerCrate, gross, deliveryTotal || 0,
    commission || 0, batchId || null, batchCost || null, paymentMethod, saleDate || new Date().toISOString().split('T')[0]);

  // Real multi-batch FIFO deduction — if the given batchId doesn't
  // have enough remaining to cover the full sale, spill into the next
  // batch(es) in received-date order, the same logic already proven
  // correct in /inventory/blended-cost. A naive single-batch clamp
  // here would silently under-deduct stock the moment a sale spans
  // more than one batch — exactly the class of bug this migration
  // exists to close off, not reintroduce.
  if(batchId) {
    let remaining = crates;
    const batches = db.prepare('SELECT * FROM batches WHERE remaining > 0 ORDER BY received_date ASC').all();
    const startIdx = batches.findIndex(b => b.id === batchId);
    const orderedBatches = startIdx >= 0 ? batches.slice(startIdx) : batches;
    for(const b of orderedBatches) {
      if(remaining <= 0) break;
      const take = Math.min(remaining, b.remaining);
      db.prepare('UPDATE batches SET remaining = remaining - ? WHERE id = ?').run(take, b.id);
      remaining -= take;
    }
  }

  res.status(201).json(db.prepare('SELECT * FROM sales WHERE id = ?').get(info.lastInsertRowid));
});

// GET /sales — the Sales Ledger, with the same real Gross + Delivery
// visibility the ERP itself was fixed to show earlier this project.
router.get('/', requireAuth('erp'), (req, res) => {
  const { from, to, rep } = req.query;
  let query = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if(from) { query += ' AND sale_date >= ?'; params.push(from); }
  if(to)   { query += ' AND sale_date <= ?'; params.push(to); }
  if(rep)  { query += ' AND rep = ?'; params.push(rep); }
  query += ' ORDER BY sale_date DESC, created_at DESC';
  res.json(db.prepare(query).all(...params));
});

module.exports = router;
