#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_DIR="${MIGRATION_DIR:-docker/postgres/init}"

cd "$REPO_ROOT"
source "$SCRIPT_DIR/db-common.sh"

load_database_url
select_psql_runner

if [ ! -d "$MIGRATION_DIR" ]; then
  echo "ERROR: migration directory not found: $MIGRATION_DIR" >&2
  exit 1
fi

if [ -n "${MIGRATION_FILES:-}" ]; then
  read -r -a migration_files <<<"$MIGRATION_FILES"
else
  mapfile -t migration_files < <(find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' | sort)
fi

if [ "${#migration_files[@]}" -eq 0 ]; then
  echo "ERROR: no migration files found in $MIGRATION_DIR" >&2
  exit 1
fi

for migration_file in "${migration_files[@]}"; do
  if [ ! -f "$migration_file" ]; then
    echo "ERROR: migration file not found: $migration_file" >&2
    exit 1
  fi

  echo "Applying migration: $migration_file"
  run_psql_file "$migration_file"
done

echo "Database migrations applied successfully"
