-- Module packaging + bookkeeper role.
--
-- companies.modules is a JSONB feature-pack so a general electrical
-- contractor doesn't have to see scaffold-rental or BOM screens, and a
-- scaffold-rental tenant doesn't have to see trade-specific takeoff
-- helpers. Defaults are conservative: takeoff + estimating + time tracking
-- are on; scaffold-specific surfaces are off until a tenant turns them on.
--
-- The 'bookkeeper' role is added as an app-recognized value of
-- company_memberships.role. The column already has no CHECK constraint, so
-- this migration is documentary — but the comment makes the intent
-- mechanical: API permission gates must read it.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS modules jsonb NOT NULL DEFAULT '{
    "takeoff": true,
    "estimating": true,
    "field_labor": true,
    "rental_ops": true,
    "scaffold_design": false,
    "scaffold_bom": false,
    "scaffold_inspections": false,
    "customer_portal": true,
    "payroll_exports": true
  }'::jsonb;

COMMENT ON COLUMN company_memberships.role IS
  'App-recognized values: admin | foreman | office | member | bookkeeper. '
  'No DB constraint — permission gates in apps/web/src/lib/permissions.ts '
  'and the API requireRole() helper are the enforcement points.';

-- For the customer portal: a customer principal isn't in company_memberships
-- (we don't put external users in Clerk org), but we need to surface what
-- the portal is allowed to see per company.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS portal_settings jsonb NOT NULL DEFAULT '{
    "show_estimates": true,
    "show_invoices": false,
    "show_photos": true,
    "show_inspections": false
  }'::jsonb;
