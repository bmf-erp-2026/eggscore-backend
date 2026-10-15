const express = require('express');
const { db } = require('../db.postgres');
const { requireSupabaseAuth, requireRole } = require('../auth.postgres');

const router = express.Router();

// ON CONFLICT...DO NOTHING — idempotent against the self-healing retry
// pattern (same as Sales/Customers/Settlements): if a rep already
// exists under this rep_id, a retry of the original POST is a no-op
// rather than an error or a duplicate row.
//
// email (Sep 1 2026, Sales Rep Access) — links this rep record to an
// actual login (the Supabase account a rep signs in with), so the
// backend can tell "this logged-in rep" apart from "every rep". Set
// once when a rep record is created/edited by the owner; never
// client-guessable since only owners can write to this route at all.
router.post('/', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const { repId, name, zone, phone, target, status, email } = req.body;

  if(!repId || !name) {
    return res.status(400).json({ error: 'repId and name are required.' });
  }

  const row = await db.prepare(`
    INSERT INTO reps (rep_id, name, zone, phone, target, status, email)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (rep_id) DO NOTHING
    RETURNING *
  `).run(repId, name, zone || null, phone || null, target || 0, status || 'active', email || null);

  res.status(201).json(row || await db.prepare('SELECT * FROM reps WHERE rep_id = ?').get(repId));
});

// Full-log pull for cross-device sync — same shape/intent as
// GET /sales, GET /orders, GET /settlements.
//
// Role-filtered (Sep 1 2026, Sales Rep Access): an owner sees the full
// roster, same as always. A rep sees only their OWN record, matched by
// email against their login — the phone numbers, targets, and
// deboarding history of every OTHER rep are none of their business,
// same reasoning as "own sales only" elsewhere in this project. A rep
// whose record has no email set yet (not linked by the owner) sees an
// empty list rather than an error — a missing link should look like
// "nothing's been shared with you yet," not a broken request.
router.get('/', requireSupabaseAuth(), async (req, res) => {
  // Oct 13 2026 — a manager sees the whole roster too (needed to pick the rep when recording a sale for them).
  if(req.user.role === 'owner' || req.user.role === 'manager') {
    return res.json(await db.prepare('SELECT * FROM reps ORDER BY created_at ASC').all());
  }
  res.json(await db.prepare('SELECT * FROM reps WHERE LOWER(email) = LOWER(?) ORDER BY created_at ASC').all(req.user.email));
});

// Patched by rep_id (the stable client-side id), not the numeric
// Postgres id — the client always has rep_id on hand and never needs
// an extra lookup round-trip to get the numeric one.
//
// Owner-only (Sep 1 2026, Sales Rep Access): target, deboarding, and
// settlement fields are all management decisions, not self-service —
// deliberately no carve-out for a rep updating even their own phone
// number here, unlike customers.js's field-level split. Revisit if
// that turns out too restrictive in practice.
router.patch('/:repId', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const {
    zone, phone, target, status, email,
    deboardedAt, deboardReason, finalCommBalance, deboardNotes,
    settlementAcknowledged, settlementOutstandingAtDeboard,
  } = req.body;
  const existing = await db.prepare('SELECT * FROM reps WHERE rep_id = ?').get(req.params.repId);
  if(!existing) return res.status(404).json({ error: 'Rep not found.' });

  const fields = [], values = [];
  if(zone !== undefined)   { fields.push('zone = ?');   values.push(zone); }
  if(phone !== undefined)  { fields.push('phone = ?');  values.push(phone); }
  if(target !== undefined) { fields.push('target = ?'); values.push(target); }
  if(status !== undefined) { fields.push('status = ?'); values.push(status); }
  if(email !== undefined)  { fields.push('email = ?');  values.push(email); }
  if(deboardedAt !== undefined)     { fields.push('deboarded_at = ?');     values.push(deboardedAt); }
  if(deboardReason !== undefined)   { fields.push('deboard_reason = ?');   values.push(deboardReason); }
  if(finalCommBalance !== undefined){ fields.push('final_comm_balance = ?'); values.push(finalCommBalance); }
  if(deboardNotes !== undefined)    { fields.push('deboard_notes = ?');    values.push(deboardNotes); }
  if(settlementAcknowledged !== undefined) { fields.push('settlement_acknowledged = ?'); values.push(settlementAcknowledged); }
  if(settlementOutstandingAtDeboard !== undefined) { fields.push('settlement_outstanding_at_deboard = ?'); values.push(settlementOutstandingAtDeboard); }

  if(fields.length === 0) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.repId);
  await db.prepare(`UPDATE reps SET ${fields.join(', ')} WHERE rep_id = ?`).run(...values);

  const out = await db.prepare('SELECT * FROM reps WHERE rep_id = ?').get(req.params.repId);
  // Oct 15 2026 — deboarding: switch the rep's login off, and park any customer still tied to them with the Owner
  // (the screen normally moves the customers first; this is the safety net so none are left tied to someone who left).
  if(status === 'inactive' && (existing.status || 'active') !== 'inactive') {
    const login = await require('./rep-accounts').disableLogin(existing.email);
    let parked = 0;
    try {
      const left = await db.prepare('SELECT id, name FROM customers WHERE owner_rep = ?').all(existing.name);
      for(const c of left) {
        await db.prepare("UPDATE customers SET owner_rep = '(Owner hold)', owner_rep_set_by = ?, owner_rep_set_at = now() WHERE id = ?").run(req.user.email || null, c.id);
        await db.prepare(`INSERT INTO rep_handovers (kind, ref, subject, from_rep, to_rep, reason, by_email) VALUES ('customer', ?, ?, ?, '(Owner hold)', 'Rep deboarded', ?)`)
          .run(c.name, c.name, existing.name, req.user.email || null);
        parked++;
      }
    } catch(e) { console.error('[reps] could not park customers of', existing.name, e.message); }
    return res.json({ ...out, loginDisabled: login.ok, loginNote: login.note, customersParked: parked });
  }
  // Oct 15 2026 — reinstating: the login is switched back on. Customers are handled by the screen (it asks the Owner).
  if(status === 'active' && (existing.status || 'active') === 'inactive') {
    const login = await require('./rep-accounts').enableLogin(existing.email);
    console.log(`[audit] Rep ${existing.name} reinstated by ${req.user.email}`);
    return res.json({ ...out, loginEnabled: login.ok && !login.none, loginNote: login.ok ? null : login.note });
  }
  res.json(out);
});

// Oct 15 2026 — customers parked with the Owner when this rep was deboarded and still waiting on hold.
// Used by the Reinstate screen so the Owner can hand them back. Owner only.
router.get('/:repId/parked', requireSupabaseAuth(), requireRole('owner'), async (req, res) => {
  const rep = await db.prepare('SELECT name FROM reps WHERE rep_id = ?').get(req.params.repId);
  if(!rep) return res.status(404).json({ error: 'Rep not found.' });
  const rows = await db.prepare(`
    SELECT c.id, c.name FROM customers c
    WHERE c.owner_rep = '(Owner hold)'
      AND (SELECT h.from_rep FROM rep_handovers h WHERE h.kind = 'customer' AND h.subject = c.name ORDER BY h.created_at DESC, h.id DESC LIMIT 1) = ?
    ORDER BY c.name ASC`).all(rep.name);
  res.json(rows);
});

module.exports = router;
