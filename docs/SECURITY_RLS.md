# Row-Level Security (RLS)

## Status

**Phase 2 — append-only tables enforced (current).** Migration
`073_rls_enable_phase_2.sql` flips RLS ENABLED + FORCED on the four
append-only / queue tables: `audit_events`, `workflow_event_log`,
`mutation_outbox`, `sync_events`. The policy still permits NULL GUC
(`app_current_company_id() IS NULL OR company_id = ...`), so any code
path that forgets to bind `app.company_id` still works — but writes are
checked under WITH CHECK once the GUC is set, so accidental cross-company
inserts now fail loudly.

The remaining 60+ tables (`projects`, `customers`, `takeoff_*`,
`estimate_*`, etc.) are still shadow-mode (policy defined, RLS not yet
enabled). Phase 3 will extend the enforcement after staging soak time.

**Phase 1 — shadow mode (historical).** Migration `066_row_level_security.sql`
defines `company_isolation` policies on every company-scoped table. The
policy uses `app_current_company_id() IS NULL OR company_id =
app_current_company_id()`, so when the GUC is unset the policy is
permissive — existing tooling (`psql`, replay scripts, dev queries) keeps
working.

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
  for multi-statement reads (e.g. `/api/bootstrap` fan-out). As of Phase 2
  (#NNN), every `ctx.pool.query(...)` hot-path reader in `apps/api/src/routes/*.ts`
  has been wrapped in `withCompanyClient(ctx.company.id, (c) => c.query(...))`.
- `apps/worker/src/worker.ts:setCompanyGuc()` sets the same GUC inside the
  worker's BEGIN/COMMIT blocks so drain queries against company-scoped
  tables (including the 4 RLS-enforced ones) pass the policy.

What is **not** wired:

- Cross-company admin endpoints (`/api/webhooks/qbo`, the share-token
  portal routes, `/api/debug/traces/:id`) deliberately query without
  binding the GUC. They rely on the permissive `IS NULL OR` clause and
  filter explicitly in SQL. These are documented in-code with a comment
  per call site.

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

1. `audit_events` — append-only, no reads from app **(done in Phase 2)**
2. `mutation_outbox`, `sync_events` — worker-only, well-bounded **(done in Phase 2)**
3. `workflow_event_log` — append-only **(done in Phase 2)**
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

### Phase 3 runtime probe (constrained role)

`apps/api/src/routes/rls-phase3-audit.test.ts` is a second test that
audits every high-impact route's source for `withCompanyClient` /
`withMutationTx` usage (static) and exercises a non-`BYPASSRLS` role
against the `projects` table (runtime). The runtime probe needs a role
that does NOT bypass RLS; migration `087_constrained_role_for_rls_probe.sql`
provisions `sitelayer_constrained` for that purpose in every non-prod
database (the DO block tier-gates on `current_database() ~
'^sitelayer_prod'` and is a no-op there).

Local:

```bash
CONSTRAINED_DB_URL=postgres://sitelayer_constrained:sitelayer_constrained@localhost:5432/sitelayer \
  npm --workspace=@sitelayer/api test -- src/routes/rls-phase3-audit.test.ts
```

CI: the `test-integration` job in `.github/workflows/quality.yml` exports
the same URL automatically once the migration has run against the
ephemeral Postgres service.

Preview deploys intentionally skip the constrained-role migration. The
preview stack connects to the managed preview database as the app role, which
does not have `CREATEROLE`; the preview app does not need the runtime probe
login role. Local Docker and CI still run the migration and exercise the
probe.

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

- Enable+force RLS on the remaining tables per the sequence above
  (`clock_events`, `labor_entries`, `daily_logs`, then projects/blueprint/
  takeoff/estimate, then reference data).
- Add a CI check that greps for direct `ctx.pool.query(` in route
  handlers and fails if the call isn't inside `withMutationTx` /
  `withCompanyClient` (the audit done in Phase 2 was manual).
- Drop the `app_current_company_id() IS NULL OR ...` permissive clause
  once every read goes through a scoped client; tighten the policy to a
  strict equality check.
- Provision a non-superuser app role in CI so the integration test suite
  actually exercises RLS enforcement (currently `sitelayer` is BYPASSRLS
  per `.github/workflows/quality.yml`).
