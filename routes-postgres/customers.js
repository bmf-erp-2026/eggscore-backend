const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

router.post('/', requireSupabaseAuth(), async (req, res) => {
  const { cid, name, location, contact, phone, type, creditLimit, referral, notes } = req.body;

  if(!name || !location) {
    return res.status(400).json({ error: 'name and location are required.' });
  }

  const info = await db.prepare(`
    INSERT INTO customers (cid, name, location, contact, phone, type, credit_limit, referral, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cid || null, name, location, contact || null, phone || null, type || null,
    creditLimit || 0, referral || null, notes || null);

  res.status(201).json(await db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all());
});

// Was missing entirely — confirmEditContact() on the ERP side only ever
// saved to local browser storage, meaning contact-info edits never
// actually reached the backend, on top of the Type/Contact fields not
// being editable there at all until now.
router.patch('/:id', requireSupabaseAuth(), async (req, res) => {
  const { phone, location, contact, type, creditLimit } = req.body;
  const existing = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Customer not found.' });

  const fields = [], values = [];
  if(phone !== undefined)      { fields.push('phone = ?');        values.push(phone); }
  if(location !== undefined)   { fields.push('location = ?');     values.push(location); }
  if(contact !== undefined)    { fields.push('contact = ?');      values.push(contact); }
  if(type !== undefined)       { fields.push('type = ?');         values.push(type); }
  if(creditLimit !== undefined){ fields.push('credit_limit = ?'); values.push(creditLimit); }

  if(fields.length === 0) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.id);
  await db.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  res.json(await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

module.exports = router;
