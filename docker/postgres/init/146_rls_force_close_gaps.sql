-- 146_rls_force_close_gaps.sql
--
-- Close the seven allowlisted "KNOWN GAP" company-scoped tables that the
-- forced-coverage RLS audit (apps/api/src/routes/rls-force-audit.ts) was
-- tracking as exemptions:
--
--   company_pricing_overrides
--   customer_pricing_overrides
--   project_pricing_overrides
--   qbo_sync_runs
--   rental_rate_tiers
--   takeoff_capture_artifacts
--   takeoff_drafts
--
-- Every one of these has `company_id uuid NOT NULL REFERENCES companies(id)`
-- and is genuinely per-tenant data (verified against the create migrations:
-- 071 pricing overrides, 077 qbo_sync_runs, 067 rental_rate_tiers, 069
-- takeoff_capture_artifacts, 066 takeoff_drafts). None is the tenant root and
-- none is global reference data, so the correct fix is the same app.company_id
-- RLS the rest of the domain has — NOT a different policy and NOT a documented
-- exemption.
--
-- Why they shipped unforced: each table was created AFTER the 066 policy sweep
-- + 085 ENABLE/FORCE flip, in a migration that did not add its own per-table
-- RLS. (Two of them — rental_rate_tiers via 067 and qbo_sync_runs via 080 —
-- already have the `company_isolation` POLICY but never had RLS ENABLEd/FORCEd;
-- the other five have no policy at all.) This is the exact asset_deployments
-- gap class that migration 145 + the blocking force-audit gate now guard.
--
-- The route + worker layers were audited before forcing (slice rls-gaps):
--   - pricing reads (apps/api/src/pricing.ts): every UNION-ALL layer filters
--     `where company_id = $1`, so reads stay correct under FORCE whether or not
--     the GUC is bound.
--   - rental_rate_tiers (apps/api/src/routes/rental-contract-lines.ts): reads go
--     through withCompanyClient(ctx.company.id, ...) and writes through
--     withMutationTx — both SET LOCAL app.company_id, and inserts use
--     ctx.company.id so WITH CHECK passes.
--   - qbo_sync_runs (apps/api/src/routes/qbo.ts + qbo-sync-run.ts): reads via
--     withCompanyClient, writes via withMutationTx, all filtered on company_id.
--   - takeoff_drafts (apps/api/src/routes/takeoff-drafts.ts, projects.ts): reads
--     via withCompanyClient or bare pool.query that ALWAYS filters
--     `where company_id = $1`; inserts via withMutationTx using ctx.company.id.
--     The two bare-pool helpers (resolveDefaultDraftId / validateDraftId) take
--     the company id as an argument and pin it in the WHERE clause — they are
--     not cross-tenant-leaky and stay correct under FORCE via the permissive
--     NULL-GUC clause.
--   - takeoff_capture_artifacts: no live query path in apps/api or apps/worker
--     (provenance table); forcing it is purely additive.
--   - The scenario engine (packages/scenario) and the worker drain paths set
--     company_id explicitly and rely on the permissive NULL-GUC clause for
--     seeding/replay — unchanged by this migration.
--
-- Policy shape is IDENTICAL to migration 066 / 085 / 101 / 145: permissive when
-- `app.company_id` is unset (`app_current_company_id() IS NULL OR ...`) so
-- migrations, replay tooling, debug routes, and the scenario seeder keep
-- working; strict equality once the GUC is bound, with WITH CHECK rejecting a
-- cross-company INSERT/UPDATE.
--
-- FORCE is required because on DigitalOcean Managed Postgres the migrator runs
-- as `doadmin` (superuser) but the app connects as the table-owner `sitelayer`
-- role, which would otherwise bypass RLS (see migration 085).
--
-- Idempotent + forward-only + additive (no data change): DROP POLICY IF EXISTS
-- before CREATE so re-running re-asserts the canonical body; ENABLE/FORCE are
-- no-ops on an already-enabled/forced table; the to_regclass guard skips a
-- missing table with a NOTICE rather than erroring (same NOTICE-tolerant
-- pattern as 101 / 145). Tolerates the old schema during rollout — new code
-- already binds app.company_id where it matters, and the permissive clause
-- keeps unbound paths working.

DO $rls_force_close_gaps$
DECLARE
  scoped_table text;
  scoped_tables text[] := ARRAY[
    'company_pricing_overrides',
    'customer_pricing_overrides',
    'project_pricing_overrides',
    'qbo_sync_runs',
    'rental_rate_tiers',
    'takeoff_capture_artifacts',
    'takeoff_drafts'
  ];
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    -- Skip cleanly if a table isn't present (defensive; all seven exist by
    -- migration 077 at the latest).
    IF to_regclass(scoped_table) IS NULL THEN
      RAISE NOTICE 'skip RLS for missing table %', scoped_table;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS company_isolation ON %I', scoped_table);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I
         FOR ALL
         USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
         WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id())',
      scoped_table
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
  END LOOP;
END
$rls_force_close_gaps$;
