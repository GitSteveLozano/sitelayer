-- 134_company_invites.sql
-- Teammate invite + accept. An invite is created against an EMAIL (the invitee
-- may not have a Clerk identity yet). On accept, the authenticated Clerk user's
-- id is bound into company_memberships and the invite is marked accepted.
-- Forward-only, idempotent (IF NOT EXISTS everywhere). Company-scoped under the
-- same RLS posture as migrations 066/085.

create table if not exists company_invites (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  email        text not null,
  role         text not null default 'member',
  token        text not null unique,
  status       text not null default 'pending'
                 check (status in ('pending','accepted','revoked','expired')),
  invited_by   text not null,                 -- clerk_user_id of the admin who sent it
  accepted_by  text,                          -- clerk_user_id that accepted (null until accepted)
  accepted_at  timestamptz,
  expires_at   timestamptz not null default now() + interval '14 days',
  created_at   timestamptz not null default now(),
  origin       text default current_setting('app.tier', true)
);

-- One outstanding (pending) invite per (company, email). Accepted/revoked/expired
-- rows are kept as history and excluded from the uniqueness guard so an admin can
-- re-invite after revocation/expiry. lower(email) so casing can't dodge the guard.
create unique index if not exists company_invites_one_pending_idx
  on company_invites (company_id, lower(email))
  where status = 'pending';

-- Token lookup for the public view-by-token + accept paths.
create unique index if not exists company_invites_token_idx
  on company_invites (token);

-- Admin "list invites for my company" feed, newest first.
create index if not exists company_invites_company_idx
  on company_invites (company_id, created_at desc);

-- RLS: same company-isolation policy shape as every other tenant table.
alter table company_invites enable row level security;
alter table company_invites force row level security;
drop policy if exists company_invites_company_isolation on company_invites;
create policy company_invites_company_isolation on company_invites
  using (app_current_company_id() is null or company_id = app_current_company_id())
  with check (app_current_company_id() is null or company_id = app_current_company_id());

comment on table company_invites is
  'Teammate invitations. email is the addressee; token is the unguessable accept key; accepted_by is the Clerk user id that claimed it.';
