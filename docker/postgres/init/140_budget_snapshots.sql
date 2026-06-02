-- 140_budget_snapshots.sql
--
-- Frozen BUDGET at award (Takeoff Deep Dive §4 — bid / budget / actuals).
-- See docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §4 and
-- docs/PROJECT_DECOMPOSITION_PLAN.md.
--
-- THE GAP THIS CLOSES. Today the loop is broken: `estimate_lines` is the
-- LIVE bid (recompute mutates it in place), and actuals land in
-- `material_bills` + `labor_entries`, but there is NO frozen budget at
-- award. So "did we beat the number we sold the job at?" cannot be
-- answered once recompute has moved the line items. This migration adds an
-- IMMUTABLE budget snapshot taken by an EXPLICIT operator freeze action
-- (NOT tied to project_lifecycle — the freeze is a deliberate decision, a
-- change order mints a NEW versioned snapshot, an existing one is never
-- mutated).
--
-- ADDITIVE / forward-only / idempotent. Pure addition — two new tables,
-- nothing existing changes:
--   - `budget_snapshots`  : one immutable header per (project, version).
--   - `budget_snapshot_lines` : the rolled-up cost lines, immutable.
-- `estimate_lines` stays the live bid, untouched. No backfill — projects
-- with no freeze simply have no snapshot rows, and every reader treats
-- "no snapshot" as "not yet frozen".
--
-- Same company-isolation RLS posture as 124/134/136/137. IF NOT EXISTS /
-- DROP POLICY IF EXISTS everywhere so the runner may re-apply.

-- (1) budget_snapshots (immutable header) ------------------------------------

create table if not exists budget_snapshots (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  -- Monotonic per project. The first freeze is 1; a change-order freeze
  -- mints the next integer. The latest version is the "current" budget;
  -- prior versions are retained for the change-order audit trail.
  version      int not null default 1,
  frozen_at    timestamptz not null default now(),
  -- Clerk user id of the operator who took the snapshot (audit — who
  -- committed to this budget). Text to match the rest of the schema's
  -- actor columns (created_by elsewhere).
  frozen_by    text,
  -- Optional operator note (e.g. "CO #2 — added east elevation").
  note         text,
  -- Denormalized snapshot totals so the variance view + lists don't have
  -- to re-aggregate the lines. In dollars, matching estimate_lines.amount.
  material_total numeric(12, 2) not null default 0,
  labor_total    numeric(12, 2) not null default 0,
  budget_total   numeric(12, 2) not null default 0,
  created_at   timestamptz not null default now(),
  origin       text default current_setting('app.tier', true),
  -- Composite tenant FK (mirrors material_bills / estimate_lines) so a line
  -- can never point at a snapshot in another company.
  foreign key (company_id, project_id) references projects(company_id, id) on delete cascade
);

create unique index if not exists budget_snapshots_project_version_idx
  on budget_snapshots (company_id, project_id, version);

-- "latest budget for this project" lookup (the variance view reads the
-- newest version) + the project budget list.
create index if not exists budget_snapshots_project_idx
  on budget_snapshots (company_id, project_id, version desc);

-- Composite (company_id, id) unique that the budget_snapshot_lines tenant FK
-- below references (mirrors material_bills / blueprint_documents). Must be
-- added BEFORE the line table so the inline FK can resolve it.
do $$
begin
  alter table budget_snapshots
    add constraint budget_snapshots_company_id_uk unique (company_id, id);
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

-- (2) budget_snapshot_lines (immutable rolled-up cost lines) ------------------

create table if not exists budget_snapshot_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  budget_snapshot_id uuid not null references budget_snapshots(id) on delete cascade,
  -- The cost-code taxonomy. service_item_code is the canonical roll-up key
  -- (shared with labor_entries + estimate_lines). cost_code is the optional
  -- higher-level CSI/division cost-code bucket — populated today from
  -- division_code (the only cost-coding axis the estimate carries), NULLABLE
  -- so a future real cost-code dimension can fill it without a rewrite.
  cost_code       text,
  division_code   text,
  service_item_code text not null,
  qty             numeric(12, 2) not null default 0,
  unit            text not null default '',
  -- Split cost at freeze time, derived from estimate_lines.kind (109):
  -- labor_amount sums the dollar amount of kind='labor' lines; material_amount
  -- sums everything else (kind in material/sub/freight or NULL flat lines).
  -- budget for the line = material_amount + labor_amount. This split is what
  -- the variance view compares against actuals (material_bills vs
  -- labor_entries × labor_rate).
  material_amount numeric(12, 2) not null default 0,
  labor_amount    numeric(12, 2) not null default 0,
  created_at      timestamptz not null default now(),
  foreign key (company_id, budget_snapshot_id) references budget_snapshots(company_id, id) on delete cascade
);

-- Per-snapshot line read (the variance view fans the budget lines).
create index if not exists budget_snapshot_lines_snapshot_idx
  on budget_snapshot_lines (company_id, budget_snapshot_id);

-- Per-cost-code roll-up read.
create index if not exists budget_snapshot_lines_code_idx
  on budget_snapshot_lines (company_id, budget_snapshot_id, service_item_code);

-- (3) IMMUTABILITY enforcement -----------------------------------------------
--
-- A budget snapshot is the frozen number the job was committed to — it must
-- never CHANGE after it is written (a change order mints a NEW version; an
-- existing snapshot is never modified). The route only ever INSERTs, but
-- defense-in-depth: a BEFORE UPDATE trigger rejects any update at the DB
-- layer on both tables.
--
-- DELETE is deliberately NOT blocked. The only deletes that can occur are
-- ON DELETE CASCADE from companies / projects (tenant teardown) — no route
-- ever deletes a snapshot. Blocking cascade deletes would break teardown
-- (and the cascade ordering for the two direct company children is not
-- guaranteed), so we leave DELETE alone. Immutability is about never
-- mutating the frozen number, which UPDATE-blocking fully guarantees.

create or replace function budget_snapshot_no_update() returns trigger
  language plpgsql as $$
begin
  raise exception
    'budget snapshots are immutable (table %): a change order mints a new version, existing snapshots are never modified',
    tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists budget_snapshots_no_update on budget_snapshots;
create trigger budget_snapshots_no_update
  before update on budget_snapshots
  for each row execute function budget_snapshot_no_update();

drop trigger if exists budget_snapshot_lines_no_update on budget_snapshot_lines;
create trigger budget_snapshot_lines_no_update
  before update on budget_snapshot_lines
  for each row execute function budget_snapshot_no_update();

-- (4) RLS: identical company-isolation policy shape as every tenant table ----

alter table budget_snapshots enable row level security;
alter table budget_snapshots force row level security;
drop policy if exists company_isolation on budget_snapshots;
create policy company_isolation on budget_snapshots
  for all
  using (app_current_company_id() is null or company_id = app_current_company_id())
  with check (app_current_company_id() is null or company_id = app_current_company_id());

alter table budget_snapshot_lines enable row level security;
alter table budget_snapshot_lines force row level security;
drop policy if exists company_isolation on budget_snapshot_lines;
create policy company_isolation on budget_snapshot_lines
  for all
  using (app_current_company_id() is null or company_id = app_current_company_id())
  with check (app_current_company_id() is null or company_id = app_current_company_id());

comment on table budget_snapshots is
  'Immutable frozen BUDGET at award (Deep Dive §4). Taken by an explicit operator freeze, NOT tied to project_lifecycle. A change order mints a new version (monotonic per project); an existing snapshot is never mutated (enforced by trigger). estimate_lines stays the live bid.';
comment on table budget_snapshot_lines is
  'Immutable per-cost-code budget lines rolled up from estimate_lines at freeze time. Roll-up key is service_item_code; cost_code/division_code carry the optional higher-level cost-code axis (populated from division_code today). material_amount + labor_amount = the frozen budget for the line.';
