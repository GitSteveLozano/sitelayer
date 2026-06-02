# Row-Level Security (RLS)

## Status

**Phase 3 — company-scoped surface ENFORCED + gated (current).** RLS is
ENABLED + FORCED across the company-scoped domain tables: the bulk flip
landed in `085_rls_enable_phase_3.sql` (the ~65 tables from the 066
policy sweep), `101_v2_rls.sql` (the v2 entity tables), and the
per-table migrations that flip RLS in the same file that creates a new
company-scoped table (e.g. `088`, `092`, `103`, `104`, `105`, `120`,
`124`, `125`, `131`, and `145_asset_deployments_rls.sql`). The policy
still permits NULL GUC (`app_current_company_id() IS NULL OR company_id =
...`), so legacy/debug paths keep working, but every read inside a
`withCompanyClient` / `withMutationTx` closure is filtered and every
INSERT/UPDATE is checked under WITH CHECK.

`asset_deployments` was the canonical gap: migration `118` created it
with `company_id NOT NULL` AFTER the 085 flip but added no policy and
never enabled RLS, so it shipped unforced. `145_asset_deployments_rls.sql`
closes it (policy + ENABLE + FORCE, mirroring 066/085/101), and the
**forced-coverage audit is now a blocking gate** so the next such table
fails verification instead of shipping silently — see
[The RLS audit is a blocking gate](#the-rls-audit-is-a-blocking-gate).

**Still ENABLE-not-FORCE (intentional).** The four append-only / queue
tables `audit_events`, `workflow_event_log`, `mutation_outbox`,
`sync_events` are ENABLED but NOT FORCED, so `pg_dump` running as the
table owner can still back them up (migration
`078_rls_no_force_for_owner_dumps.sql`). The app role is a non-owner and
stays filtered by the policy. A handful of company-scoped tables remain
unforced as tracked follow-ups (nullable-`company_id` globals and known
gaps); they are enumerated in `RLS_FORCE_AUDIT_ALLOWLIST` (see the gate
section) so the gate stays green today while still blocking new
offenders.

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

Local gate: `scripts/verify-local.sh`'s docker-compose integration check
exports the same URL automatically once the migration has run against the
ephemeral Postgres service.

Preview deploys intentionally skip the constrained-role migration. The
preview stack connects to the managed preview database as the app role, which
does not have `CREATEROLE`; the preview app does not need the runtime probe
login role. Local Docker and the local integration gate still run the
migration and exercise the probe.

## The RLS audit is a blocking gate

`apps/api/src/routes/rls-phase3-audit.test.ts` runs in the integration
stage of `scripts/verify-local.sh`, which sets `RLS_PHASE3_FAIL_ON_LEAK=1`.
With that flag the audit is a **hard gate**, not a report. Two checks fail
the build:

1. **Static route audit.** Any audited route that issues a raw
   `pool.query(` outside a `withCompanyClient` / `withMutationTx` closure
   (and is not a documented cross-company admin read marked with
   `rawQueryExemptReason`) fails.

2. **Forced-coverage audit (the asset_deployments-gap catcher).** Defined
   in `apps/api/src/routes/rls-force-audit.ts`, it queries the live
   post-migration schema for every `public` table with a `company_id`
   column and reads `pg_class.relforcerowsecurity`. Any table that is NOT
   forced AND NOT on `RLS_FORCE_AUDIT_ALLOWLIST` is a failure. This is what
   would have caught `asset_deployments` at gate time.

Run it locally:

```bash
docker compose up -d db
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer \
  RUN_API_INTEGRATION=1 RLS_PHASE3_FAIL_ON_LEAK=1 \
  npm --workspace=@sitelayer/api test -- src/routes/rls-phase3-audit.test.ts
```

The pure pass/fail logic also has database-free unit coverage in
`apps/api/src/routes/rls-force-audit.test.ts` (runs in the unit stage).

## When you add a new company-scoped table

Add the policy AND enable+force RLS in the same migration that creates the
table (mirror `101_v2_rls.sql` / `145_asset_deployments_rls.sql`):

```sql
CREATE POLICY company_isolation ON your_new_table
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());
ALTER TABLE your_new_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE your_new_table FORCE ROW LEVEL SECURITY;
```

If you skip the ENABLE/FORCE, the forced-coverage gate above will fail your
build — by design. If the table is genuinely not tenant-isolated (e.g. a
nullable-`company_id` global catalog), add it to `RLS_FORCE_AUDIT_ALLOWLIST`
in `apps/api/src/routes/rls-force-audit.ts` with a one-line reason instead.

Do **not** edit migration 066; it is immutable per `CLAUDE.md` deploy rules.

## Open work

- Force RLS on the remaining `KNOWN GAP` tables in
  `RLS_FORCE_AUDIT_ALLOWLIST` (the pricing-override tables,
  `rental_rate_tiers`, `qbo_sync_runs`, `takeoff_drafts`,
  `takeoff_capture_artifacts`) and delete each from the allowlist as it is
  closed so the gate protects it.
- Drop the `app_current_company_id() IS NULL OR ...` permissive clause
  once every read goes through a scoped client; tighten the policy to a
  strict equality check.
- Provision a non-superuser app role in the integration gate so the
  runtime probe (`CONSTRAINED_DB_URL`) runs by default (currently
  `sitelayer` is BYPASSRLS in the docker-compose integration check, so the
  probe tests skip).
