-- Phase 2 — enable row-level security on the append-only / queue tables.
--
-- Migration 066 defined a `company_isolation` policy on every company-scoped
-- table but kept RLS DISABLED ("shadow mode") so unmigrated readers would
-- keep working. With the API routes + worker drains now wired through
-- `withCompanyClient` / `withMutationTx` / `setCompanyGuc`, we can flip RLS
-- on the four lowest-risk tables in the rollout sequence documented in
-- `docs/SECURITY_RLS.md`:
--
--   1. audit_events       — append-only, read by support/debug routes only
--   2. workflow_event_log — append-only, written inside withMutationTx,
--                           read by replay tooling
--   3. mutation_outbox    — queue table, written by ledger helpers, drained
--                           by the worker
--   4. sync_events        — queue table, same shape as mutation_outbox
--
-- We leave the larger-surface tables (projects, customers, takeoff_*,
-- estimate_*, labor_*, rentals, etc.) for a follow-up migration once
-- staging soak time confirms the wiring is correct.
--
-- IMPORTANT: the policy from migration 066 stays permissive when
-- `app.company_id` is unset (`USING (app_current_company_id() IS NULL OR
-- ...)`), so legacy / unmigrated code paths still work after this flip.
-- The real value of ENABLE here is:
--   - WITH CHECK fires on every INSERT/UPDATE: a transaction with
--     `app.company_id = A` cannot insert a row with `company_id = B`,
--     even by accident.
--   - Confirms the wiring in dev / preview before the policy is later
--     tightened to a strict equality check.
--
-- FORCE is required because on DigitalOcean Managed Postgres the migrator
-- runs as the `doadmin` superuser but the app runs as `sitelayer` (which
-- is the table owner in `sitelayer_prod`). Without FORCE the table owner
-- bypasses RLS and the migration would be a no-op in prod. Note that the
-- CI database also runs migrations as a superuser (`sitelayer` in the
-- `quality.yml` workflow is BYPASSRLS), so RLS enforcement is NOT covered
-- by the integration test suite in CI; the rls.test.ts suite explicitly
-- creates a non-superuser role for that purpose. Prod is the first place
-- this actually fires.

DO $rls_enable$
DECLARE
  scoped_table text;
  scoped_tables text[] := ARRAY[
    'audit_events',
    'workflow_event_log',
    'mutation_outbox',
    'sync_events'
  ];
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = scoped_table
    ) THEN
      RAISE NOTICE 'rls phase 2: skipping % (table missing)', scoped_table;
      CONTINUE;
    END IF;

    -- Defense-in-depth: re-assert the policy in case a follow-up migration
    -- ever drops it. migration 066's DO block also drops + recreates it.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = scoped_table
        AND policyname = 'company_isolation'
    ) THEN
      RAISE EXCEPTION 'rls phase 2: company_isolation policy missing on %', scoped_table;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
  END LOOP;
END
$rls_enable$;
