-- 097_change_orders.sql
--
-- Change orders — a project addendum (added/removed scope after the
-- contract is signed) that carries its own value delta and runs through a
-- deterministic approval workflow, mirroring the qbo_sync_runs / estimate_push
-- pattern (status + state_version fed by a pure reducer in
-- packages/workflows/src/change-order.ts).
--
-- Surfaced by Steve's v2 design (workflow 07 · Project Lifecycle → CHANGE
-- ORDER · NEW/SENT/ACCEPTED). The signed contract value lives on the project;
-- a change order does NOT mutate the project's bid_total — the project's
-- effective value is bid_total + sum(accepted change_orders.value_delta), kept
-- additive so the original contract figure stays auditable.
--
-- States (see change-order.ts):
--   draft → sent → accepted | rejected      (voided is terminal-from-any)
--
-- Events:
--   SEND     (draft → sent)        {actor_user_id, occurred_at}
--   ACCEPT   (sent → accepted)     {actor_user_id, occurred_at}  -- client signs
--   REJECT   (sent → rejected)     {actor_user_id, occurred_at, reason?}
--   VOID     (draft|sent → voided) {actor_user_id, occurred_at}
--
-- accepted / rejected / voided are terminal. value_delta may be negative
-- (a credit / scope reduction).

CREATE TABLE IF NOT EXISTS change_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Per-project sequential CO number (CO-001, CO-002, ...). Assigned by the
  -- create route, not the DB, so it can be human-friendly and gap-free.
  number int NOT NULL,

  description text NOT NULL DEFAULT '',
  -- Signed dollar change to the contract. Negative = credit / scope cut.
  value_delta numeric(14, 2) NOT NULL DEFAULT 0,
  -- Optional schedule impact in days (0 = none), surfaced in the v2 CO sheet.
  schedule_impact_days int NOT NULL DEFAULT 0,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'voided')),
  state_version int NOT NULL DEFAULT 1,

  -- Stamped by transitions (NULLable; populated as the CO moves through).
  sent_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  voided_at timestamptz,
  reject_reason text,

  created_by text,            -- Clerk user id of the author
  approved_by text,           -- Clerk user id of whoever recorded the client signature

  workflow_engine text NOT NULL DEFAULT 'postgres',
  workflow_run_id text,

  -- Tagged with the creating tier per the 002_tier_origin.sql precedent
  -- (nullable: current_setting(..., true) is NULL for psql/unset-GUC sessions).
  origin text DEFAULT current_setting('app.tier', true),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (project_id, number)
);

-- Project drill-in lists COs newest-first; the owner dashboard counts
-- outstanding (sent) COs awaiting a client signature.
CREATE INDEX IF NOT EXISTS change_orders_project_idx
  ON change_orders (project_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS change_orders_company_status_idx
  ON change_orders (company_id, status, created_at DESC)
  WHERE deleted_at IS NULL;
