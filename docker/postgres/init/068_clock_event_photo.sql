-- 068_clock_event_photo.sql
--
-- Photo verification at clock-in / clock-out — ConstructionClock parity.
--
-- Construction sites have well-documented buddy-punch problems: a worker
-- hands their phone to a friend, gets clocked in at a job they aren't
-- physically at, and the geofence check passes because the friend is on
-- site. Photo capture at clock time deters this — the foreman or office
-- can later review and reject obvious mismatches.
--
-- Schema:
--   photo_storage_path     opaque Spaces key (same shape as blueprint storage),
--                          or local FS path in dev/preview. Null when the
--                          worker skipped the photo step (UI may allow this
--                          on time-critical jobs; verification stays per-row).
--   photo_verified_at      set by foreman/office on approval. Null = pending.
--   photo_verified_by      Clerk user id of the reviewer.
--   photo_verification_status  pending | approved | rejected. Default 'pending'
--                              when photo_storage_path is set; null when no
--                              photo was attached.
--
-- The /api/clock/in POST stays JSON-only (no multipart for the offline
-- queue's sake). Photos are uploaded as a follow-on step:
--   POST /api/clock/events/:id/photo  multipart/form-data { file }
-- which writes the storage path and flips the row's verification_status
-- to 'pending'. A 'pending' row is enough for the foreman's review queue
-- to surface it; approval/rejection happens via PATCH.

ALTER TABLE clock_events
  ADD COLUMN IF NOT EXISTS photo_storage_path text,
  ADD COLUMN IF NOT EXISTS photo_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS photo_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS photo_verified_by text,
  ADD COLUMN IF NOT EXISTS photo_verification_status text;

-- Status values: 'pending' | 'approved' | 'rejected'. Null when no photo
-- has been attached yet. Constraint is permissive on null because most
-- existing rows pre-date this column.
ALTER TABLE clock_events
  DROP CONSTRAINT IF EXISTS clock_events_photo_status_chk;
ALTER TABLE clock_events
  ADD CONSTRAINT clock_events_photo_status_chk
  CHECK (photo_verification_status IS NULL
         OR photo_verification_status IN ('pending', 'approved', 'rejected'));

-- The foreman review queue surfaces rows where the photo is uploaded but
-- not yet reviewed. Partial index keeps the scan cheap once approved rows
-- accumulate.
CREATE INDEX IF NOT EXISTS clock_events_photo_pending_idx
  ON clock_events (company_id, occurred_at DESC)
  WHERE photo_storage_path IS NOT NULL
    AND photo_verification_status = 'pending';
