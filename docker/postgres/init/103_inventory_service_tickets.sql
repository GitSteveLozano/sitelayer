-- 103_inventory_service_tickets.sql
--
-- Inventory service tickets — a first-class maintenance/service log for a
-- rental inventory item. The owner rentals screens (owner-rentals-asset,
-- owner-rentals-utilization) previously had only a derived "service log"
-- built from `repair` inventory_movements: a movement could flag an asset
-- as out-for-service but there was no way to track or *close out* the
-- service work (the "+ LOG" button was disabled). This table gives that
-- service work its own lifecycle so an asset can be flagged, worked, and
-- marked serviced.
--
-- States (linear; managed in apps/api/src/routes/inventory-service-tickets.ts):
--   open → in_service → done
--
-- `open` is the initial flag, `in_service` is active maintenance, `done`
-- is terminal (completed_at stamped). The route enforces the forward-only
-- progression; this CHECK only constrains the value set.
--
-- company_id is the tenant root (RLS scope + cascade on company delete);
-- inventory_item_id ties the ticket to the catalog row. Indexed on
-- (company_id, inventory_item_id) for the per-asset history drill-in and on
-- (company_id, status) for the company-wide open/in-service queue.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS before
-- CREATE; ENABLE/FORCE are safe to re-run), additive, forward-only — no
-- data change. Mirrors 097_change_orders.sql (table) + 101_v2_rls.sql (RLS).

CREATE TABLE IF NOT EXISTS inventory_service_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),

  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_service', 'done')),

  -- Stamped on open / completion. opened_at defaults at insert; completed_at
  -- is populated only when the ticket transitions to `done`.
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by text,                 -- Clerk user id of whoever flagged it
  completed_at timestamptz,

  notes text,

  -- Tagged with the creating tier per the 002_tier_origin.sql precedent
  -- (nullable: current_setting(..., true) is NULL for psql/unset-GUC sessions).
  tier_origin text DEFAULT current_setting('app.tier', true),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

-- Per-asset service history drill-in (owner-rentals-asset). Newest first.
CREATE INDEX IF NOT EXISTS inventory_service_tickets_item_idx
  ON inventory_service_tickets (company_id, inventory_item_id);

-- Company-wide open / in-service queue (owner-rentals-utilization service log).
CREATE INDEX IF NOT EXISTS inventory_service_tickets_status_idx
  ON inventory_service_tickets (company_id, status);

-- Row-level security: same belt-and-suspenders company_isolation policy the
-- rest of the company-scoped domain has (body identical to migration 066 /
-- 101 — stays permissive when app.company_id is unset so debug/replay/webhook
-- paths keep working). FORCE is required on DO managed PG where the app runs
-- as the table-owner `sitelayer` role (see 085).
DO $$
BEGIN
  IF to_regclass('inventory_service_tickets') IS NULL THEN
    RAISE NOTICE 'skip RLS for missing table inventory_service_tickets';
  ELSE
    DROP POLICY IF EXISTS company_isolation ON inventory_service_tickets;
    CREATE POLICY company_isolation ON inventory_service_tickets
      FOR ALL
      USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
      WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());
    ALTER TABLE inventory_service_tickets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inventory_service_tickets FORCE ROW LEVEL SECURITY;
  END IF;
END $$;
