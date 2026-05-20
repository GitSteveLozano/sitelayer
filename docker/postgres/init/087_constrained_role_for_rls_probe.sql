-- 087_constrained_role_for_rls_probe.sql
--
-- Provision the `sitelayer_constrained` LOGIN role used by the Phase 3
-- RLS runtime probe (`apps/api/src/routes/rls-phase3-audit.test.ts`).
--
-- The probe must connect as a NON-superuser, NON-BYPASSRLS role to prove
-- that the policies defined by migration 066 and FORCE'd by migration 085
-- actually scope reads/writes to the bound `app.company_id` GUC. The app
-- role `sitelayer` is the table owner in dev/CI/prod and is BYPASSRLS in
-- dev/CI (postgres:18-alpine's POSTGRES_USER attribute) and table owner
-- (no FORCE bypass) in prod — either way, querying as `sitelayer`
-- bypasses RLS and the probe is a no-op.
--
-- ## Role design
--
-- The constrained role:
--   - LOGIN with a deterministic password derived from the role name so
--     CI can compute `CONSTRAINED_DB_URL` by substituting the user in
--     `DATABASE_URL` (the local/dev DB is the only place this password
--     is meaningful — it cannot reach a real network in prod because the
--     role is not created there; see "Tier gating" below).
--   - NOSUPERUSER and NOBYPASSRLS — both are required for the probe to
--     observe RLS enforcement. NOSUPERUSER is the default; NOBYPASSRLS
--     is explicit so a future ALTER ROLE that flips BYPASSRLS is louder.
--   - INHERIT (default) — combined with `GRANT sitelayer TO
--     sitelayer_constrained` below, this gives the role the table-owner
--     privileges it needs to `ALTER TABLE projects ENABLE/FORCE/DISABLE
--     ROW LEVEL SECURITY` inside the probe. Critically, the BYPASSRLS
--     attribute is NOT inherited (PostgreSQL docs: "BYPASSRLS, CREATEDB,
--     ... are not implicitly inherited as group membership"), so the
--     constrained role can ALTER the table without bypassing the policy
--     it just enabled. Verified locally before this migration shipped.
--
-- ## Tier gating (load-bearing)
--
-- This role MUST NOT exist in prod. The repo's CLAUDE.md "Operating
-- Rules" forbid widening the prod attack surface; an extra LOGIN role
-- with a known password (even one that's NOSUPERUSER and NOBYPASSRLS)
-- is a credential the operator would now have to rotate alongside the
-- app role. The migration therefore checks `current_database()` against
-- the prod database name(s) — `sitelayer_prod` and any read-only
-- variants matching `sitelayer_prod%` — and is a no-op there. Same gate
-- pattern the `packages/config` tier check uses (see
-- `packages/config/src/index.ts` — `/sitelayer_prod\b/`).
--
-- The DigitalOcean Managed Postgres cluster also hosts `sitelayer_dev`
-- and `sitelayer_preview` on the same physical instance; this migration
-- runs against each of those databases independently, and the role is
-- intentionally created in non-prod databases (dev / preview / local).
-- The role attribute matrix:
--
--    database                     create role?  rationale
--    sitelayer (local docker)     yes           dev container, CI service
--    sitelayer_dev                yes           preview-droplet dev DB
--    sitelayer_preview            yes           preview-droplet preview DB
--    sitelayer_prod               NO            prod; runtime probe not run here
--    sitelayer_prod_ro            NO            prod read-only mirror
--
-- ## Idempotency
--
-- Re-running this migration is safe:
--   - `CREATE ROLE ... IF NOT EXISTS` doesn't exist in PostgreSQL, so the
--     DO block guards on `pg_roles` membership.
--   - `GRANT ... ON ALL TABLES` is run unconditionally; repeated GRANTs
--     are no-ops.
--   - The `GRANT sitelayer TO sitelayer_constrained` membership grant is
--     similarly a no-op if already granted.
--
-- ## How CI uses this
--
-- The `quality.yml` workflow computes
--   CONSTRAINED_DB_URL=postgres://sitelayer_constrained:sitelayer_constrained@localhost:5432/sitelayer
-- and exports it to the test step. The previously-skipped 4 of 5 tests
-- in `rls-phase3-audit.test.ts` then exercise the constrained role
-- against the same Postgres service that already ran the integration
-- suite. See `docs/SECURITY_RLS.md` for the broader rollout context.

DO $constrained_role$
DECLARE
  current_db text := current_database();
  is_prod boolean := current_db ~ '^sitelayer_prod(_|$)';
BEGIN
  IF is_prod THEN
    RAISE NOTICE 'constrained role: skipping in prod database %', current_db;
    RETURN;
  END IF;

  -- Create the role if it doesn't exist. Password matches role name so
  -- CI can synthesize CONSTRAINED_DB_URL by string-substituting the user
  -- in DATABASE_URL. The password is not a secret in any meaningful
  -- sense: it's only valid against the local/preview Postgres that
  -- already trusts the `sitelayer` superuser with the same password
  -- (postgres:18-alpine default), and the role has no SUPERUSER and no
  -- BYPASSRLS so credential exposure is bounded.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelayer_constrained') THEN
    EXECUTE 'CREATE ROLE sitelayer_constrained LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ''sitelayer_constrained''';
    RAISE NOTICE 'constrained role: created sitelayer_constrained in database %', current_db;
  ELSE
    -- Defensive: re-assert the critical attributes in case a prior
    -- operator flipped them. NOBYPASSRLS is the load-bearing one — if
    -- the role ever gains BYPASSRLS the runtime probe becomes a
    -- silently-passing no-op.
    EXECUTE 'ALTER ROLE sitelayer_constrained NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
    RAISE NOTICE 'constrained role: re-asserted attributes on existing sitelayer_constrained in database %', current_db;
  END IF;

  -- Grant CONNECT on the current database. New roles get this by
  -- default via PUBLIC, but DigitalOcean Managed Postgres revokes
  -- CONNECT on PUBLIC in some cluster configurations, so be explicit.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO sitelayer_constrained', current_db);

  -- Grant USAGE on the public schema so the role can resolve table
  -- names. Same defensive reasoning as CONNECT.
  GRANT USAGE ON SCHEMA public TO sitelayer_constrained;

  -- DML privileges on every existing table in public. The probe writes
  -- to `companies`, `projects`, and reads from `pg_roles`; granting
  -- across the schema keeps the role usable as future tables are
  -- added without requiring follow-up migrations. The role still
  -- cannot BYPASS RLS, so policy-protected tables remain scoped.
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sitelayer_constrained;

  -- USAGE on sequences so INSERTs that touch sequence-backed defaults
  -- (e.g. bigserial PKs, if any) work. The probe uses UUIDs from
  -- `gen_random_uuid()` so it doesn't strictly need this, but defense
  -- in depth.
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sitelayer_constrained;

  -- Future tables / sequences created in public default-grant the same
  -- privileges to the constrained role. This is scoped to objects
  -- created by the `sitelayer` role (the app role) which is what the
  -- migrator runs as in dev/CI.
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE sitelayer IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sitelayer_constrained';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE sitelayer IN SCHEMA public
             GRANT USAGE, SELECT ON SEQUENCES TO sitelayer_constrained';

  -- Membership in `sitelayer` so the constrained role inherits the
  -- table-owner privileges it needs to ALTER TABLE on the probe's test
  -- table (toggling RLS ENABLE/FORCE inside the test). PostgreSQL
  -- explicitly excludes BYPASSRLS / SUPERUSER from membership-based
  -- inheritance — verified empirically: a role with this grant can
  -- `ALTER TABLE projects ENABLE ROW LEVEL SECURITY` AND still has the
  -- policy applied when it SELECTs from the same table.
  --
  -- If the GRANT is not present (e.g. the `sitelayer` role doesn't
  -- exist in some weird DB), skip silently — the probe will then fail
  -- with a clear ALTER TABLE permission error, which is the right
  -- signal.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelayer') THEN
    EXECUTE 'GRANT sitelayer TO sitelayer_constrained';
  END IF;
END
$constrained_role$;

DO $constrained_role_comment$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelayer_constrained') THEN
    EXECUTE $cmt$
      COMMENT ON ROLE sitelayer_constrained IS
        'LOGIN, NOSUPERUSER, NOBYPASSRLS role used by the Phase 3 RLS runtime probe '
        'in apps/api/src/routes/rls-phase3-audit.test.ts. Created by migration 087 '
        'in non-prod databases only; tier-gated against current_database() ~ ''^sitelayer_prod''.'
    $cmt$;
  END IF;
END
$constrained_role_comment$;
