#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: DATABASE_URL=<target-url> $0 <backup.sql|backup.sql.gz>" >&2
  exit 1
fi

DATABASE_URL="${DATABASE_URL:-}"
backup_file="$1"

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: set DATABASE_URL to the restore target" >&2
  exit 1
fi

if [ ! -f "$backup_file" ]; then
  echo "ERROR: backup file not found: $backup_file" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is required" >&2
  exit 1
fi

case "$backup_file" in
  *.gz)
    if ! command -v gzip >/dev/null 2>&1; then
      echo "ERROR: gzip is required for compressed backups" >&2
      exit 1
    fi
    gzip -dc "$backup_file" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
    ;;
  *)
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$backup_file"
    ;;
esac

echo "Restore applied from: $backup_file"
