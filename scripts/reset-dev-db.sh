#!/usr/bin/env bash
set -euo pipefail

# Drops every table/sequence/type in the public schema of the sitelayer_dev
# database and re-applies migrations from scratch. Used to test new migrations
# against a clean slate on the dev tier without affecting PR previews or prod.
#
# Refuses to run unless DATABASE_URL points at a database whose name contains
# `sitelayer_dev`. This is intentionally conservative — if you need to reset
# a per-PR preview schema instead, use scripts/drop-preview-schema.sh + the
# preview deploy workflow.
#
# Usage:
#   DATABASE_URL=postgres://sitelayer_dev_app:...@sitelayer-db.../sitelayer_dev?sslmode=require \
#     DATABASE_SSL_REJECT_UNAUTHORIZED=false \
#     scripts/reset-dev-db.sh
#
# Optional:
#   RESET_DEV_DB_CONFIRM=1   skip the y/N prompt
#   PSQL_DOCKER_IMAGE=...    run psql in a container (otherwise local psql)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$SCRIPT_DIR/db-common.sh"

load_database_url

db_name="$(printf '%s' "$DATABASE_URL" | sed -E 's|.*/([^/?]+).*|\1|')"
if [[ ! "$db_name" =~ sitelayer_dev ]]; then
  echo "ERROR: refusing to reset — DATABASE_URL points at \"$db_name\", expected name containing \"sitelayer_dev\"" >&2
  echo "       Set DATABASE_URL to the dev database before retrying." >&2
  exit 1
fi

# Belt-and-suspenders: refuse anything that mentions prod even if the env
# file has been mis-edited.
if [[ "$DATABASE_URL" == *"sitelayer_prod"* ]]; then
  echo "ERROR: DATABASE_URL contains 'sitelayer_prod' — refusing to run a destructive reset against it" >&2
  exit 1
fi

if [ "${RESET_DEV_DB_CONFIRM:-0}" != "1" ]; then
  echo "About to DROP and RECREATE the public schema in database: $db_name"
  printf 'Type "reset %s" to continue: ' "$db_name"
  read -r reply
  if [ "$reply" != "reset $db_name" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# Ensure migrations run against `public` after the recreate. Anything inherited
# from the caller env that pins search_path to a per-slug schema would silently
# skip the reset, so unset PGOPTIONS here and rely on Postgres's default.
unset PGOPTIONS

select_psql_runner

echo "Dropping all tables, sequences, views, and enum types in public schema of $db_name…"
# Per-object drops instead of `drop schema public cascade` so this works under
# the app role's normal DDL privileges — the managed-Postgres app role can
# CREATE/DROP objects in public but typically does NOT own the schema itself.
run_psql_query "
do \$\$
declare r record;
begin
  for r in (select tablename from pg_tables where schemaname = 'public') loop
    execute 'drop table if exists public.' || quote_ident(r.tablename) || ' cascade';
  end loop;
  for r in (select viewname from pg_views where schemaname = 'public') loop
    execute 'drop view if exists public.' || quote_ident(r.viewname) || ' cascade';
  end loop;
  for r in (select matviewname from pg_matviews where schemaname = 'public') loop
    execute 'drop materialized view if exists public.' || quote_ident(r.matviewname) || ' cascade';
  end loop;
  for r in (select sequence_name from information_schema.sequences where sequence_schema = 'public') loop
    execute 'drop sequence if exists public.' || quote_ident(r.sequence_name) || ' cascade';
  end loop;
  for r in (
    select t.typname
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e'
  ) loop
    execute 'drop type if exists public.' || quote_ident(r.typname) || ' cascade';
  end loop;
end \$\$;
"

echo "Re-applying migrations from docker/postgres/init/…"
PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-}" ENV_FILE="${ENV_FILE:-.env}" "$SCRIPT_DIR/migrate-db.sh"

echo "Verifying schema…"
PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-}" ENV_FILE="${ENV_FILE:-.env}" "$SCRIPT_DIR/check-db-schema.sh"

echo "Done. sitelayer_dev public schema is at the head of docker/postgres/init/*.sql."
