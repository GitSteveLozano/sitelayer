-- 073_notifications_delivery_retry.sql
--
-- Telemetry follow-up: notification delivery retry loop.
--
-- The existing `notifications` table tracks `attempt_count`,
-- `next_attempt_at`, and `error` across the entire row lifecycle —
-- including Clerk hydration retries and per-row failures unrelated to
-- the dispatcher actually attempting a send (e.g. preference lookups).
-- We need dedicated counters for *delivery* attempts so the retry-loop
-- semantics described in the obs follow-up can be enforced without
-- conflating them with hydration / preference deferrals.
--
-- This migration adds:
--   * delivery_attempts    — incremented every time the worker actually
--                            asks a dispatch channel to deliver and
--                            the channel reported a transient failure.
--   * next_delivery_at     — when the retry loop should re-attempt
--                            delivery. Mirrors next_attempt_at but is
--                            owned by the delivery loop only.
--   * last_delivery_error  — last channel error string (truncated by
--                            the worker), separate from the legacy
--                            `error` column.
--
-- We keep the existing columns intact: the dispatcher / hydration paths
-- still write to them so legacy operators don't lose visibility. The
-- new columns are populated alongside on every retry; the failure cap
-- (NOTIFICATION_MAX_ATTEMPTS, default 5) is enforced against
-- `delivery_attempts` so hydration backoffs don't burn the cap.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS next_delivery_at timestamptz;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS last_delivery_error text;

-- Partial index so the retry loop can cheaply find rows that are
-- waiting on their next_delivery_at fence. Limited to pending rows.
CREATE INDEX IF NOT EXISTS notifications_next_delivery_idx
  ON notifications(next_delivery_at)
  WHERE status = 'pending' AND next_delivery_at IS NOT NULL;
