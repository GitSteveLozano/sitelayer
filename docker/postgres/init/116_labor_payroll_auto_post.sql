-- 116_labor_payroll_auto_post.sql
--
-- Design-implied "THIS WEEK PAYROLL · AUTO" auto-post path for the
-- labor_payroll_run workflow (Money · Cash Flow design tile, dsg__03).
--
-- The auto-post flow is NOT a new state machine. It walks the SAME
-- generated → approved → posting → posted pipeline as the human path; the
-- only difference is the ACTOR. A worker auto-post tick evaluates each
-- `generated` / `approved` run against a per-company policy and dispatches
-- the worker-only AUTO_APPROVE / AUTO_POST_REQUESTED events through the
-- existing pure reducer (packages/workflows/src/labor-payroll.ts), so the
-- state_version / outbox / idempotency guarantees are unchanged.
--
-- Additive / expand-only. No applied migration is edited.
--
-- ── labor_payroll_runs.auto_posted ──────────────────────────────────────
-- Per-run flag set true when an AUTO_APPROVE or AUTO_POST_REQUESTED
-- advanced the run, so the trail / UI can label it "Auto-posted". The
-- reducer carries this field (LaborPayrollWorkflowSnapshot.auto_posted);
-- this column persists it. Backfilled false → zero behavior change for
-- existing runs.

ALTER TABLE labor_payroll_runs
  ADD COLUMN IF NOT EXISTS auto_posted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN labor_payroll_runs.auto_posted IS
  'True when the worker auto-post tick advanced this run via AUTO_APPROVE / '
  'AUTO_POST_REQUESTED instead of a human APPROVE / POST_REQUESTED. Maps to '
  'LaborPayrollWorkflowSnapshot.auto_posted. Default false = human-driven.';

-- ── companies auto-post policy ───────────────────────────────────────────
-- Per-company opt-in policy for the weekly auto-post. OFF by default for
-- every existing company (auto_post_enabled false), so no customer's
-- payroll auto-pushes to QuickBooks without an explicit opt-in. The clock
-- read (is `now` inside the weekly window?) lives in the worker tick — the
-- reducer stays pure. Precedents for per-company config columns:
-- 062_company_modules_and_bookkeeper.sql, 070_labor_ot_service_item_code.sql,
-- 102_company_profile_and_working_hours.sql.
--
--   labor_payroll_auto_post_enabled : master opt-in switch (false = off).
--   labor_payroll_auto_post_weekday : ISO weekday (1=Mon .. 7=Sun) the
--                                     weekly auto-post window opens on.
--   labor_payroll_auto_post_after   : local time-of-day the window opens
--                                     (e.g. '17:00' = only auto-post after
--                                     5pm on the configured weekday).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS labor_payroll_auto_post_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS labor_payroll_auto_post_weekday int;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS labor_payroll_auto_post_after time;

ALTER TABLE companies
  ADD CONSTRAINT companies_labor_payroll_auto_post_weekday_chk
    CHECK (labor_payroll_auto_post_weekday IS NULL
           OR labor_payroll_auto_post_weekday BETWEEN 1 AND 7)
    NOT VALID;

COMMENT ON COLUMN companies.labor_payroll_auto_post_enabled IS
  'Per-company opt-in for the weekly labor-payroll auto-post. false (default) '
  '= no auto-advance; runs only move via human APPROVE / POST_REQUESTED. '
  'true = the worker labor_payroll_auto_post lane may dispatch AUTO_APPROVE / '
  'AUTO_POST_REQUESTED for runs in the configured weekly window.';

COMMENT ON COLUMN companies.labor_payroll_auto_post_weekday IS
  'ISO weekday (1=Mon .. 7=Sun) the weekly auto-post window opens. NULL when '
  'auto-post is disabled.';

COMMENT ON COLUMN companies.labor_payroll_auto_post_after IS
  'Local time-of-day the weekly auto-post window opens (e.g. 17:00). The '
  'worker tick reads the clock; the reducer never does.';
