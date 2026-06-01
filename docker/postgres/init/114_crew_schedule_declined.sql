-- Crew-schedule DECLINE / REASSIGN events (Gap 5): model a worker's decline
-- as a real workflow transition (draft → declined) instead of an out-of-band
-- worker_issues note, and allow the foreman to re-draft (declined → draft).
--
-- Additive / expand-only: three nullable audit columns. No backfill required.
-- crew_schedules.status is a plain text column with NO CHECK constraint
-- (verified against 001_schema.sql + all later migrations), so the new
-- 'declined' status value needs no constraint change. The reducer stays
-- schema v1 — these are additive states that older replay logs never emit,
-- so existing event logs replay unchanged.

ALTER TABLE crew_schedules
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_by text,
  ADD COLUMN IF NOT EXISTS decline_reason text;
