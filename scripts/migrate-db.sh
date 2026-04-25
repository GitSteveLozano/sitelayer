#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_DIR="${MIGRATION_DIR:-docker/postgres/init}"
MIGRATION_LEDGER_TABLE="${MIGRATION_LEDGER_TABLE:-schema_migrations}"
MIGRATION_LOCK_KEY="${MIGRATION_LOCK_KEY:-sitelayer.schema_migrations}"

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

checksum_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  echo "ERROR: sha256sum or shasum is required for migration checksums" >&2
  exit 1
}

validate_ledger_table_name() {
  local table="$1"
  if [[ ! "$table" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "ERROR: invalid migration ledger table name: $table" >&2
    exit 1
  fi
}

apply_migration() {
  local migration_file="$1"
  local migration_name
  local migration_checksum
  local wrapper
  local wrapper_psql_path

  migration_name="$(basename "$migration_file")"
  migration_checksum="$(checksum_file "$migration_file")"
  wrapper="$(mktemp "$REPO_ROOT/.migration-wrapper.XXXXXX.sql")"
  wrapper_psql_path="${wrapper#"$REPO_ROOT/"}"

  cat >"$wrapper" <<EOF
\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(:'migration_lock_key', 0));
CREATE TABLE IF NOT EXISTS $MIGRATION_LEDGER_TABLE (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SELECT EXISTS (
  SELECT 1 FROM $MIGRATION_LEDGER_TABLE
  WHERE name = :'migration_name' AND checksum <> :'migration_checksum'
) AS migration_changed
\\gset
\\if :migration_changed
  \\echo ERROR: migration :'migration_name' was already applied with a different checksum
  \\quit 3
\\endif
SELECT EXISTS (
  SELECT 1 FROM $MIGRATION_LEDGER_TABLE
  WHERE name = :'migration_name'
) AS migration_applied
\\gset
\\if :migration_applied
  \\echo Skipping already-applied migration :'migration_name'
\\else
  \\echo Applying migration :'migration_name'
  \\i $migration_file
  INSERT INTO $MIGRATION_LEDGER_TABLE (name, checksum)
  VALUES (:'migration_name', :'migration_checksum');
\\endif
COMMIT;
EOF

  if run_psql_file_with_vars "$wrapper_psql_path" \
    "migration_lock_key=$MIGRATION_LOCK_KEY" \
    "migration_name=$migration_name" \
    "migration_checksum=$migration_checksum"; then
    rm -f "$wrapper"
  else
    local status=$?
    rm -f "$wrapper"
    return "$status"
  fi
}

validate_ledger_table_name "$MIGRATION_LEDGER_TABLE"

for migration_file in "${migration_files[@]}"; do
  if [ ! -f "$migration_file" ]; then
    echo "ERROR: migration file not found: $migration_file" >&2
    exit 1
  fi

  apply_migration "$migration_file"
done

echo "Database migrations applied successfully"
