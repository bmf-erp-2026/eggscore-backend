// lib/rep-scope.js — who is this staff login, and which customers/orders/sales may they see?
// Oct 13 2026 — "every rep is tied to a login, every customer is tied to the rep who pitched them".
//
//   owner    sees and does everything (an untagged login counts as the owner).
//   manager  sees everything and may record sales and payments on behalf of a named rep.
//   rep      sees only their own customers (plus customers nobody owns yet), and only the
//            orders, sales and payments of those customers. The rep is the one whose record in
//            the reps table carries this login's e-mail address.
//
// Anything else (an unknown role) is treated like a rep, so a mistake fails closed.
const { db } = require('../db.postgres');

const isAll = role => role === 'owner' || role === 'manager';

async function repNameFor(email) {
  if(!email) return null;
  const r = await db.prepare('SELECT name FROM reps WHERE LOWER(email) = LOWER(?)').get(String(email));
  return r ? r.name : null;
}

// { all: true } for owner/manager. For a rep: { all: false, rep: '<their rep name>' } or rep:null when the login
// has not been linked to a rep record yet (such a login sees nothing and may not sell).
async function scopeOf(req) {
  const role = (req.user && req.user.role) || 'owner';
  if(isAll(role)) return { all: true, rep: null, role, email: req.user && req.user.email };
  return { all: false, rep: await repNameFor(req.user && req.user.email), role, email: req.user && req.user.email };
}

// SQL piece limiting a query to the customers this login may see. `alias` is the customers table alias.
function customerClause(sc, alias = 'c') {
  if(sc.all) return { sql: '1=1', params: [] };
  if(!sc.rep) return { sql: '1=0', params: [] };
  return { sql: `(${alias}.owner_rep IS NULL OR ${alias}.owner_rep = ?)`, params: [sc.rep] };
}

// May this login deal with this customer (by id)? Guests and unowned customers are open to every rep.
async function canSeeCustomer(sc, customerId, customerName) {
  if(sc.all) return true;
  if(!sc.rep) return false;
  let row = null;
  if(customerId) row = await db.prepare('SELECT owner_rep FROM customers WHERE id = ?').get(customerId);
  else if(customerName) row = await db.prepare('SELECT owner_rep FROM customers WHERE name = ?').get(customerName);
  if(!row || !row.owner_rep) return true;
  return row.owner_rep === sc.rep;
}

// May this login deal with this order (by reference)?
async function canSeeOrder(sc, ref) {
  if(sc.all) return true;
  if(!sc.rep) return false;
  const o = await db.prepare('SELECT customer_id, customer_name FROM orders WHERE ref = ?').get(String(ref));
  if(!o) return true;               // unknown order: the route's own "not found" answer applies
  return canSeeCustomer(sc, o.customer_id, o.customer_name);
}

const NOT_YOURS = { error: 'This customer is tied to another sales rep. Ask the Owner if the account should move to you.', code: 'NOT_YOUR_CUSTOMER' };
const NOT_LINKED = { error: 'Your login is not linked to a sales rep yet. Ask the Owner to link it (Rep Centre, Rep logins).', code: 'REP_NOT_LINKED' };

module.exports = { isAll, repNameFor, scopeOf, customerClause, canSeeCustomer, canSeeOrder, NOT_YOURS, NOT_LINKED };
