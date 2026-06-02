-- 145_asset_deployments_rls.sql
--
-- Close the RLS gap on `asset_deployments` (audit finding: the table-without-
-- a-policy class that the Phase 3 RLS audit gate now blocks on). Migration
-- 118 created `asset_deployments` with `company_id uuid NOT NULL` AFTER the
-- Phase 1 policy sweep (066) and the Phase 3 ENABLE/FORCE flip (085), so it
-- shipped with NO `company_isolation` policy and RLS OFF — the DB-level
-- tenant-isolation net every other company-scoped domain table has.
--
-- The route layer already binds `app.company_id` via SET LOCAL inside
-- withCompanyClient / withMutationTx, so there is no active cross-company
-- leak today. This migration adds the same belt-and-suspenders guarantee the
-- rest of the domain has, mirroring 066 (policy body) + 085 (ENABLE/FORCE)
-- and following the single-table precedent set by 101_v2_rls.sql:
--   - the permissive `company_isolation` policy (identical body to migration
--     066 — stays permissive when app.company_id is unset, so debug/replay/
--     webhook paths keep working);
--   - ENABLE + FORCE ROW LEVEL SECURITY (FORCE is required on DO managed PG
--     where the app runs as the table-owner `sitelayer` role — see 085).
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE; ENABLE/FORCE are safe to
-- re-run (Postgres treats them as no-ops on an already-enabled/forced table).
-- Forward-only, additive — no data change. Tolerates the old schema during
-- rollout: the `to_regclass` guard skips cleanly if the table is somehow
-- absent (same NOTICE-tolerant pattern 101 uses).

DO $$
DECLARE
  scoped_table text;
  scoped_tables text[] := ARRAY[
    'asset_deployments'
  ];
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    -- Skip cleanly if a table isn't present (defensive; asset_deployments
    -- exists as of migration 118).
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
END $$;
