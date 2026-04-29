-- estimate_pushes — workflow row backing the estimate-push QBO flow.
--
-- Mirrors rental_billing_runs in shape so the same workflow tooling
-- (state_version optimistic checks, workflow_event_log replay, future
-- Temporal handoff via workflow_engine) applies without forks.
--
-- Each row represents one attempt to push a project's current estimate
-- to QuickBooks. The estimate snapshot is captured into snapshot_lines
-- at row creation time so the push remains deterministic even if the
-- live estimate_lines for the project change between drafted and
-- posted.

CREATE TABLE IF NOT EXISTS estimate_pushes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'drafted',
  state_version int NOT NULL DEFAULT 1,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  qbo_estimate_id text,
  reviewed_at timestamptz,
  reviewed_by text,
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
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS estimate_pushes_project_idx
  ON estimate_pushes (company_id, project_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS estimate_pushes_status_idx
  ON estimate_pushes (company_id, status)
  WHERE deleted_at IS NULL;

-- Captured estimate-line snapshot. Decouples the push from later edits
-- to live estimate_lines: review/approve/post all see the same numbers
-- the user reviewed.
CREATE TABLE IF NOT EXISTS estimate_push_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  estimate_push_id uuid NOT NULL,
  source_estimate_line_id uuid,
  description text NOT NULL,
  service_item_code text,
  division_code text,
  quantity numeric(12,4) NOT NULL DEFAULT 0,
  unit_price numeric(12,4) NOT NULL DEFAULT 0,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  taxable boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, estimate_push_id)
    REFERENCES estimate_pushes(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS estimate_push_lines_push_idx
  ON estimate_push_lines (company_id, estimate_push_id, sort_order);
