-- 016_restore_constrained_role.sql
--
-- RESTORE the `sitelayer_constrained` LOGIN role used by the RLS runtime
-- probes (`apps/api/src/routes/rls-phase3-audit.test.ts`,
-- `rls-force-close-gaps.test.ts`, `company-settings.test.ts`).
--
-- History: the role was originally provisioned by migration
-- `087_constrained_role_for_rls_probe.sql`. The 2026-06-02 migration squash
-- (152 files -> 000_baseline.sql) deleted 087 WITHOUT folding the role DDL
-- into the baseline (pg_dump does not emit roles), so a fresh database since
-- the squash has had no way to grow the role — and the runtime RLS probes
-- (gated on CONSTRAINED_DB_URL) could never run. This migration restores the
-- pre-squash role, adapted to the current schema. Databases migrated before
-- the squash may STILL have the role; every statement below is idempotent
-- against that (see "Idempotency").
--
-- The probes must connect as a NON-superuser, NON-BYPASSRLS role to prove
-- that the company_isolation policies baked into 000_baseline.sql actually
-- scope reads/writes to the bound `app.company_id` GUC. The app role
-- `sitelayer` is the table owner in dev/CI/prod and is BYPASSRLS in dev/CI
-- (postgres:18-alpine's POSTGRES_USER attribute) and table owner (no FORCE
-- bypass) in prod — either way, querying as `sitelayer` bypasses RLS and the
-- probe is a no-op.
--
-- ## Role design (unchanged from 087)
--
--   - LOGIN with a deterministic password derived from the role name so the
--     verify gate can compute `CONSTRAINED_DB_URL` by substituting the user
--     in `DATABASE_URL`. The password is only meaningful against local /
--     throwaway Postgres — the role is never created in prod (tier gate
--     below).
--   - NOSUPERUSER and NOBYPASSRLS — both required for the probe to observe
--     RLS enforcement. NOBYPASSRLS is explicit so a future ALTER ROLE that
--     flips BYPASSRLS is louder.
--   - INHERIT (default) + `GRANT sitelayer TO sitelayer_constrained` gives
--     the role the table-owner privileges it needs to `ALTER TABLE projects
--     ENABLE/FORCE/DISABLE ROW LEVEL SECURITY` inside the probe. BYPASSRLS
--     is NOT inherited via membership (PostgreSQL docs), so the constrained
--     role can ALTER the table without bypassing the policy it just enabled.
--
-- ## Tier gating (load-bearing)
--
-- This role MUST NOT exist in prod: an extra LOGIN role with a known
-- password is a credential the operator would have to rotate alongside the
-- app role. The DO block checks `current_database()` against the prod
-- database name(s) — `sitelayer_prod` and variants matching
-- `^sitelayer_prod(_|$)` — and is a no-op there.
--
--    database                     create role?  rationale
--    sitelayer (local docker)     yes           dev container, verify gate
--    sitelayer_dev                yes           preview-droplet dev DB
--    sitelayer_preview            yes           preview-droplet preview DB
--    sitelayer_demo               yes           demo tier (non-prod)
--    sitelayer_prod               NO            prod; runtime probe not run here
--    sitelayer_prod_ro            NO            prod read-only mirror
--
-- On DigitalOcean Managed Postgres the migrator runs as the app role, which
-- lacks CREATEROLE; the EXCEPTION handler below turns that into a NOTICE +
-- clean skip so deploys never block (the probes simply stay skipped there).
-- Deploy scripts additionally filter this file out of MIGRATION_FILES on
-- managed tiers (scripts/deploy-preview.sh, scripts/reset-tier-db.sh) — same
-- belt-and-suspenders as 087. scripts/deploy.sh's demo-seed path runs the
-- full migration set (its 087-ghost filter was removed 2026-06-12) and relies
-- on the insufficient_privilege self-skip below.
--
-- ## Idempotency
--
-- Re-running is safe, including on pre-squash databases where 087 already
-- created the role:
--   - the DO block guards CREATE ROLE on pg_roles membership and re-asserts
--     the critical attributes when the role already exists;
--   - repeated GRANTs and ALTER DEFAULT PRIVILEGES are no-ops.
--
-- ## How the verify gate uses this
--
-- scripts/verify-local.sh's integration stage applies migrations to a
-- throwaway superuser-owned Postgres (so this CREATE ROLE succeeds), then
-- verifies the role exists with NOBYPASSRLS and exports
--   CONSTRAINED_DB_URL=postgres://sitelayer_constrained:sitelayer_constrained@localhost:<port>/sitelayer
-- into the api vitest run, un-skipping the runtime probes. See
-- docs/SECURITY_RLS.md.

DO $constrained_role$
DECLARE
  current_db text := current_database();
  is_prod boolean := current_db ~ '^sitelayer_prod(_|$)';
BEGIN
  IF is_prod THEN
    RAISE NOTICE 'constrained role: skipping in prod database %', current_db;
    RETURN;
  END IF;

  -- Create the role if it doesn't exist. Password matches role name so the
  -- gate can synthesize CONSTRAINED_DB_URL by string-substituting the user
  -- in DATABASE_URL. Not a meaningful secret: only valid against local /
  -- throwaway Postgres, and the role is NOSUPERUSER + NOBYPASSRLS.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelayer_constrained') THEN
    EXECUTE 'CREATE ROLE sitelayer_constrained LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ''sitelayer_constrained''';
    RAISE NOTICE 'constrained role: created sitelayer_constrained in database %', current_db;
  ELSE
    -- Defensive: re-assert the critical attributes in case a prior operator
    -- flipped them. NOBYPASSRLS is the load-bearing one — if the role ever
    -- gains BYPASSRLS the runtime probe becomes a silently-passing no-op.
    EXECUTE 'ALTER ROLE sitelayer_constrained NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
    RAISE NOTICE 'constrained role: re-asserted attributes on existing sitelayer_constrained in database %', current_db;
  END IF;

  -- Grant CONNECT on the current database. New roles get this by default via
  -- PUBLIC, but DigitalOcean Managed Postgres revokes CONNECT on PUBLIC in
  -- some cluster configurations, so be explicit.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO sitelayer_constrained', current_db);

  -- USAGE on the public schema so the role can resolve table names.
  GRANT USAGE ON SCHEMA public TO sitelayer_constrained;

  -- DML privileges on every existing table in public. The probes write to
  -- `companies`, `projects`, `company_settings`, the pricing-override and
  -- takeoff tables, etc.; granting across the schema keeps the role usable
  -- as future tables are added without follow-up migrations. The role still
  -- cannot BYPASS RLS, so policy-protected tables remain scoped.
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sitelayer_constrained;

  -- USAGE on sequences so INSERTs that touch sequence-backed defaults work.
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sitelayer_constrained;

  -- Future tables / sequences created by the app role default-grant the same
  -- privileges to the constrained role.
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE sitelayer IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sitelayer_constrained';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE sitelayer IN SCHEMA public
             GRANT USAGE, SELECT ON SEQUENCES TO sitelayer_constrained';

  -- Membership in `sitelayer` so the constrained role inherits the
  -- table-owner privileges it needs to ALTER TABLE on the probe's test table
  -- (toggling RLS ENABLE/FORCE inside the test). PostgreSQL excludes
  -- BYPASSRLS / SUPERUSER from membership-based inheritance, so the policy
  -- still applies when the constrained role SELECTs.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelayer') THEN
    EXECUTE 'GRANT sitelayer TO sitelayer_constrained';
  END IF;
EXCEPTION
  -- Managed Postgres (DigitalOcean) migrator users are not granted
  -- CREATEROLE. The runtime probe is a local/verify-gate feature; on
  -- environments where the migrator can't provision the role, skip cleanly
  -- with a NOTICE rather than failing the whole migration (which would block
  -- every deploy). The probe tests stay skipped on those environments
  -- (CONSTRAINED_DB_URL is only exported by the verify gate against its
  -- throwaway Postgres, where the migrator IS the superuser).
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'constrained role: skipping in database % - migrator lacks CREATEROLE/GRANT privilege (expected on Managed Postgres; RLS runtime probe will skip)', current_db;
    RETURN;
END
$constrained_role$;

DO $constrained_role_comment$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelayer_constrained') THEN
    EXECUTE $cmt$
      COMMENT ON ROLE sitelayer_constrained IS
        'LOGIN, NOSUPERUSER, NOBYPASSRLS role used by the RLS runtime probes '
        '(apps/api/src/routes/rls-phase3-audit.test.ts and friends). Restored by '
        'migration 016 after the 2026-06-02 baseline squash dropped migration 087. '
        'Created in non-prod databases only; tier-gated against current_database() ~ ''^sitelayer_prod''.'
    $cmt$;
  END IF;
END
$constrained_role_comment$;
