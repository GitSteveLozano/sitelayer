-- 136_custom_roles.sql
-- Custom roles for the RBAC-A / RABAC overhaul (see docs/RBAC_OVERHAUL_ANALYSIS.md
-- and packages/domain/src/permissions.ts).
--
-- A custom role is a per-company role that INHERITS one of the five immutable
-- built-in bases (owner/estimator/foreman/crew/bookkeeper) and adds extra named
-- actions, each optionally carrying a parameterized constraint (e.g.
-- auth_materials up to $1,000). Built-in roles themselves are NOT stored here —
-- their action matrix is the checked-in system contract in @sitelayer/domain.
-- Only custom roles are per-company editable.
--
--   custom_roles         — one row per company-defined role (inherit_from base).
--   custom_role_grants    — the extra named actions a custom role grants, with
--                           optional jsonb constraints (caps). One row per
--                           (role, action).
--   company_memberships.custom_role_id — links a member to a custom role; NULL
--                           means the member gates purely on their raw company
--                           role (zero behaviour change).
--
-- Forward-only, idempotent (IF NOT EXISTS everywhere). Company-scoped under the
-- same RLS posture as migrations 066/085/134. custom_role_grants stores
-- company_id redundantly (NOT NULL) so its isolation policy is the identical
-- single-table shape — no join through the parent custom_role required.

-- (1) custom_roles -----------------------------------------------------------

create table if not exists custom_roles (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  name         text not null,
  inherit_from text not null
                 check (inherit_from in ('owner','estimator','foreman','crew','bookkeeper')),
  deleted_at   timestamptz,
  created_at   timestamptz default now(),
  created_by   text
);

-- One live (non-deleted) role per (company, name), case-insensitive. Soft-deleted
-- rows are excluded so a name can be reused after a role is retired.
create unique index if not exists custom_roles_company_name_idx
  on custom_roles (company_id, lower(name))
  where deleted_at is null;

-- Company "list my custom roles" feed.
create index if not exists custom_roles_company_idx
  on custom_roles (company_id);

-- (2) custom_role_grants -----------------------------------------------------

create table if not exists custom_role_grants (
  id             uuid primary key default gen_random_uuid(),
  custom_role_id uuid not null references custom_roles(id) on delete cascade,
  company_id     uuid not null references companies(id) on delete cascade,
  action         text not null,
  constraints    jsonb,
  unique (custom_role_id, action)
);

-- Grant lookup by role (the per-request resolution reads all grants for a role).
create index if not exists custom_role_grants_role_idx
  on custom_role_grants (custom_role_id);

-- (3) company_memberships.custom_role_id ------------------------------------

alter table company_memberships
  add column if not exists custom_role_id uuid references custom_roles(id) on delete set null;

create index if not exists company_memberships_custom_role_idx
  on company_memberships (custom_role_id)
  where custom_role_id is not null;

-- (4) RLS: same company-isolation policy shape as every other tenant table ---

alter table custom_roles enable row level security;
alter table custom_roles force row level security;
drop policy if exists custom_roles_company_isolation on custom_roles;
create policy custom_roles_company_isolation on custom_roles
  using (app_current_company_id() is null or company_id = app_current_company_id())
  with check (app_current_company_id() is null or company_id = app_current_company_id());

alter table custom_role_grants enable row level security;
alter table custom_role_grants force row level security;
drop policy if exists custom_role_grants_company_isolation on custom_role_grants;
create policy custom_role_grants_company_isolation on custom_role_grants
  using (app_current_company_id() is null or company_id = app_current_company_id())
  with check (app_current_company_id() is null or company_id = app_current_company_id());

comment on table custom_roles is
  'Per-company custom roles. inherit_from is the immutable built-in base; the long tail gates on builtinToCompanyRole(inherit_from), the 9 named actions resolve via the matrix plus this role''s grants. Built-in roles are NOT stored here.';
comment on table custom_role_grants is
  'Extra named actions a custom role grants. action is one of the 9 PERMISSION_ACTIONS; constraints jsonb holds optional caps (e.g. {"max_amount_cents":100000}). company_id is stored redundantly for single-table RLS.';
comment on column company_memberships.custom_role_id is
  'Optional link to a custom_roles row. NULL = member gates purely on its raw company role (zero behaviour change).';
