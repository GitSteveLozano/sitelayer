-- 082_daily_logs_workflow.sql
--
-- Workflowize the daily_logs SUBMIT path.
--
-- Adds the deterministic-workflow scaffolding column to `daily_logs` so
-- the existing POST /api/daily-logs/:id/submit flow runs through the
-- registered reducer + writes workflow_event_log alongside the
-- `status='submitted'` flip.
--
-- The reducer uses two states: 'draft' and 'submitted'. Existing
-- 'submitted' rows are backfilled to state_version=2 so they match
-- exactly one SUBMIT transition from the v1 default of 1. Existing
-- 'draft' rows already match state_version=1.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS plus a guarded UPDATE. Safe to
-- re-apply against seeded fixtures that already include a submitted row.

ALTER TABLE daily_logs
  ADD COLUMN IF NOT EXISTS state_version int NOT NULL DEFAULT 1;

UPDATE daily_logs
   SET state_version = 2
 WHERE status = 'submitted' AND state_version = 1;
