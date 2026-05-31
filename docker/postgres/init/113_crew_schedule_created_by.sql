-- Crew-schedule CREATE event (Gap 2): record the creator on the row so the
-- workflow's synthetic seed-only CREATE event can stamp `created_by` and the
-- replay corpus has a true origin.
--
-- Additive / expand-only: nullable column, no backfill. Existing rows keep
-- NULL (their creation predates the CREATE event being modeled). The status
-- column stays plain text (no CHECK constraint exists on crew_schedules.status),
-- so no enum/constraint change is needed for this migration.

ALTER TABLE crew_schedules
  ADD COLUMN IF NOT EXISTS created_by text;
