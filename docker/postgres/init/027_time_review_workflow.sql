-- 027_time_review_workflow.sql
--
-- Sixth deterministic workflow: time review (Sitemap.html § t-approve).
--
-- A time_review_run gathers a window of labor_entries (typically a
-- pay period or a single day for one project) and walks them through
-- the deterministic state machine in
-- packages/workflows/src/time-review.ts. The reviewer (foreman or
-- office) opens the run, reviews each entry's anomaly flags, and
-- approves or rejects the run as a whole. Per-entry edits remain on
-- PATCH /api/labor-entries/:id (the workflow doesn't fragment that
-- write path).
--
-- States: pending → approved | rejected, with REOPEN moving back to
-- pending so a corrected run can be re-approved without losing its
-- audit history (workflow_event_log retains every transition).
--
-- Anomaly detection is intentionally simple in Phase 1A: we record
-- counts at run-creation time. Phase 5 will let the cohort model
-- enrich anomaly_count with portfolio context (e.g. "this crew is
-- 18% over their usual hours per sqft").

CREATE TABLE IF NOT EXISTS time_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Optional project scope. NULL = workspace-wide review.
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  -- Inclusive period. Typically one pay-period; runs can be one day.
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- Workflow state. See packages/workflows/src/time-review.ts for the
  -- transition table. state_version follows the rental_billing pattern:
  -- the version BEFORE the next dispatched event.
  state text NOT NULL DEFAULT 'pending',
  state_version int NOT NULL DEFAULT 1,
  -- Snapshot at run-creation time. covered_entry_ids is the explicit
  -- set of labor_entries this run reviewed; locking on approval reads
  -- from this column so subsequent edits to the table don't widen
  -- the audit boundary.
  covered_entry_ids uuid[] NOT NULL DEFAULT '{}',
  total_hours numeric(10, 2) NOT NULL DEFAULT 0,
  total_entries int NOT NULL DEFAULT 0,
  anomaly_count int NOT NULL DEFAULT 0,
  -- Reviewer / decision metadata.
  reviewer_user_id text,
  approved_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  reopened_at timestamptz,
  -- Workflow scaffolding (matches crew_schedules / rental columns).
  workflow_engine text NOT NULL DEFAULT 'postgres',
  workflow_run_id text,
  -- Audit.
  origin text DEFAULT current_setting('app.tier', true),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_review_runs_state_chk
    CHECK (state IN ('pending', 'approved', 'rejected')),
  CONSTRAINT time_review_runs_period_chk
    CHECK (period_end >= period_start),
  CONSTRAINT time_review_runs_decision_chk CHECK (
    (state = 'pending'  AND approved_at IS NULL AND rejected_at IS NULL) OR
    (state = 'approved' AND approved_at IS NOT NULL AND rejected_at IS NULL) OR
    (state = 'rejected' AND rejected_at IS NOT NULL AND approved_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS time_review_runs_company_state_idx
  ON time_review_runs (company_id, state, period_start DESC);
CREATE INDEX IF NOT EXISTS time_review_runs_company_period_idx
  ON time_review_runs (company_id, period_start DESC);
CREATE INDEX IF NOT EXISTS time_review_runs_company_project_period_idx
  ON time_review_runs (company_id, project_id, period_start DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS time_review_runs_origin_idx
  ON time_review_runs (origin) WHERE origin IS NOT NULL;

-- Lock columns on labor_entries. When a time_review_run is APPROVED
-- the workflow side-effect ('lock_labor_entries') sets these on every
-- row in covered_entry_ids. Locked entries reject PATCH unless the
-- caller has admin role + supplies a justification (enforced in the
-- route handler, not the column).
ALTER TABLE labor_entries
  ADD COLUMN IF NOT EXISTS review_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_run_id uuid REFERENCES time_review_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS labor_entries_review_run_idx
  ON labor_entries (review_run_id) WHERE review_run_id IS NOT NULL;
