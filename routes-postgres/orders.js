const express = require('express');
const { db } = require('../db.postgres');
const { requireAuth, requireSupabaseAuth, requireEitherAuth } = require('../auth.postgres');
const { geocodeAddress, getRouteDistance } = require('../lib/geocode');
const { notifyOrderChange } = require('../lib/push');

const router = express.Router();

function genOrderRef() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(2);
  return `BEL-ORD-${yy}${p(now.getMonth()+1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// Same convention as the client-side docRefNumber('CID') generator used
// by the ERP's manual "+ Add New Customer" flow — BEL-CID-YYMMDD-HHMMSS.
function genCustomerCid() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(2);
  return `BEL-CID-${yy}${p(now.getMonth()+1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// Matches purely on digits, so "0916 534 3020", "+234 916-534-3020", and
// "09165343020" all resolve to the same customer instead of creating a
// near-duplicate record for the same person.
function normalisePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

// A customer's OWN shareable referral code (what they give a friend) —
// same generator as the ERP's manual Add Customer flow, so a portal-
// created customer gets one too instead of only manually-added ones.
function genReferralCode(name) {
  const letters = (name || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'EGGS';
  const digits = String(Math.floor(100 + Math.random() * 900));
  return `BEL-${letters}${digits}`;
}

router.post('/', requireEitherAuth(), async (req, res) => {
  const { customerName, phone, location, crates, eggPricePerCrate, deliveryPerCrate, notes, paymentMethod,
          referredByCustomerName, reservationCustomerType, reservedAt, reservationWindowHours, reservationExpiresAt, status,
          confirmedExistingCid, theme,
          // Sep 27 2026 fix — these two were never destructured here at
          // all, so even though famad-order.html now sends them, they'd
          // have been silently dropped on the floor. See
          // migration-order-delivery-day.sql for the matching columns.
          preferredDeliveryDay, isSpecialVolumeOrder,
          // Sep 30 2026 — idempotency key for the portal's retry-on-load
          // fix (postOrderToBackend()/retryFailedOrders() in
          // famad-order.html): the same ref that browser generated
          // locally the first time it hit Submit, resent unchanged on
          // every retry of that same order.
          clientRef } = req.body;
  if(!customerName || !crates || crates < 1) {
    return res.status(400).json({ error: 'customerName and a positive crates value are required.' });
  }

  // Idempotent replay — this exact clientRef was already accepted,
  // almost certainly by an earlier attempt whose response never made it
  // back to the browser (the order landed, only the confirmation was
  // lost). Hand back that existing order rather than inserting a second
  // one — skips customer resolution entirely below, since it already
  // ran the first time. Root cause this closes: orders that failed to
  // POST had no retry at all before this, and a naive retry would have
  // just created a genuine duplicate for any case where the first
  // attempt actually succeeded server-side.
  if(clientRef) {
    const already = await db.prepare('SELECT * FROM orders WHERE ref = ?').get(clientRef);
    if(already) {
      const cust = already.customer_id
        ? await db.prepare('SELECT cid FROM customers WHERE id = ?').get(already.customer_id)
        : null;
      return res.status(200).json({ ...already, customerCid: cust?.cid || null, isNewCustomer: false });
    }
  }

  // Silent housekeeping — every order now resolves to a real customer
  // record, whether or not the customer ever taps the portal's "remember
  // me" prompt. Matched by phone (more reliable than name, which people
  // spell inconsistently); a genuinely new number gets a real customer
  // row created here, same CID convention as the ERP's manual Add
  // Customer flow. isNewCustomer tells the portal whether to show the
  // enrollment celebration or the quieter "welcome back" version.
  let customerId = null, customerCid = null, isNewCustomer = false;
  const normalisedPhone = normalisePhone(phone);

  // A returning customer ordering from a new number is invisible to the
  // phone-only lookup below — the portal recognises her by NAME (see
  // checkPhoneMismatch() client-side) and, once confirmed, sends her
  // real CID directly here. Trusting it outright would risk merging two
  // different people who share a name on a mistaken guess, so the
  // client only ever sends this after either an unambiguous phone match
  // or an explicit "yes, that's me" from the customer — never a bare
  // name-only guess. Refreshing her phone here is exactly right in
  // this case: it's the same real person, just calling from a new number.
  if(confirmedExistingCid) {
    const existing = await db.prepare('SELECT id, cid FROM customers WHERE cid = ?').get(confirmedExistingCid);
    if(existing) {
      customerId  = existing.id;
      customerCid = existing.cid;
      if(normalisedPhone) {
        await db.prepare('UPDATE customers SET phone = ? WHERE id = ?').run(phone, existing.id);
      }
    }
  }

  if(!customerId && normalisedPhone) {
    const allCustomers = await db.prepare('SELECT id, cid, phone FROM customers').all();
    const match = allCustomers.find(c => normalisePhone(c.phone) === normalisedPhone);
    if(match) {
      customerId  = match.id;
      customerCid = match.cid;
    } else if(location) {
      const cid = genCustomerCid();
      // 'Individual' is a real, meaningful value from the same Customer
      // Type vocabulary used in the ERP's manual Add Customer form
      // (Wholesaler/Retailer/Market Trader/Depot/Restaurant-Hotel/
      // Individual) — a reasonable default for a first-time online
      // order, editable later via Edit Contact Info once Bob knows more
      // about them. 'portal' was a meaningless internal placeholder.
      const info = await db.prepare(`
        INSERT INTO customers (cid, name, location, phone, type, credit_limit, referral_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(cid, customerName, location, phone || null, 'Individual', 0, genReferralCode(customerName));
      customerId    = info.lastInsertRowid;
      customerCid   = cid;
      isNewCustomer = true;
    }
  }

// Reuse the browser's own clientRef when it sent one — same convention/
// format as genOrderRef() already produces (BEL-ORD-YYMMDD-HHMMSS), just
// generated a moment earlier on the customer's device. Only falls back
// to generating one here for a caller that doesn't send one at all
// (older cached page, or any future non-portal caller).
const ref = clientRef || genOrderRef();
  const info = await db.prepare(`
    INSERT INTO orders (ref, customer_id, customer_name, phone, location, crates, egg_price_per_crate, delivery_per_crate, notes, payment_method, referred_by_customer_name, reservation_customer_type, reserved_at, reservation_window_hours, reservation_expires_at, status, theme, preferred_delivery_day, is_special_volume_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ref, customerId, customerName, phone || null, location || null, crates,
    eggPricePerCrate || 0, deliveryPerCrate || 0, notes || null, paymentMethod || null,
    referredByCustomerName || null, reservationCustomerType || null, reservedAt || null,
    reservationWindowHours || null, reservationExpiresAt || null, status || 'pending',
    theme === 'dark' ? 'dark' : 'light',
    preferredDeliveryDay || null, !!isSpecialVolumeOrder);

  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...order, customerCid, isNewCustomer });
});

router.get('/', requireSupabaseAuth(), async (req, res) => {
  const { status } = req.query;
  const rows = status
    ? await db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at ASC').all(status)
    : await db.prepare('SELECT * FROM orders ORDER BY created_at ASC').all();
  res.json(rows);
});

// Phase 2, Advisory route grouping (Sep 24 2026) — on-demand geocoding
// for the "Group Nearby Orders" button in Logistics' Ready for Waybill
// panel. Deliberately scoped to status IN ('pending','confirmed') —
// the same set that panel already shows — rather than every order
// ever placed: an already-delivered or cancelled order has no reason
// to burn a geocoding call, and this keeps the list short (tens, not
// thousands) each time it runs. latitude IS NULL further limits it to
// orders that haven't been located yet, so repeat clicks only ever
// pay for genuinely new addresses, same caching discipline as
// destinations' geocode-missing route. customers.latitude/longitude
// (added in the very first Phase 1 migration but never wired up until
// now) stay out of scope here on purpose — an order's own delivery
// address is what a driver actually needs, and may differ from
// wherever that customer's account address is on file.
router.post('/geocode-pending', requireSupabaseAuth(), async (req, res) => {
  const missing = await db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('pending', 'confirmed') AND latitude IS NULL AND location IS NOT NULL
    ORDER BY created_at ASC
  `).all();
  let geocoded = 0, failed = 0;
  for(const order of missing) {
    const geo = await geocodeAddress(order.location);
    if(geo) {
      await db.prepare(`
        UPDATE orders SET latitude = ?, longitude = ? WHERE id = ?
      `).run(geo.latitude, geo.longitude, order.id);
      geocoded++;
    } else {
      failed++;
    }
  }
  res.json({ attempted: missing.length, geocoded, failed });
});

// Sep 29 2026 — Cluster Delivery distance automation, Option 1 (Bob's
// choice): the client has already decided the stop order for free
// (orderPointsGreedily(), same logic as the driver's nav link) and sends
// it here already ordered, plus the farm's own address as originAddress.
// This makes exactly one Directions API (Basic tier) call per click of
// "Auto-calculate distance" in the Generate Cluster Waybill modal — never
// automatic, never on every checkbox toggle, so Bob only spends a call
// when he actually asks for one.
router.post('/cluster-distance', requireSupabaseAuth(), async (req, res) => {
  const { originAddress, stops } = req.body || {};
  if(!originAddress || !Array.isArray(stops) || stops.length === 0) {
    return res.status(400).json({ error: 'originAddress and a non-empty stops array are required.' });
  }
  const result = await getRouteDistance(originAddress, stops);
  if(!result) {
    return res.status(502).json({ error: 'Could not calculate a route — check the farm address and that every stop has a location on file.' });
  }
  res.json(result);
});

router.get('/:ref', requireEitherAuth(), async (req, res) => {
  const order = await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  res.json(order);
});

router.patch('/:ref', requireSupabaseAuth(), async (req, res) => {
  const { status, paymentVerified, batchId, convertedAt, cancelledAt, agreedPaymentTerms,
          // Sep 27 2026 — outbound attestation (Electronic Waybill Goods
          // Attestation, Bob's "Context 3"), set by whichever staff member
          // dispatches the vehicle at Generate Waybill time — see the
          // matching famad-erp.html change. deliveryToken is generated
          // client-side and saved here too, so the public confirmation
          // page (below) can be reached with it before any staff member
          // needs to be involved again.
          deliveryToken, outboundCondition, outboundAttestedBy, outboundNotes } = req.body;
  const order = await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order) return res.status(404).json({ error: 'Order not found.' });

  const fields = [], values = [];
  if(status !== undefined) { fields.push('status = ?'); values.push(status); }
  if(paymentVerified !== undefined) { fields.push('payment_verified = ?'); values.push(paymentVerified ? 1 : 0); }
  if(batchId !== undefined) { fields.push('batch_id = ?'); values.push(batchId); }
  if(convertedAt !== undefined) { fields.push('converted_at = ?'); values.push(convertedAt); }
  if(cancelledAt !== undefined) { fields.push('cancelled_at = ?'); values.push(cancelledAt); }
  // The REAL agreed payment terms (cash/transfer/credit7/credit30/part),
  // set explicitly by staff at Orders Inbox — see the matching column
  // comment in migration-agreed-payment-terms.sql for why this is a
  // separate field from payment_method (the customer's own portal choice).
  if(agreedPaymentTerms !== undefined) { fields.push('agreed_payment_terms = ?'); values.push(agreedPaymentTerms); }
  if(deliveryToken !== undefined) { fields.push('delivery_token = ?'); values.push(deliveryToken); }
  if(outboundCondition !== undefined) { fields.push('outbound_condition = ?'); values.push(outboundCondition); }
  if(outboundAttestedBy !== undefined) { fields.push('outbound_attested_by = ?'); values.push(outboundAttestedBy); }
  if(outboundNotes !== undefined) { fields.push('outbound_notes = ?'); values.push(outboundNotes); }
  if(outboundCondition !== undefined || outboundAttestedBy !== undefined) {
    fields.push('outbound_attested_at = now()');
  }
  fields.push("updated_at = now()");

  if(fields.length === 1) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.ref);
  await db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE ref = ?`).run(...values);

  console.log(`[audit] Order ${req.params.ref} updated by ${req.user?.email || 'portal key'}`);

  const updatedOrder = await db.prepare('SELECT * FROM orders WHERE ref = ?').get(req.params.ref);

  // Oct 9 2026 — push notifications. Tells the customer's phone when the
  // order is paid / confirmed / on its way / delivered. Deliberately NOT
  // awaited and wrapped so that a notification problem can never slow down
  // or break a staff member's order update — the order PATCH has already
  // succeeded by this point. `order` is the row as it was BEFORE this
  // PATCH, `updatedOrder` the row after, so only real changes notify.
  notifyOrderChange(order, updatedOrder).catch(e => console.error('[push] order notify failed:', e.message));

  res.json(updatedOrder);
});

// ── Customer delivery attestation — Sep 27 2026 ──────────────────────
// The actual close-out mechanism for Bob's "who really confirmed this
// arrived" gap. Deliberately NOT behind requireSupabaseAuth() or an
// x-api-key — the person completing this is the CUSTOMER, standing at
// their own door with no ERP login and often no prior relationship with
// this backend at all. What stands in for auth here is the delivery_token:
// a long random value, generated client-side in the ERP and saved onto
// this exact order at waybill time (see the PATCH above), known only to
// whoever the driver's WhatsApp link was sent to. Guessing another
// order's token would mean guessing a long random string with no
// enumerable pattern (order refs are sequential/date-based and NOT
// accepted here in place of a token, on purpose).
//
// GET confirm-info is the read the confirmation page uses to render
// itself — deliberately minimal (no phone, no address, no price) since
// it's reachable by anyone who has the link, which in practice also means
// anyone who later gets hold of the driver's phone.
router.get('/:ref/confirm-info', async (req, res) => {
  const { token } = req.query;
  if(!token) return res.status(400).json({ error: 'token is required.' });
  const order = await db.prepare('SELECT ref, customer_name, crates, delivery_token, customer_attested_at FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order || !order.delivery_token || order.delivery_token !== token) {
    return res.status(404).json({ error: 'Link not recognised — ask for a fresh one.' });
  }
  res.json({
    ref: order.ref,
    customerName: order.customer_name,
    crates: order.crates,
    alreadyAttested: !!order.customer_attested_at,
  });
});

router.post('/:ref/customer-attestation', async (req, res) => {
  const { token, condition, attestedByName, notes, signature } = req.body;
  if(!token) return res.status(400).json({ error: 'token is required.' });
  if(!condition || !attestedByName || !attestedByName.trim()) {
    return res.status(400).json({ error: 'condition and your name are both required.' });
  }
  const order = await db.prepare('SELECT ref, status, delivery_token, customer_attested_at FROM orders WHERE ref = ?').get(req.params.ref);
  if(!order || !order.delivery_token || order.delivery_token !== token) {
    return res.status(404).json({ error: 'Link not recognised — ask for a fresh one.' });
  }
  if(order.customer_attested_at) {
    // Already done — same idempotent-success shape as re-clicking a
    // WhatsApp link twice, not an error. Only the FIRST attestation ever
    // counts, so a driver accidentally opening the link a second time
    // can't silently overwrite what the customer already signed off on.
    return res.json({ ok: true, alreadyAttested: true });
  }

  // Sep 27 2026 fix — this route used to also flip status to 'delivered'
  // here. 'delivered' isn't one of the statuses the rest of this app
  // actually knows (orderStatusRank in famad-erp.html only recognises
  // pending/reserved/confirmed/in_transit/fulfilled/rejected/cancelled) —
  // it was silently invented for this one UPDATE. Harmless for a device
  // that already had the order cached (the unrecognised value just failed
  // to overwrite the cached 'in_transit'), but a device seeing this order
  // for the FIRST time after this ran would pull down status:'delivered'
  // literally and the order would vanish from every screen that filters
  // by a real status — Orders Inbox, In Transit, Delivery Closeouts, all
  // of it. Order status stays exactly what it's always been: something
  // only the ERP's own confirmDeliveryAndProceed()/sendToSalesLog()
  // pipeline changes, via the ordinary PATCH route above. This route's
  // only job is recording that the customer attested — never touching
  // status itself.
  await db.prepare(`
    UPDATE orders SET
      customer_condition = ?, customer_attested_by = ?, customer_notes = ?,
      customer_signature = ?, customer_attested_at = now(),
      updated_at = now()
    WHERE ref = ?
  `).run(condition, attestedByName.trim(), notes || null, signature || null, req.params.ref);

  console.log(`[audit] Order ${req.params.ref} customer-attested by "${attestedByName.trim()}" (${condition})`);
  res.json({ ok: true, alreadyAttested: false });
});

module.exports = router;
