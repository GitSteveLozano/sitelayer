-- 012_takeoff_measurements_updated_at.sql
--
-- Add `updated_at` to `takeoff_measurements` so the LWW conflict path on the
-- PATCH endpoint has a server-side timestamp to compare against an inbound
-- `If-Unmodified-Since` header. We backfill from `created_at` so existing
-- rows have a deterministic baseline. Application writers update this column
-- explicitly on update.
--
-- See apps/api/src/server.ts (PATCH /api/takeoff/measurements/:id) and
-- apps/web/src/api.ts (replayOfflineMutations LWW conflict toast).

ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE takeoff_measurements
SET updated_at = created_at
WHERE updated_at IS NULL OR updated_at < created_at;

CREATE INDEX IF NOT EXISTS takeoff_measurements_updated_at_idx
  ON takeoff_measurements (company_id, updated_at DESC);
