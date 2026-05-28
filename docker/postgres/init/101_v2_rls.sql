-- 101_v2_rls.sql
--
-- Close the RLS gap on the v2 entity tables (audit finding O1). Migrations
-- 097–100 added five company-scoped tables AFTER the RLS rollout (066 policy
-- bodies + 085 ENABLE/FORCE), so they shipped with NO company_isolation policy
-- and RLS off — the DB-level safety net the rest of the domain has.
--
-- The routes are already company-scoped (every read/write runs inside
-- withCompanyClient / withMutationTx, which bind app.company_id via SET LOCAL),
-- so there is no active cross-company leak. This migration adds the same
-- belt-and-suspenders guarantee the other 69 tables have:
--   - the permissive `company_isolation` policy (identical body to migration
--     066 — stays permissive when app.company_id is unset, so debug/replay/
--     webhook paths keep working);
--   - ENABLE + FORCE ROW LEVEL SECURITY (FORCE is required on DO managed PG
--     where the app runs as the table-owner `sitelayer` role — see 085).
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE; ENABLE/FORCE are safe to
-- re-run. Forward-only, additive — no data change.

DO $$
DECLARE
  scoped_table text;
  v2_tables text[] := ARRAY[
    'change_orders',
    'guardrails',
    'project_lost_reasons',
    'project_messages',
    'broadcasts'
  ];
BEGIN
  FOREACH scoped_table IN ARRAY v2_tables LOOP
    -- Skip cleanly if a table isn't present (defensive; all five exist as of 100).
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
