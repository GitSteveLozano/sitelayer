-- Rentals / inventory replacement foundation.
--
-- The legacy `rentals` table is a lightweight proof-of-concept ledger. These
-- tables model the replacement workflow around inventory, job rental contracts,
-- delivery/return movements, and 25-day billing runs.

CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  description text NOT NULL,
  category text NOT NULL DEFAULT 'scaffold',
  unit text NOT NULL DEFAULT 'ea',
  default_rental_rate numeric(12,2) NOT NULL DEFAULT 0,
  replacement_value numeric(12,2),
  tracking_mode text NOT NULL DEFAULT 'quantity',
  active boolean NOT NULL DEFAULT true,
  notes text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  location_type text NOT NULL DEFAULT 'yard',
  is_default boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_one_default_idx
  ON inventory_locations (company_id)
  WHERE is_default = true AND deleted_at IS NULL;

INSERT INTO inventory_locations (company_id, name, location_type, is_default)
SELECT id, 'Main Yard', 'yard', true
FROM companies
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL,
  from_location_id uuid,
  to_location_id uuid,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  movement_type text NOT NULL,
  quantity numeric(12,2) NOT NULL,
  occurred_on date NOT NULL DEFAULT now()::date,
  ticket_number text,
  notes text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, inventory_item_id) REFERENCES inventory_items(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, from_location_id) REFERENCES inventory_locations(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, to_location_id) REFERENCES inventory_locations(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS inventory_movements_item_idx
  ON inventory_movements (company_id, inventory_item_id, occurred_on desc);

CREATE INDEX IF NOT EXISTS inventory_movements_project_idx
  ON inventory_movements (company_id, project_id, occurred_on desc);

CREATE TABLE IF NOT EXISTS job_rental_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  billing_cycle_days int NOT NULL DEFAULT 25,
  billing_mode text NOT NULL DEFAULT 'arrears',
  billing_start_date date NOT NULL,
  last_billed_through date,
  next_billing_date date NOT NULL,
  status text NOT NULL DEFAULT 'active',
  notes text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS job_rental_contracts_project_active_idx
  ON job_rental_contracts (company_id, project_id)
  WHERE deleted_at IS NULL AND status IN ('draft', 'active', 'paused');

CREATE TABLE IF NOT EXISTS job_rental_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(12,2) NOT NULL,
  agreed_rate numeric(12,2) NOT NULL DEFAULT 0,
  rate_unit text NOT NULL DEFAULT 'cycle',
  on_rent_date date NOT NULL,
  off_rent_date date,
  last_billed_through date,
  billable boolean NOT NULL DEFAULT true,
  taxable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  notes text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contract_id) REFERENCES job_rental_contracts(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, inventory_item_id) REFERENCES inventory_items(company_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS job_rental_lines_contract_idx
  ON job_rental_lines (company_id, contract_id, status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS rental_billing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  project_id uuid NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'generated',
  state_version int NOT NULL DEFAULT 1,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  qbo_invoice_id text,
  approved_at timestamptz,
  approved_by text,
  posted_at timestamptz,
  failed_at timestamptz,
  error text,
  workflow_engine text NOT NULL DEFAULT 'postgres',
  workflow_run_id text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, contract_id, period_start, period_end),
  FOREIGN KEY (company_id, contract_id) REFERENCES job_rental_contracts(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rental_billing_run_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  billing_run_id uuid NOT NULL,
  contract_line_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(12,2) NOT NULL,
  agreed_rate numeric(12,2) NOT NULL DEFAULT 0,
  rate_unit text NOT NULL,
  billable_days int NOT NULL DEFAULT 0,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  taxable boolean NOT NULL DEFAULT true,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, billing_run_id) REFERENCES rental_billing_runs(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, contract_line_id) REFERENCES job_rental_lines(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, inventory_item_id) REFERENCES inventory_items(company_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS rental_billing_run_lines_run_idx
  ON rental_billing_run_lines (company_id, billing_run_id);
