-- Branch hierarchy + cross-hire (re-rent) foundation.
--
-- Adds a branches table so inventory_locations can roll up across
-- branch → yard → staging → jobsite, and rental_vendors + external_rentals
-- so cross-hire stock participates in availability without polluting the
-- owned inventory_items ledger.
--
-- All additive. inventory_locations.branch_id is nullable; existing rows
-- backfill to the per-company default branch.

CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  address text,
  is_default boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS branches_one_default_idx
  ON branches (company_id)
  WHERE is_default = true AND deleted_at IS NULL;

-- Seed a default branch per company so the FK on inventory_locations has
-- something to point at after backfill.
INSERT INTO branches (company_id, code, name, is_default)
SELECT id, 'main', 'Main Branch', true
FROM companies
ON CONFLICT DO NOTHING;

ALTER TABLE inventory_locations
  ADD COLUMN IF NOT EXISTS branch_id uuid;

-- Backfill existing rows to their company's default branch.
UPDATE inventory_locations l
SET branch_id = b.id
FROM branches b
WHERE l.branch_id IS NULL
  AND b.company_id = l.company_id
  AND b.is_default = true
  AND b.deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_locations_branch_fk'
  ) THEN
    ALTER TABLE inventory_locations
      ADD CONSTRAINT inventory_locations_branch_fk
      FOREIGN KEY (company_id, branch_id)
      REFERENCES branches(company_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS inventory_locations_branch_idx
  ON inventory_locations (company_id, branch_id)
  WHERE deleted_at IS NULL;

-- Rental vendors (suppliers we re-rent from).
CREATE TABLE IF NOT EXISTS rental_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  contact_email text,
  contact_phone text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, code)
);

-- Cross-hire: stock we rent FROM a vendor to fulfill a project, distinct
-- from owned inventory. Tracks vendor cost; the project-side rate stays on
-- job_rental_lines so customers see one bill.
CREATE TABLE IF NOT EXISTS external_rentals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  project_id uuid,
  branch_id uuid,
  quantity numeric(12,2) NOT NULL,
  returned_quantity numeric(12,2) NOT NULL DEFAULT 0,
  vendor_rate numeric(12,2) NOT NULL DEFAULT 0,
  rate_unit text NOT NULL DEFAULT 'cycle',
  on_rent_date date NOT NULL,
  off_rent_date date,
  vendor_po text,
  status text NOT NULL DEFAULT 'active',
  notes text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, vendor_id) REFERENCES rental_vendors(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, inventory_item_id) REFERENCES inventory_items(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS external_rentals_active_idx
  ON external_rentals (company_id, inventory_item_id, status)
  WHERE deleted_at IS NULL AND off_rent_date IS NULL;

CREATE INDEX IF NOT EXISTS external_rentals_project_idx
  ON external_rentals (company_id, project_id)
  WHERE deleted_at IS NULL;

-- Availability rollup by (item, branch). The single-row-per-item function
-- in 019 stays for callers that don't care about branches. This one
-- additionally exposes external (cross-hire) stock currently on rent so
-- the operations view can decide whether to return vendor inventory.
DROP FUNCTION IF EXISTS get_inventory_availability_by_branch(uuid);

CREATE FUNCTION get_inventory_availability_by_branch(company_uuid uuid)
RETURNS TABLE (
  inventory_item_id uuid,
  branch_id uuid,
  total_stock_quantity numeric,
  yard_quantity numeric,
  on_rent_quantity numeric,
  external_on_rent_quantity numeric,
  available_quantity numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH movement_balances AS (
    SELECT
      m.inventory_item_id,
      COALESCE(tl.branch_id, fl.branch_id) AS branch_id,
      COALESCE(SUM(
        CASE
          WHEN m.to_location_id IS NOT NULL
            AND COALESCE(tl.location_type, '') NOT IN ('lost', 'damaged') THEN m.quantity
          ELSE 0
        END
        -
        CASE
          WHEN m.from_location_id IS NOT NULL
            AND COALESCE(fl.location_type, '') NOT IN ('lost', 'damaged') THEN m.quantity
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
    GROUP BY m.inventory_item_id, COALESCE(tl.branch_id, fl.branch_id)
  ),
  active_rentals AS (
    SELECT
      l.inventory_item_id,
      COALESCE(SUM(l.quantity), 0)::numeric(12,2) AS on_rent_quantity
    FROM job_rental_lines l
    JOIN job_rental_contracts c
      ON c.company_id = l.company_id AND c.id = l.contract_id AND c.deleted_at IS NULL
    WHERE l.company_id = company_uuid
      AND l.deleted_at IS NULL
      AND l.off_rent_date IS NULL
      AND l.status = 'active'
    GROUP BY l.inventory_item_id
  ),
  external_active AS (
    SELECT
      e.inventory_item_id,
      e.branch_id,
      COALESCE(SUM(e.quantity - e.returned_quantity), 0)::numeric(12,2) AS external_on_rent_quantity
    FROM external_rentals e
    WHERE e.company_id = company_uuid
      AND e.deleted_at IS NULL
      AND e.off_rent_date IS NULL
      AND e.status = 'active'
    GROUP BY e.inventory_item_id, e.branch_id
  )
  SELECT
    i.id AS inventory_item_id,
    b.branch_id,
    COALESCE(b.total_stock_quantity, 0)::numeric(12,2) AS total_stock_quantity,
    COALESCE(b.yard_quantity, 0)::numeric(12,2) AS yard_quantity,
    COALESCE(a.on_rent_quantity, 0)::numeric(12,2) AS on_rent_quantity,
    COALESCE(ex.external_on_rent_quantity, 0)::numeric(12,2) AS external_on_rent_quantity,
    GREATEST(
      COALESCE(b.total_stock_quantity, 0)
      + COALESCE(ex.external_on_rent_quantity, 0)
      - COALESCE(a.on_rent_quantity, 0),
      0
    )::numeric(12,2) AS available_quantity
  FROM inventory_items i
  LEFT JOIN movement_balances b ON b.inventory_item_id = i.id
  LEFT JOIN active_rentals a ON a.inventory_item_id = i.id
  LEFT JOIN external_active ex
    ON ex.inventory_item_id = i.id
   AND ex.branch_id IS NOT DISTINCT FROM b.branch_id
  WHERE i.company_id = company_uuid
    AND i.deleted_at IS NULL;
$$;
