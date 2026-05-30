-- 108_takeoff_measurement_deduction.sql
--
-- Cutout / deduct-area takeoff (PlanSwift Phase 1). A polygon takeoff
-- measurement can be flagged as a deduction — e.g. a window or door opening cut
-- out of a wall area. The stored `quantity` stays the POSITIVE polygon area
-- (the server recomputes it from geometry and rejects non-positive values, see
-- apps/api/src/routes/takeoff-write.ts); this boolean carries the SIGN so the
-- estimate derivation subtracts the opening from the net quantity/amount for
-- its service item instead of adding it.
--
-- Forward, additive, idempotent. Defaulted false so every existing row behaves
-- exactly as before and old code that never reads the column is unaffected
-- (expand step — new code tolerates the old shape, where the column reads as
-- false for legacy rows).

ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS is_deduction boolean NOT NULL DEFAULT false;
