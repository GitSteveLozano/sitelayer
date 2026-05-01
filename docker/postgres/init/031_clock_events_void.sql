-- 031_clock_events_void.sql
--
-- Soft-delete columns for clock_events to support the wk-clockin
-- "wait, that wasn't me" affordance.
--
-- 029 added correctible_until (the deadline the worker has to void an
-- auto-fired event); this migration adds the actual void columns and
-- the partial index the pair-up SQL relies on. clock_events stays
-- append-only — voided rows aren't deleted, just flagged. The pair-up
-- logic in apps/api/src/routes/clock.ts filters voided_at IS NULL so a
-- voided 'in' doesn't pin the next clock-in into a stale state.
--
-- voided_by carries the actor user id (clerk_user_id) so an audit
-- can distinguish self-corrections from foreman overrides. The
-- foreman_override path uses the same column even though the source
-- event was the worker's — what matters at audit time is who pulled
-- the trigger.

ALTER TABLE clock_events
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by text;

-- Partial index used by /api/clock/out's open-clock-in lookup and the
-- daily timeline. Keeps the index small (voided rows are rare) while
-- still answering the "most recent open in for this worker" query
-- in O(log n).
CREATE INDEX IF NOT EXISTS clock_events_active_worker_idx
  ON clock_events (company_id, worker_id, occurred_at DESC)
  WHERE voided_at IS NULL;
