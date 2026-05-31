-- 112_worker_issues_state_column.sql
--
-- Persist the field_event workflow state directly on worker_issues, and add
-- the dismissed-trail columns the reducer already models. Until now the route
-- (apps/api/src/routes/worker-issues.ts) DERIVED the workflow state from a
-- `resolved_action = '__dismissed__'` sentinel + the escalation/resolution
-- timestamps, and overloaded resolved_at/resolved_by_clerk_user_id to record
-- a DISMISS. That diverged from the pure reducer
-- (packages/workflows/src/field-event.ts), whose snapshot carries a real
-- `state` plus `dismissed_at` / `dismissed_by_user_id`.
--
-- DETERMINISTIC_WORKFLOWS.md rule 4 requires persisting {status, state_version}.
-- This migration completes the row shape so the persisted columns match the
-- reducer snapshot 1:1 and the sentinel can be retired.
--
-- Expand / backfill / contract:
--   * Expand  — add `state` (NOT NULL DEFAULT 'open' + CHECK), `dismissed_at`,
--               `dismissed_by_clerk_user_id`. All additive; new code tolerates
--               the old shape during rollout because the backfill below runs
--               in the same migration that adds the column.
--   * Backfill— set `state` from the legacy derivation for existing rows and
--               migrate the '__dismissed__' sentinel into the new columns.
--   * Contract— happens in the route code (deletes the sentinel + the column
--               derivation); no further SQL.

ALTER TABLE worker_issues
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_by_clerk_user_id text;

ALTER TABLE worker_issues
  DROP CONSTRAINT IF EXISTS worker_issues_state_chk;

ALTER TABLE worker_issues
  ADD CONSTRAINT worker_issues_state_chk CHECK (
    state IN ('open', 'resolved', 'escalated', 'dismissed')
  );

-- Backfill order matters. Derive escalated first (the legacy
-- rowToWorkflowState checked escalated_to_estimator_at FIRST), then migrate
-- the dismissed sentinel into the dedicated columns (clearing the overloaded
-- resolved_* fields), then everything still carrying a resolved_at lands as
-- 'resolved'. Rows with none of these stay 'open' (the column default).

UPDATE worker_issues
  SET state = 'escalated'
  WHERE escalated_to_estimator_at IS NOT NULL
    AND state = 'open';

UPDATE worker_issues
  SET state = 'dismissed',
      dismissed_at = resolved_at,
      dismissed_by_clerk_user_id = resolved_by_clerk_user_id,
      resolved_at = NULL,
      resolved_by_clerk_user_id = NULL,
      resolved_action = NULL
  WHERE resolved_action = '__dismissed__'
    AND state = 'open';

UPDATE worker_issues
  SET state = 'resolved'
  WHERE resolved_at IS NOT NULL
    AND state = 'open';
