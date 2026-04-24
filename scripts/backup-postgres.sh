#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/app/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DATABASE_URL="${DATABASE_URL:-}"
DATABASE_URL_FILE="${DATABASE_URL_FILE:-}"
PG_DUMP_EXTRA_ARGS="${PG_DUMP_EXTRA_ARGS:-}"

if [ -z "$DATABASE_URL" ] && [ -n "$DATABASE_URL_FILE" ] && [ -f "$DATABASE_URL_FILE" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$DATABASE_URL_FILE" | tail -n 1 | cut -d= -f2-)"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: set DATABASE_URL or DATABASE_URL_FILE" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
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

pg_dump "${extra_args[@]}" --no-owner --no-privileges "$DATABASE_URL" | gzip -9 >"$tmp_file"
chmod 600 "$tmp_file"
mv "$tmp_file" "$backup_file"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'sitelayer-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "Backup written: $backup_file"
