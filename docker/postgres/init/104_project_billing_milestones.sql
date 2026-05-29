-- 104_project_billing_milestones.sql
--
-- Project billing milestones — a per-project billing SCHEDULE layer
-- (deposit / progress / final) that tracks invoice milestones with a MANUAL
-- paid/invoiced/not-yet status. This is the persistent backing for the
-- deposit/progress/final ladder that invoice-quick.tsx / invoice-sent.tsx
-- previously rendered as a LABELED STUB (derived purely from
-- projects.bid_total with no persistence).
--
-- Surfaced by Steve's v2 mobile invoice flow (V2InvoiceCreate / V2InvoiceSent).
-- It is an ADDITIVE tracking layer that lives ALONGSIDE the estimate_push
-- workflow (097..101 + routes/estimate-pushes.ts): estimate_push owns the
-- actual QuickBooks estimate/invoice push; a milestone records what the
-- operator intends to bill for each phase and whether that phase has been
-- invoiced / paid. `estimate_push_id` is an OPTIONAL soft link to the push a
-- milestone was billed through.
--
-- IMPORTANT — status is set MANUALLY. There is no QBO payment-webhook
-- auto-detection: "mark paid" / "mark invoiced" are deliberate operator
-- actions via PATCH /api/billing-milestones/:id (see
-- apps/api/src/routes/project-billing-milestones.ts). Auto-detecting payment
-- from QBO is intentionally OUT OF SCOPE.
--
-- Statuses:
--   not_yet  → invoiced → paid    (forward intent; the route allows any set)
--
-- This migration follows the 097_change_orders.sql table pattern (per-project,
-- company-scoped, tier_origin tag) and the 101_v2_rls.sql RLS pattern
-- (company_isolation permissive policy + ENABLE + FORCE).
--
-- Additive, idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS), forward-only.
-- No data change to any existing table.

CREATE TABLE IF NOT EXISTS project_billing_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Human-friendly milestone label, e.g. "Deposit · 30%" / "Progress" / "Final".
  label text NOT NULL,
  -- Optional percentage of contract value this milestone represents (0-100ish).
  -- Nullable: a milestone can carry a flat amount with no percentage.
  pct numeric(6, 2),
  -- Optional dollar amount to bill for this milestone.
  amount numeric(14, 2),
  -- Display / billing order within the project's ladder (deposit=0, progress=1, ...).
  sort_order int NOT NULL DEFAULT 0,

  -- Manual billing status. NOT a derived/auto-detected value (see header).
  status text NOT NULL DEFAULT 'not_yet'
    CHECK (status IN ('not_yet', 'invoiced', 'paid')),

  -- Optional soft link to the estimate_push this milestone was billed through.
  -- Nullable + no FK: estimate_pushes lifecycle is independent and a milestone
  -- may be marked invoiced without a recorded push (e.g. billed outside QBO).
  estimate_push_id uuid,

  -- Stamped by the manual status transitions (PATCH route). Nullable until set.
  invoiced_at timestamptz,
  paid_at timestamptz,

  -- Tagged with the creating tier per the 002_tier_origin.sql / 097 precedent
  -- (nullable: current_setting(..., true) is NULL for psql/unset-GUC sessions).
  tier_origin text DEFAULT current_setting('app.tier', true),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Belt-and-suspenders for company-scoped FK joins (mirrors 097's UNIQUE).
  UNIQUE (company_id, id)
);

-- Project drill-in lists milestones in ladder order; the company_id prefix
-- keeps the lookup inside the RLS-scoped tenant slice.
CREATE INDEX IF NOT EXISTS project_billing_milestones_company_project_sort_idx
  ON project_billing_milestones (company_id, project_id, sort_order);

-- RLS — same belt-and-suspenders guarantee the rest of the company-scoped
-- domain has (identical permissive body to migration 066 / 101: stays
-- permissive when app.company_id is unset so debug/replay/webhook paths keep
-- working). ENABLE + FORCE because the app runs as the table-owner role on DO
-- managed PG (see 085 / 101). Idempotent: DROP POLICY IF EXISTS before CREATE.
DROP POLICY IF EXISTS company_isolation ON project_billing_milestones;
CREATE POLICY company_isolation ON project_billing_milestones
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());
ALTER TABLE project_billing_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_billing_milestones FORCE ROW LEVEL SECURITY;
