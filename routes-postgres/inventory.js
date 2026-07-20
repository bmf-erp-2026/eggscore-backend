const express = require('express');
const { db } = require('../db.postgres');
const { requireEitherAuth, requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

router.get('/', requireEitherAuth(), async (req, res) => {
  const batches = await db.prepare('SELECT * FROM batches WHERE remaining > 0 ORDER BY received_date ASC').all();
  const totalAvailable = batches.reduce((sum, b) => sum + b.remaining, 0);
  res.json({ totalAvailable, batches });
});

router.post('/batches', requireSupabaseAuth(), async (req, res) => {
  const { id, supplier, cost, received, qaGrade, receivedDate } = req.body;
  if(!id || !cost || !received) {
    return res.status(400).json({ error: 'id, cost, and received are required.' });
  }
  await db.prepare(`
    INSERT INTO batches (id, supplier, cost, received, remaining, qa_grade, received_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, supplier || null, cost, received, received, qaGrade || null, receivedDate || new Date().toISOString().split('T')[0]);
  res.status(201).json(await db.prepare('SELECT * FROM batches WHERE id = ?').get(id));
});

router.get('/blended-cost', requireEitherAuth(), async (req, res) => {
  const qty = parseInt(req.query.crates) || 0;
  if(qty <= 0) return res.status(400).json({ error: 'crates query param must be a positive integer.' });

  const batches = await db.prepare('SELECT * FROM batches WHERE remaining > 0 ORDER BY received_date ASC').all();
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
