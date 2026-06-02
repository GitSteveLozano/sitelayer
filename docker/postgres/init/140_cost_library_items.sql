-- 140_cost_library_items.sql
--
-- Shared trade cost library (Takeoff Deep Dive M5 — "No live/regional
-- material cost database"). See docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §5.3/§6
-- P2.3 and docs/PROJECT_DECOMPOSITION_PLAN.md.
--
-- Today pricing resolves purely from per-company `service_items` (+ the
-- project/customer/company override cards and the QBO item rate) plus the
-- 6 LA-pilot-seeded assemblies. There is no shared catalog of trade unit
-- costs (cladding / siding / framing) and no Excel price-book import
-- (PlanSwift parity). This migration adds the catalog table only.
--
-- ADDITIVE / forward-only / idempotent. This is a pure addition — it does
-- NOT replace `service_items`:
--   - new `cost_library_items` table: a shared catalog of (trade, code,
--     unit, material_rate, labor_rate, region?, source) rows. company_id
--     is NULLABLE — a NULL row is a shared/global catalog entry (e.g. an
--     imported RSMeans-style price book seeded once); a non-NULL row is a
--     company's own imported price book. The pricing resolver consults this
--     table only as the LOWEST-priority fallback, BELOW
--     service_items.default_rate, so when the library is empty nothing
--     existing changes (pricing.ts layer 6).
--   - regional multipliers are deliberately deferred: `region` is captured
--     here as free text so an import preserves it, but the multiplier UI /
--     resolution is a follow-up slice (see PR body flag).
--
-- RLS posture mirrors the company-isolation tables (136/137) but is widened
-- to also expose the shared (company_id IS NULL) rows to every tenant —
-- they are intentionally cross-tenant reference data, read-only to tenants.
-- Writes still go through the API (role-gated), which scopes mutations to
-- the caller's company. IF NOT EXISTS / DROP POLICY IF EXISTS everywhere so
-- the runner may re-apply.

-- (1) cost_library_items -----------------------------------------------------

create table if not exists cost_library_items (
  id           uuid primary key default gen_random_uuid(),
  -- NULL = shared / global catalog row (cross-tenant reference data); a
  -- non-NULL company_id = that company's own imported price book.
  company_id   uuid references companies(id) on delete cascade,
  -- Trade grouping the row belongs to (e.g. 'cladding', 'framing',
  -- 'siding'). Free text so an import preserves the source taxonomy.
  trade        text not null default 'general',
  -- CSI / MasterFormat division code OR a service_item_code this row maps
  -- to. Free text (codes vary by price book). The resolver matches this
  -- against service_items.code when used as a pricing fallback.
  code         text not null,
  -- Human label for the catalog row (the price-book description column).
  name         text,
  unit         text not null default 'ea',
  -- Per-unit material and labor cost. Either may be NULL when a price book
  -- only carries one side. numeric(12,4) keeps import precision; the
  -- resolver coalesces material+labor into a single rate (see pricing.ts).
  material_rate numeric(12, 4),
  labor_rate    numeric(12, 4),
  -- Free-text region tag from the source (e.g. 'CA', 'US-National',
  -- 'Los Angeles'). NULL = unregioned / national. Regional MULTIPLIER
  -- resolution is a follow-up — this only preserves the source value.
  region       text,
  -- Where the row came from: 'import' (uploaded price book), 'rsmeans',
  -- 'manual', 'seed', etc. Free text so a new source needs no migration.
  source       text not null default 'manual',
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   text,
  origin       text default current_setting('app.tier', true)
);

-- One live (non-deleted) row per (company, region, code, unit). A NULL
-- company_id / region collapses via coalesce so shared rows still dedupe.
-- This is the upsert conflict target the import endpoint uses (ON CONFLICT).
create unique index if not exists cost_library_items_dedupe_idx
  on cost_library_items (
    coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(region, ''),
    lower(code),
    lower(unit)
  )
  where deleted_at is null;

-- Company "list / search my library" feed + the shared rows. Partial to
-- active rows. Two indexes so the resolver's per-company lookup and the
-- shared-rows lookup are both covered.
create index if not exists cost_library_items_company_code_idx
  on cost_library_items (company_id, lower(code))
  where deleted_at is null;

create index if not exists cost_library_items_shared_code_idx
  on cost_library_items (lower(code))
  where deleted_at is null and company_id is null;

-- Trade filter for the list screen.
create index if not exists cost_library_items_trade_idx
  on cost_library_items (company_id, lower(trade))
  where deleted_at is null;

-- (2) RLS: company-isolation that ALSO exposes shared (NULL company) rows --

alter table cost_library_items enable row level security;
alter table cost_library_items force row level security;
drop policy if exists company_isolation on cost_library_items;
create policy company_isolation on cost_library_items
  for all
  using (
    app_current_company_id() is null
    or company_id is null
    or company_id = app_current_company_id()
  )
  with check (
    -- A tenant may only WRITE rows scoped to its own company (or, when no
    -- company context is set — the API/admin path — anything). It may not
    -- forge a row for another company. Shared (NULL) rows are written by
    -- the unscoped admin/seed path only.
    app_current_company_id() is null
    or company_id = app_current_company_id()
  );

comment on table cost_library_items is
  'Shared trade cost library (Deep Dive M5). Additive catalog of (trade, code, unit, material_rate, labor_rate, region?, source) rows. company_id NULL = shared/global reference data; non-NULL = a company''s imported price book. Consulted by pricing.ts only as the lowest-priority fallback (layer 6, BELOW service_items.default_rate) so an empty library changes nothing. Does NOT replace service_items.';
comment on column cost_library_items.company_id is
  'NULL = shared/global catalog row (cross-tenant reference data, read-only to tenants). Non-NULL = that company''s own imported price book.';
comment on column cost_library_items.region is
  'Free-text region tag preserved from the source price book. Regional MULTIPLIER resolution is a follow-up slice — this column only preserves the source value.';
