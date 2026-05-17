-- 081_notifications_workflow.sql
--
-- Lift the notifications row lifecycle into a deterministic workflow.
--
-- Background: prior to this migration the notification runner
-- (apps/worker/src/runners/notification.ts + apps/worker/src/notifications.ts)
-- flipped `notifications.status` directly via ~20 implicit `update
-- notifications set status = '...'` SQL fragments — pending / failed /
-- sent overloaded onto a free-text column. We're moving those to a
-- registered packages/workflows reducer (see
-- packages/workflows/src/notification.ts) with full workflow_event_log
-- audit support, matching the rental-billing pattern.
--
-- The reducer needs an explicit `state_version` so the runner can
-- apply optimistic-concurrency checks (read locked snapshot → run
-- reducer → write new state with state_version + 1, fail on stale
-- writes). The other workflow-discipline columns (workflow_engine,
-- workflow_run_id) follow the convention introduced by migration 023
-- and 076.
--
-- Idempotent: every column / index is `IF NOT EXISTS`.
--
-- Status column policy: we keep `notifications.status` as a free-text
-- column rather than enforcing the reducer's state set via a CHECK
-- constraint. Two reasons:
--   1. The existing column has no CHECK and is populated by both the
--      runner (procedural status flips) and a few API code paths.
--      Adding a CHECK that only accepts the reducer's eight states
--      would block this migration from applying against any tier that
--      still has rows with the legacy `'failed'` / `'pending'`
--      values. The reducer is the canonical validator going forward;
--      adding a DB-level CHECK is a follow-up once the runner has
--      bedded in.
--   2. The reducer's `failure_kind` discriminator lets us distinguish
--      `failed_clerk_not_found` (terminal) from `failed_clerk_unreachable`
--      (retryable) without growing the column vocabulary. The runner
--      writes the new state names; legacy `'failed'` rows stay as-is
--      and are migrated lazily by the runner's normal claim path.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS state_version int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS workflow_engine text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS workflow_run_id text;

-- Backfill `state_version` on existing rows so the reducer's
-- optimistic-concurrency check has a sane baseline. The reducer's
-- view of a freshly-claimed `pending` row is:
--   pending → state_version 1 (one transition past row creation)
-- Rows that have already shipped (`sent`) or terminally failed
-- (`failed`) have transitioned at least once already; we set them to
-- 1 too because the per-state-version event log starts blank for
-- pre-migration rows. The unique (entity_id, state_version)
-- constraint on workflow_event_log prevents collisions with new
-- events written by the post-migration runner.
UPDATE notifications
   SET state_version = 1
 WHERE state_version = 0;
