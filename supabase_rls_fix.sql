-- Fix RLS policies for first-time signup
-- Run this in Supabase SQL Editor

-- Drop old policies
drop policy if exists "company_select" on companies;
drop policy if exists "company_insert" on companies;
drop policy if exists "company_update" on companies;
drop policy if exists "cu_select" on company_users;
drop policy if exists "cu_insert" on company_users;
drop policy if exists "project_all" on projects;
drop policy if exists "labor_all" on labor_entries;
drop policy if exists "integration_all" on integrations;

-- Companies: owner can always see/edit their own company
create policy "company_select" on companies
  for select using (
    owner_id = auth.uid()
    or id in (select company_id from company_users where user_id = auth.uid())
  );

create policy "company_insert" on companies
  for insert with check (owner_id = auth.uid());

create policy "company_update" on companies
  for update using (
    owner_id = auth.uid()
    or id in (select company_id from company_users where user_id = auth.uid())
  );

-- Company users: any authenticated user can insert for themselves
create policy "cu_select" on company_users
  for select using (user_id = auth.uid());

create policy "cu_insert" on company_users
  for insert with check (user_id = auth.uid());

create policy "cu_update" on company_users
  for update using (user_id = auth.uid());

-- Projects: company members only
create policy "project_all" on projects
  for all using (
    company_id in (
      select company_id from company_users where user_id = auth.uid()
    )
    or company_id in (
      select id from companies where owner_id = auth.uid()
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
        or company_id in (
          select id from companies where owner_id = auth.uid()
        )
    )
  );

-- Integrations: company members
create policy "integration_all" on integrations
  for all using (
    company_id in (
      select company_id from company_users where user_id = auth.uid()
    )
    or company_id in (
      select id from companies where owner_id = auth.uid()
    )
  );
