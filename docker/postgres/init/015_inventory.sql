-- Inventory catalog for pooled rental stock tracking
-- Extends the existing rentals system with a master item catalog

CREATE TABLE inventory_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  part_number      text NOT NULL,
  name             text NOT NULL,
  description      text,
  category         text,
  unit             text DEFAULT 'ea',
  rate_25day       numeric(12,2) NOT NULL DEFAULT 0,
  rate_daily       numeric(12,2) DEFAULT 0,
  rate_weekly      numeric(12,2) DEFAULT 0,
  replacement_cost numeric(12,2) DEFAULT 0,
  total_stock      int DEFAULT 0,
  is_active        boolean DEFAULT true,
  metadata         jsonb DEFAULT '{}'::jsonb,
  version          int DEFAULT 1,
  deleted_at       timestamptz,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  UNIQUE (company_id, part_number)
);

CREATE INDEX idx_inventory_company ON inventory_items(company_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_inventory_category ON inventory_items(company_id, category) WHERE deleted_at IS NULL;

-- Add optional inventory_item_id FK to existing rentals table
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS inventory_item_id uuid REFERENCES inventory_items(id);
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS qty int DEFAULT 1;

-- Availability view: total_stock minus qty currently on active rentals
CREATE OR REPLACE FUNCTION get_inventory_availability(p_company_id uuid)
RETURNS TABLE(
  item_id uuid,
  part_number text,
  name text,
  category text,
  total_stock int,
  qty_on_rent bigint,
  qty_available bigint
) AS $$
  SELECT
    i.id,
    i.part_number,
    i.name,
    i.category,
    i.total_stock,
    COALESCE(SUM(CASE WHEN r.status = 'active' AND r.deleted_at IS NULL THEN r.qty ELSE 0 END), 0) AS qty_on_rent,
    i.total_stock - COALESCE(SUM(CASE WHEN r.status = 'active' AND r.deleted_at IS NULL THEN r.qty ELSE 0 END), 0) AS qty_available
  FROM inventory_items i
  LEFT JOIN rentals r ON r.inventory_item_id = i.id AND r.company_id = i.company_id
  WHERE i.company_id = p_company_id AND i.is_active = true AND i.deleted_at IS NULL
  GROUP BY i.id, i.part_number, i.name, i.category, i.total_stock
$$ LANGUAGE sql SECURITY DEFINER;
