-- 102_company_profile_and_working_hours.sql
--
-- Company profile scalars + working-hours persistence. The Desktop v2
-- Owner Settings panels (steve-desktop-3 · SETTINGS · COMPANY / WORKING
-- HOURS) were stubbed because `companies` only persisted name/slug
-- (bootstrap, read-only), `modules` / `portal_settings` (jsonb feature
-- packs, migrations 062), and `ot_service_item_code` (070). There was no
-- home for the legal entity / license / contact identity an owner edits,
-- nor for the standard work window that feeds crew scheduling + the
-- loaded-labor burden day counts.
--
-- This migration adds those columns directly on `companies` rather than a
-- side table: they are 1:1 with the company, read on the same surfaces as
-- the existing scalar settings, and the route already round-trips the
-- modules/portal_settings/ot_service_item_code columns from the same row
-- (apps/api/src/routes/companies.ts). A company-profile join table would
-- buy nothing here and add a write path.
--
-- Columns:
--   legal_name    text  — registered legal entity name (vs the display name).
--   license_no    text  — contractor license # surfaced on estimates/invoices.
--   address       text  — business mailing address.
--   phone         text  — main business phone.
--   website       text  — public website URL.
--   working_hours jsonb — standard work window + working days + holidays.
--
-- working_hours shape (validated + written by the API PUT route, NOT a DB
-- constraint — the route is the integrity gate, mirroring how modules /
-- portal_settings stay schema-light jsonb):
--   {
--     "days":      { "mon": true, ..., "sun": false },  -- weekday → enabled
--     "day_start": "07:00",                             -- HH:MM
--     "day_end":   "16:00",                             -- HH:MM
--     "ot_rule":   "8h" | "10h" | "40w",                -- OT threshold
--     "holidays":  [ { "name": "...", "date": "..." } ] -- excluded days
--   }
--
-- working_hours is NULLABLE with no default: a company that has never
-- saved working hours reads NULL, and the UI falls back to its sensible
-- defaults (Mon–Fri, 07:00–16:00, OT after 8h). The scalar text columns
-- are likewise nullable (no default) — an owner fills them in over time.
--
-- companies is already RLS-enabled (migration 085 ENABLE/FORCE + the
-- company_isolation policy bodies from 066), so adding columns needs NO
-- new policy — the existing per-row policy already gates every read/write
-- on app_current_company_id().
--
-- Additive / forward-only / idempotent (ADD COLUMN IF NOT EXISTS): safe to
-- re-run, never edits an applied migration (002_tier_origin.sql precedent).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS license_no text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS working_hours jsonb;

COMMENT ON COLUMN companies.legal_name IS
  'Registered legal entity name (vs companies.name display name). '
  'Edited via PATCH /api/companies/:id; surfaced on estimates/invoices.';
COMMENT ON COLUMN companies.license_no IS
  'Contractor license number, surfaced on estimates/invoices. '
  'Edited via PATCH /api/companies/:id.';
COMMENT ON COLUMN companies.address IS
  'Business mailing address. Edited via PATCH /api/companies/:id.';
COMMENT ON COLUMN companies.phone IS
  'Main business phone. Edited via PATCH /api/companies/:id.';
COMMENT ON COLUMN companies.website IS
  'Public website URL. Edited via PATCH /api/companies/:id.';
COMMENT ON COLUMN companies.working_hours IS
  'Standard work window + working days + holidays. NULL = company has not '
  'configured working hours (UI falls back to Mon-Fri 07:00-16:00, OT 8h). '
  'Shape { days: Record<weekday,bool>, day_start, day_end, ot_rule, '
  'holidays: [{name,date}] } validated by apps/api/src/routes/companies.ts '
  'PUT /api/companies/:id/working-hours (route is the integrity gate, no DB '
  'constraint — mirrors modules / portal_settings).';
