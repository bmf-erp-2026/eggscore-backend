const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');

const router = express.Router();

// ERP-only — suppliers are never portal-facing, unlike customers.
router.post('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const {
    name, location, phone, distanceKm, capacityCratesPerWeek, status,
    documentsOnFile, biosecurityChecklist, biosecurityAssessedAt,
    biosecurityNotes, docNotes, dateAdded, dateLastReviewed,
  } = req.body;

  if(!name || !location) {
    return res.status(400).json({ error: 'name and location are required.' });
  }

  const info = await db.prepare(`
    INSERT INTO suppliers (
      name, location, phone, distance_km, capacity_crates_per_week, status,
      documents_on_file, biosecurity_checklist, biosecurity_assessed_at,
      biosecurity_notes, doc_notes, date_added, date_last_reviewed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, location, phone || null, distanceKm || null, capacityCratesPerWeek || null,
    status || 'trial', !!documentsOnFile, JSON.stringify(biosecurityChecklist || {}),
    biosecurityAssessedAt || null, biosecurityNotes || null, docNotes || null,
    dateAdded || null, dateLastReviewed || null,
  );

  res.status(201).json(await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM suppliers ORDER BY id ASC').all());
});

router.patch('/:id', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const {
    name, location, phone, distanceKm, capacityCratesPerWeek, status,
    documentsOnFile, biosecurityChecklist, biosecurityAssessedAt,
    biosecurityNotes, docNotes, dateLastReviewed,
  } = req.body;
  const existing = await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if(!existing) return res.status(404).json({ error: 'Supplier not found.' });

  const fields = [], values = [];
  if(name !== undefined)                   { fields.push('name = ?');                      values.push(name); }
  if(location !== undefined)               { fields.push('location = ?');                  values.push(location); }
  if(phone !== undefined)                  { fields.push('phone = ?');                      values.push(phone); }
  if(distanceKm !== undefined)             { fields.push('distance_km = ?');                values.push(distanceKm); }
  if(capacityCratesPerWeek !== undefined)  { fields.push('capacity_crates_per_week = ?');    values.push(capacityCratesPerWeek); }
  if(status !== undefined)                 { fields.push('status = ?');                     values.push(status); }
  if(documentsOnFile !== undefined)        { fields.push('documents_on_file = ?');           values.push(!!documentsOnFile); }
  if(biosecurityChecklist !== undefined)   { fields.push('biosecurity_checklist = ?');       values.push(JSON.stringify(biosecurityChecklist)); }
  if(biosecurityAssessedAt !== undefined)  { fields.push('biosecurity_assessed_at = ?');     values.push(biosecurityAssessedAt); }
  if(biosecurityNotes !== undefined)       { fields.push('biosecurity_notes = ?');           values.push(biosecurityNotes); }
  if(docNotes !== undefined)               { fields.push('doc_notes = ?');                  values.push(docNotes); }
  if(dateLastReviewed !== undefined)       { fields.push('date_last_reviewed = ?');          values.push(dateLastReviewed); }

  if(fields.length === 0) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.id);
  await db.prepare(`UPDATE suppliers SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  res.json(await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id));
});

module.exports = router;
