-- 056_daily_log_photo_metadata.sql
--
-- fm-log photo timeline grouping by scope step.
--
-- The original `daily_logs.photo_keys text[]` column captured a flat list of
-- storage keys with no metadata about which scope step the worker was on
-- when the photo was captured. The mobile foreman log (`fm-log`) tries to
-- group photos by scope step on the timeline, but with nothing to filter on
-- every photo dumped into a flat "All photos" bucket.
--
-- This migration adds a per-photo metadata row so each photo can carry a
-- nullable `scope_step_id` (uuid) plus a denormalized `scope_step_label` so
-- the timeline keeps rendering even after a brief step is renamed/deleted.
--
-- Back-compat:
--   * `daily_logs.photo_keys` stays as the legacy array. New uploads append
--     to both the array and the new table; reads can be served from either
--     side. We do NOT drop the column here — the mobile clients in the wild
--     still read it, and the foreman timeline now layers an "untagged"
--     bucket at the bottom for photos with `scope_step_id IS NULL`.
--   * Backfill copies every existing photo_keys element into a row with
--     `scope_step_id = NULL` and `captured_at = daily_logs.created_at`,
--     so the timeline shows historical photos in the untagged bucket
--     instead of disappearing.
--
-- The `scope_step_id` is intentionally NOT a foreign key. Project-brief
-- steps live in the brief's `steps jsonb` column rather than a discrete
-- table, so we can't foreign-key against it. Storing the id + label is
-- enough for the timeline join (the foreman screen filters in JS).

CREATE TABLE IF NOT EXISTS daily_log_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  daily_log_id uuid NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  -- Brief step this photo was tagged against. Nullable for photos taken
  -- without an active step (worker hadn't picked one yet) and for the
  -- backfilled rows from `daily_logs.photo_keys`.
  scope_step_id uuid,
  scope_step_label text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_log_photos_unique_key UNIQUE (daily_log_id, storage_key)
);

CREATE INDEX IF NOT EXISTS daily_log_photos_company_idx
  ON daily_log_photos (company_id);
CREATE INDEX IF NOT EXISTS daily_log_photos_log_idx
  ON daily_log_photos (daily_log_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS daily_log_photos_step_idx
  ON daily_log_photos (daily_log_id, scope_step_id)
  WHERE scope_step_id IS NOT NULL;

-- Backfill existing rows. Each photo_keys[] element becomes one
-- daily_log_photos row with scope_step_id NULL.
INSERT INTO daily_log_photos (company_id, daily_log_id, storage_key, captured_at, created_at)
SELECT dl.company_id, dl.id, key, dl.created_at, dl.created_at
FROM daily_logs dl, unnest(dl.photo_keys) AS key
WHERE dl.photo_keys IS NOT NULL
  AND array_length(dl.photo_keys, 1) IS NOT NULL
ON CONFLICT (daily_log_id, storage_key) DO NOTHING;
