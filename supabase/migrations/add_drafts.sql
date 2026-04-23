-- Multi-draft system for measurement and future tool types (scaffolding, etc.)

-- 1. Create drafts table
create table if not exists drafts (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  type         text not null default 'measurement',
  name         text not null default 'Draft 1',
  is_active    boolean not null default false,
  canvas_state jsonb not null default '{}'::jsonb,
  estimate     jsonb not null default '{}'::jsonb,
  tool_data    jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 2. Indexes
create unique index idx_drafts_active
  on drafts (project_id, type) where is_active = true;
create index idx_drafts_project
  on drafts (project_id, type, created_at desc);

-- 3. RLS
alter table drafts enable row level security;

create policy "draft_all" on drafts
  for all using (
    project_id in (
      select id from projects where
        company_id in (
          select company_id from company_users where user_id = auth.uid()
        )
        or company_id in (
          select id from companies where owner_id = auth.uid()
        )
    )
  );

-- 4. Migrate existing canvas_state / blueprint_measurements into drafts
insert into drafts (project_id, type, name, is_active, canvas_state, estimate, created_at)
select
  id,
  'measurement',
  'Draft 1',
  true,
  coalesce(metadata->'canvas_state', '{}'::jsonb),
  coalesce(metadata->'blueprint_measurements', '{}'::jsonb),
  created_at
from projects
where metadata->'canvas_state' is not null
   or metadata->'blueprint_measurements' is not null;
