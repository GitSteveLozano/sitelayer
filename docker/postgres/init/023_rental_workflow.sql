-- Phase 1 of rentals workflowization.
--
-- Adds the deterministic-workflow scaffolding columns to `rentals` so
-- the replay sweep timer can cover rentals just like rental_billing_runs,
-- estimate_pushes, and crew_schedules. Phase 2 (route rewrite to use
-- POST /events instead of PATCH set status) ships in a follow-up PR
-- — that's surgery on cadence-driven worker code paths and warrants
-- its own review.
--
-- This migration is purely additive; existing PATCH paths and worker
-- behaviour are unchanged. The reducer + registry registration in
-- packages/workflows/src/rental.ts validates the four states/seven
-- transitions but is not wired in yet.

ALTER TABLE rentals
  ADD COLUMN IF NOT EXISTS state_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_by text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by text,
  ADD COLUMN IF NOT EXISTS workflow_engine text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS workflow_run_id text;

-- Backfill state_version from current status. The reducer's view:
--   active           → state_version 1 (default)
--   returned         → 2 (one transition: RETURN)
--   invoiced_pending → 3 (RETURN + INVOICE_QUEUED)
--   closed           → 4 (RETURN + INVOICE_QUEUED + CLOSE) — historic data
--                       may have skipped intermediate states; that's
--                       fine, replay surfaces the gap.
UPDATE rentals SET state_version = 2 WHERE status = 'returned' AND state_version = 1;
UPDATE rentals SET state_version = 3 WHERE status = 'invoiced_pending' AND state_version = 1;
UPDATE rentals SET state_version = 4 WHERE status = 'closed' AND state_version = 1;
