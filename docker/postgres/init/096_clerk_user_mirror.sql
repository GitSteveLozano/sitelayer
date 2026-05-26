-- 096_clerk_user_mirror.sql
--
-- Mirror table for Clerk users, keyed by clerk_user_id. Populated by the
-- Svix-verified Clerk webhook (apps/api/src/routes/public.ts):
--   - user.created / user.updated → upsert (email, names, image, timestamps)
--   - user.deleted               → soft delete (set deleted_at)
--
-- Why a mirror table at all: invited members are real Clerk identities the
-- moment they accept an org invite, but Sitelayer only knew about a user once
-- they hit /api/companies and a company_memberships row was written. That left
-- a provisioning gap — an invited foreman was invisible to the app until they
-- manually onboarded. This table closes the gap: every Clerk identity is
-- mirrored on user.created so the app can resolve a display name / email for a
-- clerk_user_id (e.g. surfacing pending-invite members) without a manual
-- provisioning step.
--
-- NOT company-scoped on purpose. A Clerk user can belong to many companies,
-- and the webhook arrives pre-tenancy (no company context, no app.company_id
-- GUC). So this table is a GLOBAL identity directory keyed by clerk_user_id,
-- the same shape Clerk uses. Per-company role still lives in
-- company_memberships; this table never claims to own that relationship.
--
-- Because it is not company-scoped, it does NOT get the
-- app_current_company_id() company-isolation policy that migrations 066/085
-- apply to per-tenant tables. The webhook writes at the pool with no GUC set.
-- We still keep RLS *enabled* with a deliberately permissive policy so the
-- table participates in the RLS posture (FORCE on prod) rather than being a
-- silent bypass — the policy is permissive because identity rows are global,
-- not per-tenant. PII access control for this table is the webhook signature
-- (write) and the server-side join (read); there is no client-facing endpoint
-- that returns rows directly.
--
-- tier_origin: tagged with the creating tier via current_setting('app.tier',
-- true) per the 002_tier_origin.sql precedent, so a prod row is never confused
-- with a dev/preview row during cross-tier inspection.

create table if not exists clerk_users (
  clerk_user_id text primary key,
  email text,
  first_name text,
  last_name text,
  image_url text,
  origin text default current_setting('app.tier', true),
  clerk_created_at timestamptz,
  clerk_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Resolve a clerk_user_id by email (JIT membership / pending-invite matching).
-- Partial index excludes soft-deleted rows so the live lookup stays small.
create index if not exists clerk_users_email_idx
  on clerk_users (lower(email)) where deleted_at is null;

create index if not exists clerk_users_origin_idx
  on clerk_users (origin) where origin is not null;

alter table clerk_users enable row level security;
alter table clerk_users force row level security;

-- Permissive policy: identity rows are global, not per-tenant, so there is no
-- company_id to scope on. The policy exists so the table is covered by RLS
-- (FORCE) rather than bypassed; it never restricts because the only writer is
-- the signature-verified webhook and the only readers are server-side joins.
drop policy if exists clerk_users_global on clerk_users;
create policy clerk_users_global on clerk_users
  using (true)
  with check (true);

comment on table clerk_users is
  'Global mirror of Clerk users, keyed by clerk_user_id. Populated by the Svix-verified Clerk webhook. NOT company-scoped — per-company role lives in company_memberships.';
comment on column clerk_users.clerk_user_id is
  'Clerk user id (e.g. user_xxx). Primary key; matches company_memberships.clerk_user_id.';
comment on column clerk_users.clerk_created_at is
  'created_at reported by Clerk in the webhook payload (epoch ms → timestamptz).';
comment on column clerk_users.deleted_at is
  'Soft-delete marker set on user.deleted. Memberships and audit rows are intentionally left intact.';
