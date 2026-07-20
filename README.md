# EggScore Backend — MVP

Covers the P0 domains from the ERP scan: **orders, funnel events, sales ledger, inventory/batches**, plus real API-key authentication (which didn't exist anywhere before this). Everything else on the itemized scan stays client-side for now — this is deliberately the first slice, not the whole system.

Tested end-to-end in development: server boot, API key creation, role-based access control (portal keys correctly blocked from financial endpoints), order creation, funnel logging, real multi-batch FIFO deduction on a sale, and blended-cost calculation spanning two batches. All verified against real HTTP requests, not just read through.

---

## Running it locally (no account needed, works today)

```bash
npm install
cp .env.example .env
node server.js
```

Server starts on `http://localhost:3001`. Data lives in `eggscore.db`, a single SQLite file — delete it any time to start fresh.

### Create your first API keys

```bash
curl -X POST http://localhost:3001/admin/create-key \
  -H "Content-Type: application/json" \
  -H "x-setup-secret: YOUR_SETUP_SECRET_FROM_.ENV" \
  -d '{"role":"erp","label":"Bob'\''s ERP laptop"}'

curl -X POST http://localhost:3001/admin/create-key \
  -H "Content-Type: application/json" \
  -H "x-setup-secret: YOUR_SETUP_SECRET_FROM_.ENV" \
  -d '{"role":"portal","label":"Customer Portal"}'
```

**Each key is shown exactly once.** Save both immediately — the raw key is never stored, only its hash, so there's no way to recover it later. If you lose one, create a new one and update wherever it's used.

---

## API reference

All endpoints (except `/health` and `/admin/create-key`) require an `x-api-key` header.

| Endpoint | Method | Role required | Purpose |
|---|---|---|---|
| `/health` | GET | none | Confirms the server is running |
| `/orders` | POST | portal or erp | Customer places an order |
| `/orders` | GET | erp only | ERP reads the order queue (`?status=pending` to filter) |
| `/orders/:ref` | GET | either | Look up a single order |
| `/orders/:ref` | PATCH | erp only | Confirm, mark payment verified, assign a batch |
| `/events` | POST | portal or erp | Log a funnel step (`viewed_form`, `set_crates`, `reached_checkout`, `submitted_order`, `blocked_cap`) |
| `/events/funnel` | GET | erp only | Real funnel counts (`?from=2026-07-01&to=2026-07-31`) |
| `/events/session/:sessionId` | GET | erp only | Full step-by-step trail for one visitor |
| `/sales` | POST | erp only | Record a fulfilled sale — does real multi-batch FIFO deduction |
| `/sales` | GET | erp only | Read the Sales Ledger (`?from=&to=&rep=`) |
| `/inventory` | GET | either | Live stock and active batches |
| `/inventory/batches` | POST | erp only | Receive new stock |
| `/inventory/blended-cost` | GET | either | Real FIFO-weighted cost for a given quantity (`?crates=200`) |

---

## Deploying for real (once you're ready to go live)

**See `MIGRATION-NOTES.md` for the full, honest picture** — the real Postgres/Supabase version (`server.postgres.js`, `db.postgres.js`, `auth.postgres.js`, `routes-postgres/`) is already built and verified against a real local Postgres instance, not just SQLite. A few things genuinely changed along the way (every database call needed `await` added — Postgres is asynchronous where SQLite wasn't), which the original version of this README didn't fully anticipate. Worth reading before deploying, not after something doesn't work as expected.

### Quick version

1. Run `schema.postgres.sql` in Supabase's SQL Editor.
2. Set `DATABASE_URL` (from Supabase), `SETUP_SECRET` (your own long random value) as Railway environment variables, alongside the `SUPABASE_*` ones already there.
3. Set Railway's start command to `node server.postgres.js`.
4. Deploy, hit `/health`, then mint real API keys via `/admin/create-key`.
5. Point `famad-erp.html` and `famad-order.html` at the real Railway URL and real API keys.

**Two steps that should be you, not an agent** — creating the Supabase and Railway accounts and entering payment details — matching Anthropic's own guidance that sensitive account/payment actions shouldn't be delegated to a browsing agent.

---

## What's still on the ERP scan, not yet in this MVP

Customers, credit/payment holds, pricing engine state, reservation abuse settings, supplier directory, and the owner-PIN auth redesign are all still client-side. They're P1/P2 on the itemized scan — this MVP intentionally covers only what was P0: getting real orders and real funnel visibility off a single browser and onto a real, shared database first.
