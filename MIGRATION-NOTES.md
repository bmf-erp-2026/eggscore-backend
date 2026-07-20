# Migrating to Postgres/Supabase — What Actually Changed

The original README said swapping to Postgres would mean changing `db.js` and nothing else. **That wasn't quite right, and it's worth being upfront about it rather than let you discover it halfway through a deploy.**

## What actually had to change, and why

**Every database call needed `await` added.** `better-sqlite3` (used for local development) is synchronous — `db.prepare(sql).get(id)` returns its result immediately. Real Postgres, through the `pg` package, is asynchronous — the same call returns a Promise. That's not a small detail; it meant every route handler needed to become `async`, and every database call needed `await` in front of it.

**INSERT statements needed `RETURNING id` added.** SQLite hands back the new row's ID automatically via `lastInsertRowid`. Postgres doesn't, unless the INSERT statement explicitly asks for it. The Postgres `db.js` wrapper adds this automatically, so the actual SQL text in route files didn't need hand-editing — but it's still a real behavioral difference worth knowing about if you're reading the two side by side.

**Datetime syntax differs.** SQLite's `datetime('now')` became Postgres's `now()` everywhere it appeared.

## What genuinely stayed the same

- The overall shape of every route — same endpoints, same request/response bodies, same business logic
- The real multi-batch FIFO deduction logic in `/sales` — identical, just with `await` added
- The role-based auth model — identical
- The schema itself — same tables, same columns, same relationships (only the primary-key syntax and timestamp defaults changed)

## Files in this package, and which mode they're for

| File | Used for |
|---|---|
| `server.js` / `db.js` / `auth.js` / `routes/` | Local development — SQLite, zero account needed, run today |
| `server.postgres.js` / `db.postgres.js` / `auth.postgres.js` / `routes-postgres/` | Real production — Supabase/Postgres |
| `schema.sql` | SQLite schema (local dev) |
| `schema.postgres.sql` | Real Postgres schema — load this into Supabase |

## Verified, not assumed

This wasn't just written and hoped to work — a real local Postgres instance was installed and the entire flow was run against it directly: schema load, API key creation, role-based access control (portal key correctly blocked from an ERP-only endpoint), order creation, funnel event logging and aggregation, blended-cost calculation spanning two batches, and a sale recording with real multi-batch FIFO spillover (a 130-crate sale against a 100-crate batch correctly split 100/30 across two batches). Every result matched the SQLite version's behavior exactly — same numbers, same logic, just running on a real production-shaped database instead of a local file.

## Deploying this to your actual Railway + Supabase setup

1. In the Supabase SQL Editor, run the full contents of `schema.postgres.sql`.
2. In Railway's Variables tab (where `SUPABASE_URL` etc. already live), add a `DATABASE_URL` variable — this is Supabase's Postgres connection string, found under Settings → Database → Connection String (use the "URI" format, not the individual host/port/user fields).
3. Add a `SETUP_SECRET` variable — any long random string you choose.
4. Set Railway's start command to `node server.postgres.js` instead of `node server.js`.
5. Deploy. Hit `/health` on your Railway public URL to confirm it's live, then use `/admin/create-key` (with your `SETUP_SECRET` in the `x-setup-secret` header) to mint real ERP and portal API keys.
6. Update `famad-erp.html` and `famad-order.html` to call your real Railway URL instead of `localhost:3001`, using the real API keys from step 5.
