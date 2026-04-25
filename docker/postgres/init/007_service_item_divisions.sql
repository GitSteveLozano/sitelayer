-- 007_service_item_divisions.sql
--
-- Service items can be performed by more than one division (WhatsApp:227-229).
-- Today `service_items` are global per company and `projects.division_code`
-- is the only division signal — so when a job spans divisions, per-division
-- profitability rollups are wrong. This migration adds:
--
--   * `service_item_divisions` junction table (company_id, code, division_code)
--     letting a service item be valid for N divisions.
--   * `labor_entries.division_code` so field-recorded hours can be charged
--     against a specific division (nullable; NULL falls back to the project's
--     `division_code`, preserving today's behavior).
--   * `estimate_lines.division_code` so an estimate line that came from a
--     takeoff measurement with a division_code can carry that division into
--     rollups (nullable; same fallback).
--
-- All three changes are additive; existing writers that do not supply
-- `division_code` keep working.

CREATE TABLE IF NOT EXISTS service_item_divisions (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  service_item_code text NOT NULL,
  division_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, service_item_code, division_code),
  FOREIGN KEY (company_id, service_item_code)
    REFERENCES service_items (company_id, code)
    ON DELETE CASCADE,
  FOREIGN KEY (company_id, division_code)
    REFERENCES divisions (company_id, code)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS service_item_divisions_by_division_idx
  ON service_item_divisions (company_id, division_code);

ALTER TABLE labor_entries
  ADD COLUMN IF NOT EXISTS division_code text;

CREATE INDEX IF NOT EXISTS labor_entries_division_idx
  ON labor_entries (company_id, division_code)
  WHERE division_code IS NOT NULL;

ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS division_code text;

CREATE INDEX IF NOT EXISTS estimate_lines_division_idx
  ON estimate_lines (company_id, division_code)
  WHERE division_code IS NOT NULL;
