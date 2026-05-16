-- 073_workflow_columns_for_implicit_state_machines.sql
--
-- Workflow-discipline backfill. Four implicit state machines are being
-- lifted into registered packages/workflows reducers in the same PR:
--
--   1. damage_charge_settlement (damage_charges)
--      Already carries state_version + status from 060; this migration
--      just adds the workflow_engine / workflow_run_id audit columns to
--      match the convention used by rentals (migration 023).
--   2. rental_request_approval (rental_requests)
--      Needs state_version + workflow_engine / workflow_run_id added so
--      the reducer can apply optimistic-concurrency checks.
--   3. qbo_sync_run (NEW table — see migration 074)
--   4. scaffold_ops_approval (boms)
--      Needs state_version added so the BOM approve route can dispatch
--      through the reducer.
--
-- All additions are nullable / `IF NOT EXISTS` / DEFAULT-backed. Existing
-- rows backfill cleanly without rewrites. Workflow_engine defaults to
-- 'postgres' to mirror migration 023.

ALTER TABLE damage_charges
  ADD COLUMN IF NOT EXISTS workflow_engine text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS workflow_run_id text;

ALTER TABLE rental_requests
  ADD COLUMN IF NOT EXISTS state_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS workflow_engine text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS workflow_run_id text;

-- Backfill state_version on rental_requests so existing rows reflect
-- their transition count. The reducer's view:
--   pending  → state_version 1 (default)
--   approved → 2 (one transition: APPROVE)
--   declined → 2 (one transition: DECLINE)
UPDATE rental_requests SET state_version = 2 WHERE status IN ('approved', 'declined') AND state_version = 1;

ALTER TABLE boms
  ADD COLUMN IF NOT EXISTS state_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS workflow_engine text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS workflow_run_id text;

-- Backfill state_version on boms.
--   draft      → 1 (default)
--   approved   → 2 (one transition: APPROVE)
--   superseded → 2 (treated as one transition past draft)
UPDATE boms SET state_version = 2 WHERE status IN ('approved', 'superseded') AND state_version = 1;
