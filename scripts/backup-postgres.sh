#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/app/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DATABASE_URL="${DATABASE_URL:-}"
DATABASE_URL_FILE="${DATABASE_URL_FILE:-}"
PG_DUMP_EXTRA_ARGS="${PG_DUMP_EXTRA_ARGS:-}"
PG_DUMP_DOCKER_IMAGE="${PG_DUMP_DOCKER_IMAGE:-}"

source "$SCRIPT_DIR/db-common.sh"

if [ -z "$DATABASE_URL" ] && [ -n "$DATABASE_URL_FILE" ] && [ -f "$DATABASE_URL_FILE" ]; then
  DATABASE_URL="$(read_env_value "$DATABASE_URL_FILE" DATABASE_URL)"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: set DATABASE_URL or DATABASE_URL_FILE" >&2
  exit 1
fi

# pg_dump must read row-security-protected tables (audit_events,
# mutation_outbox, sync_events, workflow_event_log — RLS ENABLED via
# migration 073). Postgres requires `SET row_security = off` for the
# dump session; superuser / BYPASSRLS roles are allowed to set it.
# DO Managed Postgres provisions the deploy user with the required
# privileges. PGOPTIONS is the standard way to inject the GUC into
# the pg_dump connection. Without this, pg_dump fails on the first
# RLS-protected table mid-dump (post-073 prod symptom).
PG_DUMP_PGOPTIONS="${PG_DUMP_PGOPTIONS:--c row_security=off}"

if [ -n "$PG_DUMP_DOCKER_IMAGE" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is required when PG_DUMP_DOCKER_IMAGE is set" >&2
    exit 1
  fi
  pg_dump_cmd=(docker run --rm --network host -e "PGOPTIONS=$PG_DUMP_PGOPTIONS" "$PG_DUMP_DOCKER_IMAGE" pg_dump)
elif command -v pg_dump >/dev/null 2>&1; then
  pg_dump_cmd=(env "PGOPTIONS=$PG_DUMP_PGOPTIONS" pg_dump)
else
  echo "ERROR: pg_dump is required" >&2
  exit 1
fi

if ! command -v gzip >/dev/null 2>&1; then
  echo "ERROR: gzip is required" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_file="$BACKUP_DIR/.sitelayer-$timestamp.sql.gz.tmp"
backup_file="$BACKUP_DIR/sitelayer-$timestamp.sql.gz"

read -r -a extra_args <<<"$PG_DUMP_EXTRA_ARGS"

"${pg_dump_cmd[@]}" "${extra_args[@]}" --no-owner --no-privileges "$DATABASE_URL" | gzip -9 >"$tmp_file"
chmod 600 "$tmp_file"
mv "$tmp_file" "$backup_file"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'sitelayer-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "Backup written: $backup_file"
