-- 086_company_usage_log.sql
--
-- Per-company cost log for expensive operations (QBO sync, blueprint
-- vision). Append-only — every row is one billable event with its
-- estimated dollar cost. This is the data substrate for future
-- quota / billing logic; no quotas are enforced in this migration.
--
-- Cost numbers are placeholders supplied by the call sites:
--   - qbo_api_call           ~$0.05 per call (only logged in production)
--   - blueprint_vision_page  ~$0.25 per page (Claude Opus PDF vision; the
--                            real cost depends on input/output tokens
--                            once the SDK surfaces them).
--
-- Read path: GET /api/companies/:id/usage groups by operation over the
-- current calendar month. The (company_id, created_at desc) index covers
-- that query; the (operation, created_at desc) index covers future
-- cross-company spend rollups.
--
-- RLS follows the same company-scope shape as the rest of the Phase 3
-- surface (migration 066 + 085): the policy reads
-- app_current_company_id() and a transaction with no GUC set falls back
-- permissive (for migration tooling / replay paths). FORCE is on so the
-- table owner role doesn't bypass the policy on prod (where the migrator
-- runs as a different role from the app).

create table if not exists company_usage_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  operation text not null,
  cost_usd numeric(10, 6) not null,
  description text,
  request_id text,
  sentry_trace text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists company_usage_log_company_created_idx
  on company_usage_log (company_id, created_at desc);

create index if not exists company_usage_log_operation_idx
  on company_usage_log (operation, created_at desc);

alter table company_usage_log enable row level security;
alter table company_usage_log force row level security;

drop policy if exists company_usage_log_company_scope on company_usage_log;
create policy company_usage_log_company_scope on company_usage_log
  using (app_current_company_id() is null or company_id = app_current_company_id())
  with check (app_current_company_id() is null or company_id = app_current_company_id());

comment on table company_usage_log is
  'Per-company cost log for expensive operations (QBO sync, blueprint vision). Append-only.';
comment on column company_usage_log.operation is
  'Operation kind (e.g. qbo_api_call, blueprint_vision_page).';
comment on column company_usage_log.cost_usd is
  'Estimated cost in USD; 6 decimal places allow $0.000050 precision.';
