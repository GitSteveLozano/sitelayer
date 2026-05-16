-- 080_qbo_sync_runs_rls_policy.sql
--
-- Close the RLS gap on `qbo_sync_runs`. Migration 077 created the table
-- but migration 066's `scoped_tables` array (frozen / immutable per
-- CLAUDE.md operating rule #2) didn't enumerate it, so the
-- `company_isolation` policy never landed.
--
-- This migration applies the same policy shape used by 066 for every
-- other company-scoped table:
--   USING       (app_current_company_id() IS NULL OR company_id = app_current_company_id())
--   WITH CHECK  (app_current_company_id() IS NULL OR company_id = app_current_company_id())
--
-- We do NOT ENABLE ROW LEVEL SECURITY on the table — qbo_sync_runs
-- stays in shadow mode like the other Phase 1 tables. Phase 2 wiring
-- (see migration 073) is the gate that flips RLS on per-table once the
-- hot-path reads have all been migrated to withCompanyClient. Leaving
-- RLS off means the GUC-set-by-app behaviour matches the rest of the
-- pre-073 surface; flipping it on without that wiring would break
-- background sweeps and replay tooling.
--
-- The policy is permissive when `app.company_id` is unset (NULL),
-- preserving compatibility with migrations, replay tooling, and any
-- unmigrated query path. Once every route hitting qbo_sync_runs sets
-- the GUC (already true via withMutationTx / withCompanyClient), a
-- future migration can ENABLE ROW LEVEL SECURITY on this table.

DROP POLICY IF EXISTS company_isolation ON qbo_sync_runs;
CREATE POLICY company_isolation ON qbo_sync_runs
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());
