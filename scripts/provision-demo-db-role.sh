#!/usr/bin/env bash
set -euo pipefail

# Provision the least-privilege `sitelayer_demo_app` Postgres role for the demo
# tier on the shared managed cluster `sitelayer-db`.
#
# WHY THIS EXISTS
#   The demo tier currently connects to `sitelayer_demo` as `doadmin` — the
#   cluster superuser. Because `sitelayer-db` also hosts `sitelayer_prod`, that
#   credential is a cluster-wide blast-radius risk: a leaked demo DATABASE_URL
#   could read or mutate prod at the SQL layer, bypassing the app-level tier
#   guard (see docs/steve-handoff/demo-design/R5-security-isolation.md §1.3/§4).
#   This script provisions a scoped role that can CONNECT to `sitelayer_demo`
#   only, with exactly the table/sequence DML the app needs and nothing more.
#
# WHAT IT DOES (idempotent — safe to re-run)
#   1. CREATE ROLE sitelayer_demo_app LOGIN (if not exists), password from env.
#   2. GRANT CONNECT ON DATABASE sitelayer_demo.
#   3. Best-effort REVOKE CONNECT ON DATABASE sitelayer_prod (no-op if the admin
#      role can't see/touch sitelayer_prod, e.g. on managed PG).
#   4. In sitelayer_demo: GRANT USAGE on schema public, SELECT/INSERT/UPDATE/
#      DELETE on all existing tables, USAGE/SELECT/UPDATE on all sequences.
#   5. ALTER DEFAULT PRIVILEGES so future migration-created objects inherit the
#      same grants — both for the admin role AND (best-effort) for the object
#      OWNER role (DEMO_DB_OWNER_ROLE), since on managed PG migrations run as a
#      non-superuser owner whose default privileges doadmin cannot set.
#   6. Print a verification block of the role's grant COUNTS (never the password).
#
# REQUIRED ENV
#   ADMIN_DATABASE_URL    Admin/superuser connection string (e.g. the doadmin
#                         URI). Read from env only — NEVER hardcoded or printed.
#                         The database in this URL is the admin entrypoint; the
#                         script \connect's to sitelayer_demo itself.
#   DEMO_DB_APP_PASSWORD  Password to set on sitelayer_demo_app. Required unless
#                         --check. Never echoed.
#
# OPTIONAL ENV
#   DEMO_DB_ROLE          Role name to provision (default: sitelayer_demo_app).
#   DEMO_DB_NAME          Demo database name      (default: sitelayer_demo).
#   PROD_DB_NAME          Prod database name to fence off (default: sitelayer_prod).
#   DEMO_DB_OWNER_ROLE    The role that OWNS the demo tables (i.e. runs the
#                         migrations). On managed PG this is the cluster's
#                         default user (e.g. doadmin) unless migrations connect
#                         as a different role. Default: derived from the admin
#                         URL's username. ALTER DEFAULT PRIVILEGES FOR ROLE
#                         <owner> is what makes FUTURE tables inherit grants.
#   PSQL_DOCKER_IMAGE     If psql is not on PATH, run it in this image
#                         (default fallback: postgres:18-alpine). Set explicitly
#                         to force the docker runner.
#   PSQL_DOCKER_NETWORK   Docker network for the psql container (optional).
#
# USAGE
#   # Provision / re-sync the role and grants:
#   ADMIN_DATABASE_URL='postgres://doadmin:...@sitelayer-db-...:25060/defaultdb?sslmode=require' \
#   DEMO_DB_APP_PASSWORD='<generated>' \
#     scripts/provision-demo-db-role.sh
#
#   # Report current grants only (no writes, no password needed):
#   ADMIN_DATABASE_URL='postgres://doadmin:...@.../defaultdb?sslmode=require' \
#     scripts/provision-demo-db-role.sh --check
#
# After a successful run, point the demo tier at the new role and bounce it
# (see docs/DEMO_ENVIRONMENT.md → "Database story"):
#   DATABASE_URL=postgres://sitelayer_demo_app:<password>@<host>:25060/sitelayer_demo?sslmode=require
#
# This script PRODUCES the provisioning; it does not deploy. The operator runs
# it once against the cluster, then updates /app/previews/.env.demo.shared.

MODE="provision"

usage() {
  # Print the leading comment block (the documentation header), stripping the
  # '# ' prefix. Stops at the first non-comment, non-blank line.
  awk '
    NR <= 2 { next }                 # skip shebang + set -euo pipefail
    /^#/    { sub(/^# ?/, ""); print; next }
    /^$/    { print ""; next }
    { exit }
  ' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --check)
      MODE="check"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "Usage: $0 [--check]" >&2
      exit 2
      ;;
  esac
done

DEMO_DB_ROLE="${DEMO_DB_ROLE:-sitelayer_demo_app}"
DEMO_DB_NAME="${DEMO_DB_NAME:-sitelayer_demo}"
PROD_DB_NAME="${PROD_DB_NAME:-sitelayer_prod}"

if [ -z "${ADMIN_DATABASE_URL:-}" ]; then
  echo "ERROR: ADMIN_DATABASE_URL is required (admin/superuser connection string, e.g. the doadmin URI)." >&2
  echo "       It is read from the environment only and is never printed." >&2
  exit 1
fi

# Validate identifier-shaped inputs so they can be safely interpolated into DDL.
for ident_pair in \
  "DEMO_DB_ROLE=$DEMO_DB_ROLE" \
  "DEMO_DB_NAME=$DEMO_DB_NAME" \
  "PROD_DB_NAME=$PROD_DB_NAME"; do
  ident_name="${ident_pair%%=*}"
  ident_value="${ident_pair#*=}"
  if [[ ! "$ident_value" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "ERROR: invalid $ident_name: '$ident_value' (must match ^[a-z_][a-z0-9_]*\$)" >&2
    exit 1
  fi
done

# Derive the object-owner role (whose default privileges we must also set so
# FUTURE migration-created tables inherit grants on managed PG) from the admin
# URL's username unless explicitly overridden. Strip scheme + any credentials,
# take the part before ':' or '@'.
derive_admin_user() {
  local url="$1"
  local rest="${url#*://}"
  local userinfo="${rest%%@*}"
  # userinfo is "user" or "user:password"; take the user portion.
  printf '%s' "${userinfo%%:*}"
}

DEMO_DB_OWNER_ROLE="${DEMO_DB_OWNER_ROLE:-$(derive_admin_user "$ADMIN_DATABASE_URL")}"
if [ -z "$DEMO_DB_OWNER_ROLE" ]; then
  DEMO_DB_OWNER_ROLE="doadmin"
fi
if [[ ! "$DEMO_DB_OWNER_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "ERROR: invalid DEMO_DB_OWNER_ROLE: '$DEMO_DB_OWNER_ROLE' (must match ^[a-z_][a-z0-9_]*\$)" >&2
  exit 1
fi

if [ "$MODE" = "provision" ] && [ -z "${DEMO_DB_APP_PASSWORD:-}" ]; then
  echo "ERROR: DEMO_DB_APP_PASSWORD is required to provision the role." >&2
  echo "       Generate one (e.g. 'openssl rand -base64 24'), export it, and re-run." >&2
  echo "       It is read from the environment only and is never printed." >&2
  echo "       (Use --check to report current grants without setting a password.)" >&2
  exit 1
fi

# --- psql runner selection (mirrors scripts/db-common.sh) -------------------

PSQL_RUNNER=""
select_psql_runner() {
  if [ -n "${PSQL_DOCKER_IMAGE:-}" ] || [ -n "${PSQL_DOCKER_NETWORK:-}" ]; then
    PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}"
    if ! command -v docker >/dev/null 2>&1; then
      echo "ERROR: docker is required when PSQL_DOCKER_IMAGE or PSQL_DOCKER_NETWORK is set" >&2
      exit 1
    fi
    PSQL_RUNNER="docker"
    return
  fi

  if command -v psql >/dev/null 2>&1; then
    PSQL_RUNNER="local"
    return
  fi

  PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}"
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: psql is required, or docker must be installed for the PSQL_DOCKER_IMAGE fallback" >&2
    exit 1
  fi
  PSQL_RUNNER="docker"
}

# Run a psql script supplied on stdin. We pass the password as a psql variable
# (-v) read from the environment so it never appears on a command line, in
# `ps`, or in this file. The connection string comes in via ADMIN_DATABASE_URL
# (env) so it never lands on a visible argv either.
run_psql_stdin() {
  case "$PSQL_RUNNER" in
    local)
      PGAPPNAME=provision-demo-db-role \
        psql -v ON_ERROR_STOP=1 \
        -v "demo_role=$DEMO_DB_ROLE" \
        -v "demo_db=$DEMO_DB_NAME" \
        -v "prod_db=$PROD_DB_NAME" \
        -v "owner_role=$DEMO_DB_OWNER_ROLE" \
        -v "app_password=${DEMO_DB_APP_PASSWORD:-}" \
        "$ADMIN_DATABASE_URL" -f -
      ;;
    docker)
      local docker_args=(docker run --rm -i)
      if [ -n "${PSQL_DOCKER_NETWORK:-}" ]; then
        docker_args+=(--network "$PSQL_DOCKER_NETWORK")
      fi
      # Secrets travel as container env, never as argv.
      docker_args+=(
        -e "PGAPPNAME=provision-demo-db-role"
        -e "ADMIN_DATABASE_URL=$ADMIN_DATABASE_URL"
        -e "DEMO_DB_APP_PASSWORD=${DEMO_DB_APP_PASSWORD:-}"
        "$PSQL_DOCKER_IMAGE" psql
      )
      "${docker_args[@]}" -v ON_ERROR_STOP=1 \
        -v "demo_role=$DEMO_DB_ROLE" \
        -v "demo_db=$DEMO_DB_NAME" \
        -v "prod_db=$PROD_DB_NAME" \
        -v "owner_role=$DEMO_DB_OWNER_ROLE" \
        -v "app_password=$DEMO_DB_APP_PASSWORD" \
        "$ADMIN_DATABASE_URL" -f -
      ;;
    *)
      echo "ERROR: select_psql_runner must run before run_psql_stdin" >&2
      exit 1
      ;;
  esac
}

select_psql_runner

# --- the verification block (shared by both modes) -------------------------
#
# Reports COUNTS only — never the password. Run while \connect'ed to the demo
# database so information_schema reflects the demo schema.
read -r -d '' VERIFY_SQL <<'SQL' || true
\echo '--- verification (counts only; no secrets printed) ---'
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'demo_role') AS role_exists,
       (SELECT rolcanlogin FROM pg_roles WHERE rolname = :'demo_role') AS can_login;

SELECT has_database_privilege(:'demo_role', :'demo_db', 'CONNECT') AS connect_on_demo;

-- Counts use has_table_privilege / has_sequence_privilege (effective grants),
-- which correctly reflect SELECT/UPDATE on sequences too (the information_schema
-- usage view only reports USAGE). "*_total" shows how many objects exist, so a
-- granted count < total means some object is NOT covered (re-run after new
-- migrations create tables/sequences).
SELECT
  count(*) FILTER (WHERE has_table_privilege(:'demo_role', c.oid, 'SELECT')) AS tables_select,
  count(*) FILTER (WHERE has_table_privilege(:'demo_role', c.oid, 'INSERT')) AS tables_insert,
  count(*) FILTER (WHERE has_table_privilege(:'demo_role', c.oid, 'UPDATE')) AS tables_update,
  count(*) FILTER (WHERE has_table_privilege(:'demo_role', c.oid, 'DELETE')) AS tables_delete,
  count(*) AS tables_total
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public';

SELECT
  count(*) FILTER (WHERE has_sequence_privilege(:'demo_role', c.oid, 'USAGE'))  AS sequences_usage,
  count(*) FILTER (WHERE has_sequence_privilege(:'demo_role', c.oid, 'SELECT')) AS sequences_select,
  count(*) FILTER (WHERE has_sequence_privilege(:'demo_role', c.oid, 'UPDATE')) AS sequences_update,
  count(*) AS sequences_total
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname = 'public';

\echo '--- default privileges configured for FUTURE objects (should be > 0 for full coverage) ---'
SELECT count(*) AS default_privilege_rows
FROM pg_default_acl d
WHERE EXISTS (
  SELECT 1 FROM aclexplode(d.defaclacl) e
  JOIN pg_roles g ON g.oid = e.grantee
  WHERE g.rolname = :'demo_role'
);
SQL

if [ "$MODE" = "check" ]; then
  echo "[provision-demo-db-role] --check: reporting current grants for role '$DEMO_DB_ROLE' in '$DEMO_DB_NAME' (no writes)."
  run_psql_stdin <<SQL
\set ON_ERROR_STOP on
\connect :"demo_db"
$VERIFY_SQL
SQL
  exit 0
fi

echo "[provision-demo-db-role] provisioning role '$DEMO_DB_ROLE' (owner-role for default privs: '$DEMO_DB_OWNER_ROLE')."
echo "[provision-demo-db-role] admin URL + password are taken from the environment and are never printed."

run_psql_stdin <<SQL
\set ON_ERROR_STOP on

-- 1) Create the login role if absent, then (re)set its password every run so
--    the script is idempotent and a rotation is just a re-run.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'demo_role', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'demo_role')
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'demo_role', :'app_password')
\gexec

-- 2) Demo DB connect.
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'demo_db', :'demo_role')
\gexec

-- Stage the identifiers into session GUCs so the DO blocks below can read them
-- with current_setting(). psql ':var' interpolation does NOT happen inside a
-- dollar-quoted (\$\$) body, so we cannot use :'prod_db' directly there.
SELECT set_config('demo.demo_role', :'demo_role', false),
       set_config('demo.prod_db', :'prod_db', false),
       set_config('demo.owner_role', :'owner_role', false);

-- 3) Fence off prod. Two distinct facts matter here:
--    (a) We never GRANT this role CONNECT on prod, and we REVOKE it explicitly
--        as belt-and-suspenders. On a managed cluster the admin role may not be
--        able to touch sitelayer_prod's ACL; guard so this is a no-op rather
--        than a hard failure.
--    (b) IMPORTANT: a freshly-created Postgres database grants CONNECT to
--        PUBLIC by default, so REVOKE ... FROM <role> alone does NOT actually
--        block the demo role — it can still connect to prod via the PUBLIC
--        grant. The real fix is REVOKE CONNECT ON DATABASE <prod> FROM PUBLIC,
--        but that changes PROD's ACL cluster-wide (it affects every role that
--        relies on the PUBLIC connect), so this demo-scoped script does NOT
--        apply it silently. Instead it DETECTS the residual PUBLIC grant and
--        prints a loud WARNING with the exact statement for the operator to run
--        deliberately (incident-style, operator-approved — see
--        docs/DEMO_ENVIRONMENT.md). Prod's own roles connect by explicit grant,
--        not via PUBLIC, so revoking PUBLIC is safe — but it is a prod change
--        and must be the operator's call.
DO \$\$
DECLARE
  v_prod_db   text := current_setting('demo.prod_db');
  v_demo_role text := current_setting('demo.demo_role');
  v_public_connect boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = v_prod_db) THEN
    BEGIN
      EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', v_prod_db, v_demo_role);
      RAISE NOTICE 'revoked CONNECT on % from % (defence-in-depth)', v_prod_db, v_demo_role;
    EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
      RAISE NOTICE 'skipped REVOKE CONNECT on % (insufficient privilege / not visible); role was never granted it here', v_prod_db;
    END;

    -- Detect the residual PUBLIC CONNECT that lets ANY role reach prod.
    SELECT has_database_privilege('public', v_prod_db, 'CONNECT') INTO v_public_connect;
    IF v_public_connect THEN
      RAISE WARNING 'PUBLIC still has CONNECT on % — % (and every role) can STILL connect to prod despite the REVOKE above.', v_prod_db, v_demo_role;
      RAISE WARNING 'To truly fence off prod, run as an admin (operator-approved, prod-wide change):';
      RAISE WARNING '    REVOKE CONNECT ON DATABASE % FROM PUBLIC;', v_prod_db;
      RAISE WARNING '(prod''s own roles connect via explicit grant, so this is safe; it is omitted here because it changes PROD''s ACL.)';
    ELSE
      RAISE NOTICE 'PUBLIC has no CONNECT on % — % is fully fenced off from prod.', v_prod_db, v_demo_role;
    END IF;
  ELSE
    RAISE NOTICE 'database % not visible from this connection; nothing to revoke (role was never granted CONNECT here)', v_prod_db;
  END IF;
END
\$\$;

-- 4) Switch into the demo database and grant the least set the app needs.
--    \connect resets session GUCs, so re-stage them after reconnecting.
\connect :"demo_db"

SELECT set_config('demo.demo_role', :'demo_role', false),
       set_config('demo.owner_role', :'owner_role', false);

GRANT USAGE ON SCHEMA public TO :"demo_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"demo_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"demo_role";

-- 5) Future migration-created objects must inherit the same grants. Default
--    privileges are keyed by the role that OWNS (creates) the object — they do
--    NOT apply retroactively and they only fire for objects created by the
--    specified role. We set them two ways:
--      (a) for the current admin role (covers objects this admin later creates), and
--      (b) FOR ROLE <owner_role> — the role migrations actually run as. On
--          managed PG, doadmin generally CAN set default privileges for the
--          object owner because it is a member of that role; if not, this
--          block degrades to a NOTICE and the operator must re-run the
--          ALTER DEFAULT PRIVILEGES FOR ROLE <owner> ... statements while
--          connected AS the owner (or a member of it).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"demo_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"demo_role";

DO \$\$
DECLARE
  v_owner     text := current_setting('demo.owner_role');
  v_demo_role text := current_setting('demo.demo_role');
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    v_owner, v_demo_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
    v_owner, v_demo_role);
  RAISE NOTICE 'set default privileges FOR ROLE % so future objects inherit grants', v_owner;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could NOT set default privileges FOR ROLE % (insufficient privilege).', v_owner;
  RAISE NOTICE 'Re-run these two statements while connected AS % (or a member of it):', v_owner;
  RAISE NOTICE '  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO %;', v_demo_role;
  RAISE NOTICE '  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO %;', v_demo_role;
END
\$\$;

-- 6) Verification (counts only).
$VERIFY_SQL
SQL

echo "[provision-demo-db-role] done. Role '$DEMO_DB_ROLE' provisioned against '$DEMO_DB_NAME'."
echo "[provision-demo-db-role] next: set the demo DATABASE_URL to this role and bounce demo (see docs/DEMO_ENVIRONMENT.md)."
