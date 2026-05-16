# Row-Level Security (RLS)

## Status

**Phase 1 — shadow mode (current).** Migration `066_row_level_security.sql`
defines `company_isolation` policies on every company-scoped table, but RLS
is **not enabled** on those tables. The policy uses
`app_current_company_id() IS NULL OR company_id = app_current_company_id()`,
so when the GUC is unset the policy is permissive — existing tooling
(`psql`, replay scripts, dev queries) keeps working.

What is wired:

- `apps/api/src/server.ts` stamps `requestContext.companyId` after
  `getCompany()` resolves. This goes into the request-scoped
  AsyncLocalStorage from `@sitelayer/logger`.
- `apps/api/src/mutation-tx.ts:withMutationTx()` reads
  `getRequestContext().companyId` and runs
  `SELECT set_config('app.company_id', $companyId, true)` at the start of
  every BEGIN/COMMIT block. The `true` argument means SET LOCAL — scoped
  to this transaction only; the pool client returns clean.
- `apps/api/src/mutation-tx.ts:withCompanyClient()` is the read-side analog
  for multi-statement reads (e.g. `/api/bootstrap` fan-out).

What is **not** wired:

- Individual `pool.query()` reads still go straight at the pool. They
  bypass RLS today even if it were enabled, because the connection has no
  `app.company_id` set. Phase 2 moves the hot reads to `withCompanyClient`.
- RLS is not enabled on any table. Enabling it now would break every
  unmigrated route.

## How RLS is enabled (Phase 2 — when ready)

Per-table flip, in a new migration:

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
```

`FORCE` is required: by default the table owner bypasses RLS, but on DO
Managed Postgres the migrator runs as `doadmin` while the app connects as
`sitelayer`, so without FORCE the migrations would test RLS behavior the
app never actually sees.

Recommended sequence (smallest blast radius first):

1. `audit_events` — append-only, no reads from app
2. `mutation_outbox`, `sync_events` — worker-only, well-bounded
3. `workflow_event_log` — append-only
4. `clock_events`, `labor_entries`, `daily_logs` — high-volume per-tenant data
5. `projects`, `blueprint_documents`, `takeoff_measurements`,
   `estimate_lines` — the core takeoff loop
6. Reference data (`workers`, `customers`, `service_items`, etc.)

After each batch: run integration tests, smoke staging, watch for empty
result-set anomalies (= a route did a `pool.query()` without setting
`app.company_id`).

## Testing the policies

`apps/api/src/rls.test.ts` (gated on `RUN_API_INTEGRATION=1`) enables RLS
on `projects` for the duration of the test, inserts two companies' worth
of fixtures, and asserts:

- `SET LOCAL app.company_id = A` → only A's rows are visible.
- `SET LOCAL app.company_id = B` → only B's rows are visible.
- No `app.company_id` set → all rows visible (the permissive fallback).
- INSERT into `projects` with a `company_id` that doesn't match
  `app.company_id` → `WITH CHECK` rejection with a `row-level security`
  error.

To run locally against a fresh DB:

```bash
docker compose up -d db
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer \
  RUN_API_INTEGRATION=1 \
  npm --workspace=@sitelayer/api test -- rls.test.ts
```

## When you add a new company-scoped table

Add the policy in the same migration that creates the table:

```sql
CREATE POLICY company_isolation ON your_new_table
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());
```

Do **not** edit migration 066; it is immutable per `CLAUDE.md` deploy rules.

## Open work

- Migrate hot-path `pool.query()` reads to `withCompanyClient` (see
  `apps/api/src/routes/projects-query.ts`, `bootstrap`, `analytics`).
- Add a CI check that greps for direct `pool.query(` in route handlers and
  warns if the call isn't inside `withMutationTx` / `withCompanyClient`.
- Enable+force RLS table-by-table per the sequence above.
- Drop the `app_current_company_id() IS NULL OR ...` permissive clause
  once every read goes through a scoped client; tighten the policy to a
  strict equality check.
