-- Backfill a default Yard location per company so the inventory movement
-- UI has something to deliver from / return to out of the box.
--
-- The seed in apps/api/src/onboarding.ts handles this for new companies,
-- but companies that were created before that change still need it.
-- Idempotent — only inserts when the company doesn't already have a
-- default location (matching the unique partial index
-- inventory_locations_one_default_idx).

INSERT INTO inventory_locations (company_id, name, location_type, is_default)
SELECT c.id, 'Yard', 'yard', true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_locations
  WHERE company_id = c.id AND is_default = true AND deleted_at IS NULL
);
