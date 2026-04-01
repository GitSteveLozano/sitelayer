-- SiteLayer Database Schema
-- Run this in Supabase SQL Editor

-- ── TABLES ────────────────────────────────────────────────────────────────────

create table if not exists companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'My Company',
  owner_id   uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists company_users (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  user_id    uuid references auth.users(id),
  role       text default 'admin',
  created_at timestamptz default now(),
  unique(company_id, user_id)
);

create table if not exists projects (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid references companies(id) on delete cascade,
  name               text not null,
  client_name        text,
  division           text,
  status             text default 'bid',
  sqft               numeric default 0,
  bid_psf            numeric default 0,
  labor_rate         numeric default 38,
  target_sqft_per_hr numeric,
  bonus_pool         numeric default 0,
  risk_threshold     numeric default 0.50,
  material_cost      numeric default 0,
  sub_cost           numeric default 0,
  created_at         timestamptz default now()
);

create table if not exists labor_entries (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references projects(id) on delete cascade,
  service_item text,
  hours        numeric default 0,
  sqft_done    numeric default 0,
  crew_size    int,
  notes        text,
  logged_at    timestamptz default now()
);

create table if not exists integrations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id) on delete cascade,
  provider      text not null,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  metadata      jsonb,
  created_at    timestamptz default now()
);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────

alter table companies     enable row level security;
alter table company_users enable row level security;
alter table projects      enable row level security;
alter table labor_entries enable row level security;
alter table integrations  enable row level security;

-- Companies: visible to members only
create policy "company_select" on companies
  for select using (
    id in (select company_id from company_users where user_id = auth.uid())
  );
create policy "company_insert" on companies
  for insert with check (owner_id = auth.uid());
create policy "company_update" on companies
  for update using (
    id in (select company_id from company_users where user_id = auth.uid())
  );

-- Company users: own records only
create policy "cu_select" on company_users
  for select using (user_id = auth.uid());
create policy "cu_insert" on company_users
  for insert with check (user_id = auth.uid());

-- Projects: company members only
create policy "project_all" on projects
  for all using (
    company_id in (
      select company_id from company_users where user_id = auth.uid()
    )
  );

-- Labor entries: via project membership
create policy "labor_all" on labor_entries
  for all using (
    project_id in (
      select id from projects where
        company_id in (
          select company_id from company_users where user_id = auth.uid()
        )
    )
  );

-- Integrations: company members
create policy "integration_all" on integrations
  for all using (
    company_id in (
      select company_id from company_users where user_id = auth.uid()
    )
  );
