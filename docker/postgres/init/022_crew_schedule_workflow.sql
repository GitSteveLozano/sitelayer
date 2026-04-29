-- Workflowize crew_schedules.
--
-- Adds the deterministic-workflow columns (state_version, workflow_engine,
-- workflow_run_id) plus per-transition timestamps + actor ids so the same
-- replay tooling that runs against rental_billing_runs and estimate_pushes
-- works against crew_schedules.
--
-- The status column already exists with values 'draft' (default) and
-- 'confirmed' (set by POST /api/schedules/:id/confirm). After this
-- migration the route's logic is preserved bit-for-bit; the only behavioral
-- change is that the confirm transition is captured in workflow_event_log.
-- A future migration may add 'cancelled' once the UI ships a cancellation
-- affordance.

ALTER TABLE crew_schedules
  ADD COLUMN IF NOT EXISTS state_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by text,
  ADD COLUMN IF NOT EXISTS workflow_engine text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS workflow_run_id text;

-- Backfill state_version for any existing rows already in 'confirmed'
-- (so they land at v2, matching one transition from the v1 default).
-- Pre-existing 'draft' rows stay at v1.
UPDATE crew_schedules
   SET state_version = 2
 WHERE status = 'confirmed' AND state_version = 1;
