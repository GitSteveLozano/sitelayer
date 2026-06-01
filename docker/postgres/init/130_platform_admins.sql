-- Migration 130: platform_admins (cross-tenant superadmin registry)
-- Backs the platform-level superadmin trust boundary (design §5). A request is
-- a superadmin iff its verified Clerk `sub` is in this table OR in the
-- PLATFORM_SUPERADMIN_CLERK_IDS env allowlist (the env bootstraps the first
-- admin before any row exists; the table makes the set editable without a
-- redeploy). This is a platform-scoped grant ABOVE company_memberships — it is
-- NOT tenant-scoped and is unrelated to the company `admin` role.
--
-- Idempotent (IF NOT EXISTS) so re-running the migration set is a no-op.
create table if not exists platform_admins (
  clerk_user_id text primary key,
  note text,
  created_at timestamptz not null default now()
);
