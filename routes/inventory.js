const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /inventory — real-time stock, readable by both roles since the
// portal needs live availability to show the stock ticker correctly.
router.get('/', requireAuth('erp', 'portal'), (req, res) => {
  const batches = db.prepare('SELECT * FROM batches WHERE remaining > 0 ORDER BY received_date ASC').all();
  const totalAvailable = batches.reduce((sum, b) => sum + b.remaining, 0);
  res.json({ totalAvailable, batches });
});

// POST /inventory/batches — the ERP receives new stock. erp-only.
router.post('/batches', requireAuth('erp'), (req, res) => {
  const { id, supplier, cost, received, qaGrade, receivedDate } = req.body;
  if(!id || !cost || !received) {
    return res.status(400).json({ error: 'id, cost, and received are required.' });
  }
  db.prepare(`
    INSERT INTO batches (id, supplier, cost, received, remaining, qa_grade, received_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, supplier || null, cost, received, received, qaGrade || null, receivedDate || new Date().toISOString().split('T')[0]);

  res.status(201).json(db.prepare('SELECT * FROM batches WHERE id = ?').get(id));
});

// GET /inventory/blended-cost?crates=N — the real FIFO-weighted blend
// for a given quantity, computed server-side so the portal, the ERP,
// and any future client all read from one identical calculation
// rather than three separately-maintained copies of the same formula.
router.get('/blended-cost', requireAuth('erp', 'portal'), (req, res) => {
  const qty = parseInt(req.query.crates) || 0;
  if(qty <= 0) return res.status(400).json({ error: 'crates query param must be a positive integer.' });

  const batches = db.prepare('SELECT * FROM batches WHERE remaining > 0 ORDER BY received_date ASC').all();
  let remaining = qty, totalCost = 0, cratesFilled = 0;
  const draws = [];
  for(const b of batches) {
    if(remaining <= 0) break;
    const take = Math.min(remaining, b.remaining);
    draws.push({ batchId: b.id, supplier: b.supplier, qty: take, cost: b.cost });
    totalCost += take * b.cost;
    cratesFilled += take;
    remaining -= take;
  }
  const blendedCost = cratesFilled > 0 ? Math.round((totalCost / cratesFilled) * 100) / 100 : 0;
  res.json({ requestedCrates: qty, cratesFilled, blendedCost, spansBatches: draws.length > 1, draws });
});

module.exports = router;
