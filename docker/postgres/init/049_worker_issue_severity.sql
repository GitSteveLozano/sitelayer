-- 049_worker_issue_severity.sql
--
-- Field-event escalation slice for worker_issues. Migration 044 created the
-- table with kind/message and resolution timestamps; the field-event workflow
-- (packages/workflows/src/field-event.ts) needs three more axes on the row:
--
--   1. severity — how urgent is this ping? Drives the foreman inbox sort and
--      the auto-escalation rule (severity='stopped' older than 15min without
--      RESOLVE escalates to estimator). Bounded enum so adding a new band
--      later is a CHECK constraint amend, not a schema rebuild.
--   2. resolved_action / resolution_message — what the foreman did, and the
--      message they sent back to the worker. Both nullable because a ping
--      can be DISMISSED (no action) or ESCALATED (no resolution).
--   3. state_version — workflow optimistic-concurrency token, bumped by the
--      pure reducer on every accepted event. Mirrors time_review_runs and
--      rental_billing_runs.
--   4. escalated_to_estimator_at / escalation_reason — when the issue was
--      handed off to the estimator queue, and why. Used by migration 050's
--      estimator-queue index.
--
-- All columns are additive and nullable except state_version (defaults 1) and
-- severity (defaults 'slowing' so existing rows from migration 044 land in
-- the middle band rather than mis-flagged as stopped or merely a question).

ALTER TABLE worker_issues
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'slowing',
  ADD COLUMN IF NOT EXISTS resolved_action text,
  ADD COLUMN IF NOT EXISTS resolution_message text,
  ADD COLUMN IF NOT EXISTS state_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS escalated_to_estimator_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_reason text;

ALTER TABLE worker_issues
  DROP CONSTRAINT IF EXISTS worker_issues_severity_chk;

ALTER TABLE worker_issues
  ADD CONSTRAINT worker_issues_severity_chk CHECK (
    severity IN ('question', 'slowing', 'stopped')
  );

-- resolved_action is loose-text on purpose: 'order_more', 'bring_from_site',
-- 'use_what_we_have', 'park', 'change_order' is the v1 set, but the foreman
-- UI may surface category-specific actions (e.g. 'send_replacement' for
-- equipment_broken) without a column rebuild. Reducer-side validation lives
-- in packages/workflows/src/field-event.ts.

-- resolution_message is bounded so a typo'd 50KB paste from the foreman's
-- clipboard doesn't blow up notification payloads downstream.
ALTER TABLE worker_issues
  DROP CONSTRAINT IF EXISTS worker_issues_resolution_message_len_chk;

ALTER TABLE worker_issues
  ADD CONSTRAINT worker_issues_resolution_message_len_chk CHECK (
    resolution_message IS NULL OR char_length(resolution_message) BETWEEN 1 AND 4000
  );
