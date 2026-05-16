-- Damage / loss billing path.
--
-- When a shipment return reconciles short or a unit is flagged damaged at
-- intake, we record a damage_charge row. The QBO push is just a mutation_outbox
-- enqueue keyed on the charge id, so retries are idempotent and the
-- existing worker path handles delivery. Surfaced on project closeout
-- (project_lifecycle workflow) and unbilled-exceptions reports.

CREATE TABLE IF NOT EXISTS damage_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  shipment_id uuid,
  shipment_line_id uuid,
  inventory_item_id uuid,
  catalog_part_id uuid,
  kind text NOT NULL CHECK (kind IN ('damage', 'loss', 'late_return', 'cleanup')),
  quantity numeric(14,3) NOT NULL DEFAULT 0,
  unit_amount numeric(12,2) NOT NULL DEFAULT 0,
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  description text NOT NULL,
  taxable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'open', -- 'open' | 'invoiced' | 'waived' | 'disputed'
  state_version int NOT NULL DEFAULT 1,
  qbo_invoice_id text,
  invoiced_at timestamptz,
  invoiced_by text,
  waived_at timestamptz,
  waived_by text,
  waive_reason text,
  notes text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, shipment_id) REFERENCES shipments(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, shipment_line_id) REFERENCES shipment_lines(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, inventory_item_id) REFERENCES inventory_items(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, catalog_part_id) REFERENCES catalog_parts(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS damage_charges_project_idx
  ON damage_charges (company_id, project_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS damage_charges_open_idx
  ON damage_charges (company_id, created_at desc)
  WHERE deleted_at IS NULL AND status = 'open';
