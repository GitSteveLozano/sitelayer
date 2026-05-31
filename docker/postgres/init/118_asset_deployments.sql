-- 118_asset_deployments.sql
--
-- Asset deployment lifecycle — the "this physical asset is OUT on a job"
-- state the rentals cluster was missing. Distinct from `rentals` (the
-- contract/billing-ledger row, active→returned→closed) and `shipments`
-- (BOM-fulfillment pick/ship): an asset_deployment is a SINGLE physical
-- asset's out-and-back deployment, anchored to the dispatch
-- `inventory_movements` row, with a handoff person and a due-back date. A
-- single asset can be dispatched, returned, and re-dispatched many times —
-- each deployment is its own row (a new dispatch is a new row, never a
-- re-open of a terminal one).
--
-- Reducer: packages/workflows/src/asset-deployment.ts
-- States (status column):
--   staged → out → overdue → returning → returned        (returned terminal)
--                 \---------- EXTEND back to out
--   {out,overdue,returning} → written_off                (terminal)
-- Events: DISPATCH, CONFIRM_HANDOFF, MARK_OVERDUE (worker-only), EXTEND,
--         BEGIN_RETURN, COMPLETE_RETURN, WRITE_OFF.
--
-- Side effect: notify_handoff_assignment — DISPATCH with handoff_worker_id
-- enqueues one mutation_outbox row keyed
-- asset_deployment:notify_handoff:<deployment_id>.
--
-- Derived (NOT stored — computed in the route/selectors): days_out,
-- due_in_days, revenue_to_date_cents = days_out * day_rate_cents.
--
-- Expand/backfill/contract:
--   EXPAND   — additive table; `inventory_movements` stays the ledger,
--              this is the lifecycle overlay. The dispatch-movement POST
--              additionally inserts an asset_deployments row.
--   BACKFILL — synthesize `out` deployments from open deliver/transfer
--              movements that lack a matching later return for the same
--              item (best-effort; estimated_return_on left NULL → UI shows
--              "—"). Forward-only, idempotent (ON CONFLICT DO NOTHING via
--              the unique movement anchor).
--   CONTRACT — none initially.

CREATE TABLE IF NOT EXISTS asset_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL,
  -- Anchor to the dispatch movement. One deployment per dispatch movement.
  inventory_movement_id uuid,

  status text NOT NULL DEFAULT 'staged'
    CHECK (status IN ('staged', 'out', 'overdue', 'returning', 'returned', 'written_off')),
  state_version int NOT NULL DEFAULT 1,

  -- Context columns (snapshot fields stamped by transitions).
  project_id uuid,
  from_location_id uuid,
  handoff_worker_id uuid,
  handoff_confirmed_at timestamptz,
  handoff_confirmed_by text,
  dispatched_at timestamptz,
  estimated_return_on date,
  overdue_since timestamptz,
  return_started_at timestamptz,
  returned_at timestamptz,
  returned_by text,
  condition_grade text,
  day_rate_cents int,
  bill_mode text,
  extension_reason text,
  write_off_reason text,

  workflow_engine text NOT NULL DEFAULT 'postgres',
  workflow_run_id text,

  -- Tagged with the creating tier per the 002_tier_origin.sql precedent
  -- (nullable: current_setting(..., true) is NULL for psql/unset-GUC sessions).
  tier_origin text DEFAULT current_setting('app.tier', true),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, id),
  -- At most one deployment per dispatch movement (the anchor). Partial so
  -- rows without a movement anchor (manual deployments) don't collide.
  UNIQUE (company_id, inventory_movement_id),
  FOREIGN KEY (company_id, inventory_item_id) REFERENCES inventory_items(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, inventory_movement_id) REFERENCES inventory_movements(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, from_location_id) REFERENCES inventory_locations(company_id, id) ON DELETE SET NULL,
  FOREIGN KEY (company_id, handoff_worker_id) REFERENCES workers(company_id, id) ON DELETE SET NULL
);

-- Asset-detail screen reads the current open deployment for an asset.
CREATE INDEX IF NOT EXISTS asset_deployments_item_idx
  ON asset_deployments (company_id, inventory_item_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Overdue sweep + "what's out" board: out / overdue / returning are live.
CREATE INDEX IF NOT EXISTS asset_deployments_live_idx
  ON asset_deployments (company_id, status, estimated_return_on)
  WHERE deleted_at IS NULL AND status IN ('out', 'overdue', 'returning');

-- ---------------------------------------------------------------------------
-- BACKFILL: synthesize `out` deployments from open dispatch movements.
--
-- An open dispatch = a deliver/transfer movement for an item with no later
-- `return` movement for the same item. estimated_return_on left NULL.
-- Idempotent via the (company_id, inventory_movement_id) unique anchor +
-- ON CONFLICT DO NOTHING, so re-running the migration is a no-op.
-- ---------------------------------------------------------------------------
INSERT INTO asset_deployments (
  company_id, inventory_item_id, inventory_movement_id, status, state_version,
  project_id, from_location_id, handoff_worker_id, dispatched_at, tier_origin
)
SELECT
  m.company_id,
  m.inventory_item_id,
  m.id,
  'out',
  2, -- post-DISPATCH version (staged=1 → out=2)
  m.project_id,
  m.from_location_id,
  m.worker_id,
  COALESCE(m.scanned_at, m.created_at),
  m.origin_tier_fallback
FROM (
  SELECT
    im.*,
    current_setting('app.tier', true) AS origin_tier_fallback
  FROM inventory_movements im
  WHERE im.movement_type IN ('deliver', 'transfer')
) m
WHERE NOT EXISTS (
  SELECT 1
  FROM inventory_movements r
  WHERE r.company_id = m.company_id
    AND r.inventory_item_id = m.inventory_item_id
    AND r.movement_type = 'return'
    AND r.occurred_on >= m.occurred_on
)
ON CONFLICT (company_id, inventory_movement_id) DO NOTHING;
