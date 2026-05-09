-- 051_labor_payroll_runs.sql
--
-- Labor payroll workflow — QBO TimeActivity export.
--
-- Pairs with the time-review workflow. After a time_review_run is
-- APPROVED, the existing `lock_labor_entries` worker handler stamps
-- review_locked_at on every covered labor_entry. AFTER lock_labor_entries
-- lands, a downstream worker handler enqueues
-- `generate_labor_payroll_run` which materialises one row in this table
-- per (company_id, period_start, period_end) — covering every locked
-- labor_entry in the window that isn't already part of a payroll run.
--
-- The run then walks generated → approved → posting → posted | failed
-- → voided exactly the same way rental_billing_runs does. The QBO push
-- translates each covered labor_entry into a TimeActivity record and
-- the success payload carries the array of QBO TimeActivity ids
-- (qbo_payroll_batch_ref jsonb).
--
-- See packages/workflows/src/labor-payroll.ts for the transition table.
-- See apps/api/src/routes/labor-payroll-runs.ts for the route surface.
-- See apps/worker/src/labor-payroll-push.ts for the QBO drain.

CREATE TABLE IF NOT EXISTS labor_payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Inclusive period covered by this payroll batch. Typically one
  -- pay-period, can be a single day for tightly-scoped batches.
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- Workflow state. See packages/workflows/src/labor-payroll.ts. The
  -- column is named `state` (not `status`) to match time_review_runs;
  -- rental_billing_runs uses `status` for legacy reasons.
  state text NOT NULL DEFAULT 'generated',
  state_version int NOT NULL DEFAULT 1,
  -- Decision metadata. Same shape as rental_billing_runs.
  approved_at timestamptz,
  approved_by_user_id text,
  posted_at timestamptz,
  failed_at timestamptz,
  error_message text,
  -- QBO push artifact. Stores the array of TimeActivity ids returned
  -- by the worker drain on POST_SUCCEEDED. jsonb so the shape can
  -- evolve (we may want to attach per-entry → ta_id maps later).
  qbo_payroll_batch_ref jsonb,
  -- Snapshot of which labor_entries this payroll run covers. Captured
  -- at run-creation time so subsequent edits to labor_entries don't
  -- widen the audit boundary. Each labor_entries row also carries a
  -- payroll_run_id back-reference (added below).
  covered_labor_entry_ids uuid[] NOT NULL DEFAULT '{}',
  total_hours numeric(10, 2) NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  -- Optional link to the upstream time_review_run that locked these
  -- entries. NULL when the payroll run was created directly from a
  -- period (e.g. by an admin recovering a misplaced batch).
  time_review_run_id uuid REFERENCES time_review_runs(id) ON DELETE SET NULL,
  -- Workflow scaffolding (matches rental_billing_runs / estimate_pushes).
  workflow_engine text NOT NULL DEFAULT 'postgres',
  workflow_run_id text,
  version int NOT NULL DEFAULT 1,
  origin text DEFAULT current_setting('app.tier', true),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labor_payroll_runs_state_chk
    CHECK (state IN ('generated', 'approved', 'posting', 'posted', 'failed', 'voided')),
  CONSTRAINT labor_payroll_runs_period_chk
    CHECK (period_end >= period_start),
  UNIQUE (company_id, id),
  -- One payroll batch per period per company. Re-running a payroll
  -- export for the same window must reuse the same row (or void the
  -- prior one first); duplicate batches would double-push to QBO.
  UNIQUE (company_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS labor_payroll_runs_company_state_idx
  ON labor_payroll_runs (company_id, state, period_start DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS labor_payroll_runs_company_period_idx
  ON labor_payroll_runs (company_id, period_start DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS labor_payroll_runs_time_review_idx
  ON labor_payroll_runs (company_id, time_review_run_id)
  WHERE time_review_run_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS labor_payroll_runs_origin_idx
  ON labor_payroll_runs (origin) WHERE origin IS NOT NULL;

-- Back-reference column on labor_entries. When a labor entry is
-- locked into a payroll run (either at run creation or via the
-- generate_labor_payroll_run worker handler), this column gets set.
-- A non-null payroll_run_id is the signal that the entry has been
-- claimed by an in-flight or completed payroll batch — the preview
-- endpoint must skip these so a second batch can't double-claim them.
ALTER TABLE labor_entries
  ADD COLUMN IF NOT EXISTS payroll_run_id uuid REFERENCES labor_payroll_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS labor_entries_payroll_run_idx
  ON labor_entries (payroll_run_id) WHERE payroll_run_id IS NOT NULL;
