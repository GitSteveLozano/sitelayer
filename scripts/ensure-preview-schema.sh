#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$SCRIPT_DIR/db-common.sh"

load_database_url

preview_schema="${PREVIEW_DB_SCHEMA:-$(read_env_value "${ENV_FILE:-.env}" PREVIEW_DB_SCHEMA)}"
if [ -z "$preview_schema" ]; then
  echo "ERROR: set PREVIEW_DB_SCHEMA or provide ENV_FILE with PREVIEW_DB_SCHEMA" >&2
  exit 1
fi

validate_db_schema_name "$preview_schema"
select_psql_runner

run_psql_query "create extension if not exists pgcrypto with schema public;"
run_psql_query "create schema if not exists \"$preview_schema\";"
echo "Preview database schema ready: $preview_schema"
