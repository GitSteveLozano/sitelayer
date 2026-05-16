-- 070_labor_ot_service_item_code.sql
--
-- Per-company QBO overtime service-item mapping for the labor-payroll
-- TimeActivity push (apps/worker/src/labor-payroll-push.ts).
--
-- Why this column exists:
--   QBO's TimeActivity entity has no first-class "HoursType=OT" field.
--   Every Intuit Payroll install codes overtime as a *separate service
--   item* — e.g. "Regular Labor" and "Overtime Labor" — and the
--   ItemRef on each TimeActivity is what tells QBO Payroll how to pay
--   the hours out. Sitelayer already splits each labor_entry into
--   straight + OT via packages/domain/src/index.ts:splitStraightAndOt
--   for the Gusto/ADP CSV exports; this column extends the same split
--   to the QBO push.
--
-- Why nullable, no default:
--   Companies that don't run OT through QBO (single-item payroll,
--   non-prevailing-wage trades) MUST be able to opt out. When NULL,
--   the worker falls back to today's single-TimeActivity behavior:
--   one POST per labor_entry with the full hours value against the
--   existing service_item_code ItemRef — no OT split is emitted to
--   Intuit. Setting this column is the opt-in for the OT-typed push.
--
-- The value is a service_items.code (NOT a uuid). The API PATCH
-- validates that the code exists in service_items for the company
-- before accepting the write. The worker re-resolves the QBO Item
-- external_id from integration_mappings (entity_type='service_item',
-- local_ref=<code>) at push time so admins can re-map a code to a
-- different QBO Item without touching this column.
--
-- No foreign key on service_items.(company_id, code) because
-- service_items rows can be soft-deleted (deleted_at) and we don't
-- want a delete cascade to silently strip the OT mapping. The PATCH
-- route is the integrity gate.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS ot_service_item_code text;

COMMENT ON COLUMN companies.ot_service_item_code IS
  'Per-company service_items.code used for QBO TimeActivity push OT split. '
  'NULL = no OT split (worker posts one TimeActivity per labor_entry against '
  'the existing service_item_code). Set = worker posts two TimeActivities '
  'when splitStraightAndOt produces ot_hours > 0: one straight against the '
  'entry''s code, one OT against this code. Validated by '
  'apps/api/src/routes/companies.ts PATCH /api/companies/:id/settings.';
