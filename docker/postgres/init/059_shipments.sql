-- Shipments: estimate-to-fulfillment bridge.
--
-- A shipment carries an approved BOM (or an ad-hoc set of inventory_items)
-- from a yard branch to a project, gets confirmed in the field, and reverses
-- back through a return. State is workflow-shaped (state_version,
-- workflow_run_id) so the deterministic-reducer pattern in
-- packages/workflows applies without inventing new infra.

CREATE TABLE IF NOT EXISTS shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  bom_id uuid,                          -- nullable: ad-hoc shipments allowed
  source_branch_id uuid,                -- branch the stock is dispatched from
  destination_location_id uuid,         -- jobsite inventory_location
  direction text NOT NULL DEFAULT 'outbound', -- 'outbound' | 'return'
  status text NOT NULL DEFAULT 'planned',
  state_version int NOT NULL DEFAULT 1,
  scheduled_for date,
  shipped_at timestamptz,
  delivered_at timestamptz,
  confirmed_by text,
  driver text,
  ticket_number text,
  notes text,
  workflow_engine text NOT NULL DEFAULT 'postgres',
  workflow_run_id text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, bom_id) REFERENCES boms(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, source_branch_id) REFERENCES branches(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, destination_location_id) REFERENCES inventory_locations(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS shipments_project_idx
  ON shipments (company_id, project_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS shipments_status_idx
  ON shipments (company_id, status, scheduled_for)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS shipment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  -- Either inventory_item (owned) or catalog_part (sourced via cross-hire
  -- or purchase). Exactly one populated; CHECK enforces the xor.
  inventory_item_id uuid,
  catalog_part_id uuid,
  bom_line_id uuid,
  quantity_planned numeric(14,3) NOT NULL,
  quantity_shipped numeric(14,3) NOT NULL DEFAULT 0,
  quantity_delivered numeric(14,3) NOT NULL DEFAULT 0,
  quantity_returned numeric(14,3) NOT NULL DEFAULT 0,
  quantity_damaged numeric(14,3) NOT NULL DEFAULT 0,
  quantity_lost numeric(14,3) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, shipment_id) REFERENCES shipments(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, inventory_item_id) REFERENCES inventory_items(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, catalog_part_id) REFERENCES catalog_parts(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, bom_line_id) REFERENCES bom_lines(company_id, id) ON DELETE SET NULL,
  CHECK (
    (inventory_item_id IS NOT NULL AND catalog_part_id IS NULL)
    OR (inventory_item_id IS NULL AND catalog_part_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS shipment_lines_shipment_idx
  ON shipment_lines (company_id, shipment_id);

-- Workflow event log scoped to shipments; complements the global
-- workflow_event_log (020) for replay-driven debugging.
CREATE TABLE IF NOT EXISTS shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_before text,
  state_after text,
  state_version int NOT NULL,
  produced_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, shipment_id) REFERENCES shipments(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS shipment_events_shipment_idx
  ON shipment_events (company_id, shipment_id, created_at desc);
