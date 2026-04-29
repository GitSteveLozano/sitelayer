-- Postgres function get_inventory_availability(company_uuid)
--
-- Returns one row per inventory item with on-rent counts derived from
-- active job_rental_lines. Mirrors the design in the original PR #101
-- (Steve's first inventory pass) so the API can satisfy callers that
-- expect a function rather than an HTTP-side aggregation. The
-- application-side endpoint /api/inventory/items/availability already
-- exists; this function is a parity addition for ad-hoc SQL + future
-- materialized-view caching.
--
-- Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION get_inventory_availability(company_uuid uuid)
RETURNS TABLE (
  inventory_item_id uuid,
  on_rent_quantity numeric,
  on_rent_lines int,
  on_rent_projects int
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    l.inventory_item_id,
    COALESCE(SUM(l.quantity), 0)::numeric(12,2) AS on_rent_quantity,
    COUNT(*)::int AS on_rent_lines,
    COUNT(DISTINCT c.project_id)::int AS on_rent_projects
  FROM job_rental_lines l
  JOIN job_rental_contracts c
    ON c.company_id = l.company_id AND c.id = l.contract_id AND c.deleted_at IS NULL
  WHERE l.company_id = company_uuid
    AND l.deleted_at IS NULL
    AND l.off_rent_date IS NULL
    AND l.status = 'active'
  GROUP BY l.inventory_item_id;
$$;
