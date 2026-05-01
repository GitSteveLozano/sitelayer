-- 035_takeoff_measurement_types.sql
--
-- Linear + count tools (Phase 3D). Geometry normalizers in
-- @sitelayer/domain already cover lineal + volume; this migration
-- formalises a `geometry_kind` discriminator on takeoff_measurements
-- so the read path can distinguish polygons / linear / count and the
-- UI can render the right tool.
--
-- Convention:
--   - 'polygon' (default; matches existing rows)
--   - 'lineal'  segment-by-segment line measurement (caulk, flashing)
--   - 'count'   discrete marker placement (vents, bollards, fixtures)
--   - 'volume'  3-axis box (already supported by domain helpers)
--
-- Backfill: all existing rows are polygons.

ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS geometry_kind text NOT NULL DEFAULT 'polygon',
  ADD CONSTRAINT takeoff_measurements_geometry_kind_chk
    CHECK (geometry_kind IN ('polygon', 'lineal', 'count', 'volume'));

CREATE INDEX IF NOT EXISTS takeoff_measurements_kind_idx
  ON takeoff_measurements (company_id, geometry_kind)
  WHERE geometry_kind <> 'polygon';
