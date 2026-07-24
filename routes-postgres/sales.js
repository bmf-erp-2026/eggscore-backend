const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { orderRef, rep, customerName, crates, pricePerCrate, deliveryTotal, commission,
          batchId, batchCost, paymentMethod, saleDate, invoiceRef } = req.body;

  if(!rep || !customerName || !crates || !pricePerCrate || !paymentMethod) {
    return res.status(400).json({ error: 'rep, customerName, crates, pricePerCrate, and paymentMethod are required.' });
  }

  const gross = crates * pricePerCrate;
  const info = await db.prepare(`
    INSERT INTO sales (order_ref, rep, customer_name, crates, price_per_crate, gross, delivery_total,
      commission, batch_id, batch_cost, payment_method, sale_date, invoice_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderRef || null, rep, customerName, crates, pricePerCrate, gross, deliveryTotal || 0,
    commission || 0, batchId || null, batchCost || null, paymentMethod, saleDate || new Date().toISOString().split('T')[0], invoiceRef || null);

  // Real multi-batch FIFO deduction — same logic verified in the
  // SQLite version, converted to properly-awaited Postgres calls.
  if(batchId) {
    let remaining = crates;
    const batches = await db.prepare('SELECT * FROM batches WHERE remaining > 0 ORDER BY received_date ASC').all();
    const startIdx = batches.findIndex(b => b.id === batchId);
    const orderedBatches = startIdx >= 0 ? batches.slice(startIdx) : batches;
    for(const b of orderedBatches) {
      if(remaining <= 0) break;
      const take = Math.min(remaining, b.remaining);
      await db.prepare('UPDATE batches SET remaining = remaining - ? WHERE id = ?').run(take, b.id);
      remaining -= take;
    }
  }

  res.status(201).json(await db.prepare('SELECT * FROM sales WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  const { from, to, rep } = req.query;
  let query = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if(from) { query += ' AND sale_date >= ?'; params.push(from); }
  if(to)   { query += ' AND sale_date <= ?'; params.push(to); }
  if(rep)  { query += ' AND rep = ?'; params.push(rep); }
  query += ' ORDER BY sale_date DESC, created_at DESC';
  res.json(await db.prepare(query).all(...params));
});

module.exports = router;
