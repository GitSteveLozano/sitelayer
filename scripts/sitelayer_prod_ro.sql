-- Creates the sitelayer_prod_ro role for preview/dev stacks that opt in to
-- the read-prod-ro feature flag. All writes are blocked at the Postgres
-- permission level — app-level bugs cannot accidentally mutate prod data.
--
-- Run against the prod cluster (defaultdb is fine; role is cluster-scoped):
--   psql "$PROD_DATABASE_URL" -v password='REPLACE_ME' -f scripts/sitelayer_prod_ro.sql
--
-- After running, the preview stack's DATABASE_URL_PROD_RO looks like:
--   postgres://sitelayer_prod_ro:<password>@<prod-host>:25060/sitelayer_prod?sslmode=require

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE sitelayer_prod_ro LOGIN PASSWORD %L', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelayer_prod_ro')
\gexec

SELECT format('ALTER ROLE sitelayer_prod_ro WITH PASSWORD %L', :'password')
\gexec

-- Only the prod DB. If you ever spin up new databases, grant per-db explicitly.
GRANT CONNECT ON DATABASE sitelayer_prod TO sitelayer_prod_ro;

\connect sitelayer_prod

GRANT USAGE ON SCHEMA public TO sitelayer_prod_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sitelayer_prod_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO sitelayer_prod_ro;

-- Future tables inherit read-only access automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO sitelayer_prod_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO sitelayer_prod_ro;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelayer_prod_app') THEN
    BEGIN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE sitelayer_prod_app IN SCHEMA public GRANT SELECT ON TABLES TO sitelayer_prod_ro';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE sitelayer_prod_app IN SCHEMA public GRANT SELECT ON SEQUENCES TO sitelayer_prod_ro';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'skipping default privileges for sitelayer_prod_app; rerun as that role or a member';
    END;
  END IF;
END
$$;

-- Sanity check — should return a row count, not an error.
SELECT count(*) AS projects_visible_to_ro FROM projects;
