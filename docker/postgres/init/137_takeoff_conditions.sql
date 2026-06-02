-- 137_takeoff_conditions.sql
--
-- Condition layer (Takeoff Deep Dive H1 — the keystone reusable typed
-- template). See docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §5.2/§6 P1.1 and
-- docs/PROJECT_DECOMPOSITION_PLAN.md §3.5.
--
-- A Condition is a company-level, named/colored, *typed* template that
-- fixes the measurement kind (area/linear/count/volume) plus the
-- drivers (height / thickness / sides / slope) and an optional default
-- assembly, so an estimator picks a Condition and draws *against it*
-- instead of re-specifying scope on every polygon (shape-first today).
-- It is the natural future home for pitch math and trade-aware
-- deductions.
--
-- ADDITIVE / forward-only / idempotent. This migration is deliberately
-- a pure addition (deep-dive §7 risk #2: the Condition layer is additive
-- — the existing tag-based `takeoff_measurement_tags` model stays the
-- fallback, NOT a backfill):
--   - new `takeoff_conditions` table (company-scoped, soft-delete);
--   - a NULLABLE `condition_id` column on `takeoff_measurements`. Existing
--     rows stay NULL (no backfill) and keep rendering through the legacy
--     tag/flat-line path. A measurement drawn against a Condition records
--     its id here; everything that reads measurements ignores the column
--     until a reader opts in.
--
-- Same company-isolation RLS posture as migrations 124/134/136. IF NOT
-- EXISTS / DROP POLICY IF EXISTS everywhere so the runner may re-apply.

-- (1) takeoff_conditions -----------------------------------------------------

create table if not exists takeoff_conditions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  name         text not null,
  -- Hex color the canvas legend + drawn geometry render in (e.g. '#2f7d32').
  color        text not null default '#2f7d32',
  -- The typed geometry primitive this Condition measures against. Mirrors
  -- takeoff_measurements.geometry_kind so a Condition constrains the draw
  -- tool. 'area' is the canvas polygon/rect default.
  measurement_kind text not null default 'area'
                 check (measurement_kind in ('area', 'linear', 'count', 'volume')),
  -- Drivers. All NULLABLE — a Condition only fixes the drivers its
  -- measurement_kind + result emission actually need (e.g. a one-side wall
  -- SF Condition fixes height; a CY Condition fixes height + thickness).
  -- height/thickness are world units (ft); sides is 1 or 2; slope is a
  -- rise:run ratio stored as the rise over a run of 12 (NULL = flat / 1.0).
  height_value     numeric(12, 4),
  thickness_value  numeric(12, 4),
  sides            int check (sides is null or sides in (1, 2)),
  slope_value      numeric(12, 4),
  -- Optional default assembly this Condition attaches to a drawn
  -- measurement (recompute explodes it). NULL = flat-line. FK added
  -- defensively below (NOT VALID, ON DELETE SET NULL) so soft/hard-deleting
  -- an assembly never orphans a Condition.
  default_assembly_id uuid,
  -- Result-emission flags: which of the up-to-three derivable results a
  -- drawn object should emit (LF, single/both-side SF, CY). Additive
  -- booleans — readers that don't understand them simply ignore them.
  emit_linear      boolean not null default false,
  emit_area        boolean not null default true,
  emit_volume      boolean not null default false,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   text,
  origin       text default current_setting('app.tier', true)
);

-- One live (non-deleted) Condition per (company, name), case-insensitive.
-- Soft-deleted rows are excluded so a name can be reused after retirement.
-- Mirrors custom_roles_company_name_idx (136).
create unique index if not exists takeoff_conditions_company_name_idx
  on takeoff_conditions (company_id, lower(name))
  where deleted_at is null;

-- Company "list my conditions" feed (the canvas picker + legend).
create index if not exists takeoff_conditions_company_idx
  on takeoff_conditions (company_id)
  where deleted_at is null;

-- Default-assembly FK. NOT VALID skips the full-table scan; new rows are
-- still checked. Wrapped in a DO block because Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS — same defensive idiom as 109's
-- takeoff_measurements_assembly_fk.
do $$
begin
  alter table takeoff_conditions
    add constraint takeoff_conditions_default_assembly_fk
    foreign key (default_assembly_id) references service_item_assemblies(id) on delete set null
    not valid;
exception
  when duplicate_object then null;
end $$;

-- (2) takeoff_measurements.condition_id (additive, NULLABLE, no backfill) ----

-- New column only. Existing rows stay NULL and keep rendering via the
-- legacy tag/flat-line path (deep-dive §7 risk #2). FK is ON DELETE SET
-- NULL + NOT VALID so deleting a Condition never orphans a measurement and
-- no legacy-row scan runs (no legacy row has a non-null condition_id).
alter table takeoff_measurements
  add column if not exists condition_id uuid;

do $$
begin
  alter table takeoff_measurements
    add constraint takeoff_measurements_condition_fk
    foreign key (condition_id) references takeoff_conditions(id) on delete set null
    not valid;
exception
  when duplicate_object then null;
end $$;

-- Partial index for the per-Condition rollup ("which measurements were
-- drawn against this Condition"). Scoped to active rows that attach one.
create index if not exists takeoff_measurements_condition_idx
  on takeoff_measurements (company_id, condition_id)
  where condition_id is not null and deleted_at is null;

-- (3) RLS: identical company-isolation policy shape as every tenant table -----

alter table takeoff_conditions enable row level security;
alter table takeoff_conditions force row level security;
drop policy if exists company_isolation on takeoff_conditions;
create policy company_isolation on takeoff_conditions
  for all
  using (app_current_company_id() is null or company_id = app_current_company_id())
  with check (app_current_company_id() is null or company_id = app_current_company_id());

comment on table takeoff_conditions is
  'Company-level reusable typed takeoff template (Deep Dive H1). Fixes measurement_kind + drivers (height/thickness/sides/slope) + an optional default assembly + result-emission flags. Additive: measurements record condition_id but the legacy tag model remains the fallback (no backfill).';
comment on column takeoff_measurements.condition_id is
  'Optional link to the takeoff_conditions row this measurement was drawn against (Deep Dive H1). NULL = legacy shape-first measurement (tags/flat-line). Additive, no backfill — existing rows stay NULL.';
