-- Expand inventory availability to include movement-ledger stock totals.
--
-- Existing callers still receive on-rent rollups. New callers also receive:
--   total_stock_quantity: net quantity across usable locations
--   available_quantity: total stock minus active rentals, clamped at zero
--   yard_quantity: net quantity physically in yard locations

DROP FUNCTION IF EXISTS get_inventory_availability(uuid);

CREATE FUNCTION get_inventory_availability(company_uuid uuid)
RETURNS TABLE (
  inventory_item_id uuid,
  total_stock_quantity numeric,
  available_quantity numeric,
  yard_quantity numeric,
  on_rent_quantity numeric,
  on_rent_lines int,
  on_rent_projects int
)
LANGUAGE sql
STABLE
AS $$
  WITH active_rentals AS (
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
    GROUP BY l.inventory_item_id
  ),
  movement_balances AS (
    SELECT
      m.inventory_item_id,
      COALESCE(SUM(
        CASE
          WHEN m.to_location_id IS NOT NULL AND COALESCE(tl.location_type, '') NOT IN ('lost', 'damaged') THEN m.quantity
          ELSE 0
        END
        -
        CASE
          WHEN m.from_location_id IS NOT NULL AND COALESCE(fl.location_type, '') NOT IN ('lost', 'damaged') THEN m.quantity
          ELSE 0
        END
      ), 0)::numeric(12,2) AS total_stock_quantity,
      COALESCE(SUM(
        CASE WHEN m.to_location_id IS NOT NULL AND tl.location_type = 'yard' THEN m.quantity ELSE 0 END
        -
        CASE WHEN m.from_location_id IS NOT NULL AND fl.location_type = 'yard' THEN m.quantity ELSE 0 END
      ), 0)::numeric(12,2) AS yard_quantity
    FROM inventory_movements m
    LEFT JOIN inventory_locations fl ON fl.company_id = m.company_id AND fl.id = m.from_location_id
    LEFT JOIN inventory_locations tl ON tl.company_id = m.company_id AND tl.id = m.to_location_id
    WHERE m.company_id = company_uuid
    GROUP BY m.inventory_item_id
  )
  SELECT
    i.id AS inventory_item_id,
    COALESCE(b.total_stock_quantity, 0)::numeric(12,2) AS total_stock_quantity,
    GREATEST(COALESCE(b.total_stock_quantity, 0) - COALESCE(a.on_rent_quantity, 0), 0)::numeric(12,2)
      AS available_quantity,
    COALESCE(b.yard_quantity, 0)::numeric(12,2) AS yard_quantity,
    COALESCE(a.on_rent_quantity, 0)::numeric(12,2) AS on_rent_quantity,
    COALESCE(a.on_rent_lines, 0)::int AS on_rent_lines,
    COALESCE(a.on_rent_projects, 0)::int AS on_rent_projects
  FROM inventory_items i
  LEFT JOIN active_rentals a ON a.inventory_item_id = i.id
  LEFT JOIN movement_balances b ON b.inventory_item_id = i.id
  WHERE i.company_id = company_uuid
    AND i.deleted_at IS NULL
  ORDER BY i.code ASC;
$$;
