#!/usr/bin/env bash
# Monthly restore drill.
#
# Spins up a throwaway postgres:18-alpine container, restores the most
# recent local pg_dump into it, runs sanity queries (row counts +
# recency check), tears down the scratch container, and prints PASS/FAIL.
#
# Usage:
#   bash scripts/restore-drill.sh
#
# Env overrides:
#   BACKUP_DIR              default: /app/backups/postgres
#   BACKUP_NAME_GLOB        default: sitelayer-*.sql.gz
#   PG_IMAGE                default: postgres:18-alpine
#   SCRATCH_CONTAINER       default: sitelayer-restore-drill-<epoch>
#   SCRATCH_DB              default: sitelayer_drill
#   RECENCY_HOURS           default: 48
#   SCRATCH_BOOT_TIMEOUT    default: 60 (seconds to wait for pg_isready)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/app/backups/postgres}"
BACKUP_NAME_GLOB="${BACKUP_NAME_GLOB:-sitelayer-*.sql.gz}"
PG_IMAGE="${PG_IMAGE:-postgres:18-alpine}"
SCRATCH_CONTAINER="${SCRATCH_CONTAINER:-sitelayer-restore-drill-$(date +%s)}"
SCRATCH_DB="${SCRATCH_DB:-sitelayer_drill}"
SCRATCH_PASSWORD="${SCRATCH_PASSWORD:-drill}"
RECENCY_HOURS="${RECENCY_HOURS:-48}"
SCRATCH_BOOT_TIMEOUT="${SCRATCH_BOOT_TIMEOUT:-60}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required" >&2
  exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: BACKUP_DIR not found: $BACKUP_DIR" >&2
  exit 1
fi

latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$BACKUP_NAME_GLOB" \
  -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {print $2}')"

if [ -z "${latest:-}" ]; then
  echo "ERROR: no backup files matching $BACKUP_NAME_GLOB in $BACKUP_DIR" >&2
  exit 1
fi

echo "Restore drill against: $latest"
echo "Scratch container: $SCRATCH_CONTAINER"

# shellcheck disable=SC2317  # invoked indirectly via trap
cleanup() {
  set +e
  docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1
}
trap cleanup EXIT

# Throwaway container, no port mapping, tmpfs-backed data dir so we never
# touch host state.
docker run -d --rm \
  --name "$SCRATCH_CONTAINER" \
  -e POSTGRES_PASSWORD="$SCRATCH_PASSWORD" \
  -e POSTGRES_DB="$SCRATCH_DB" \
  --tmpfs /var/lib/postgresql/data:rw \
  "$PG_IMAGE" >/dev/null

# Wait for readiness.
ready=0
for _ in $(seq 1 "$SCRATCH_BOOT_TIMEOUT"); do
  if docker exec "$SCRATCH_CONTAINER" pg_isready -U postgres -d "$SCRATCH_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "FAIL: scratch container did not become ready within ${SCRATCH_BOOT_TIMEOUT}s"
  docker logs "$SCRATCH_CONTAINER" 2>&1 | tail -50
  exit 1
fi

# Stream the dump in. -i so docker exec gets stdin.
echo "Restoring dump..."
if ! gzip -dc "$latest" | docker exec -i \
    -e PGPASSWORD="$SCRATCH_PASSWORD" \
    "$SCRATCH_CONTAINER" \
    psql -U postgres -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 >/tmp/restore-drill.log 2>&1; then
  echo "FAIL: restore raised an error"
  tail -50 /tmp/restore-drill.log
  exit 1
fi

# Sanity queries.
psql_in_scratch() {
  docker exec -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
    psql -U postgres -d "$SCRATCH_DB" -At -v ON_ERROR_STOP=1 -c "$1"
}

declare -i fail=0

check_count() {
  local table="$1"
  local count
  if ! count="$(psql_in_scratch "SELECT count(*) FROM $table")"; then
    echo "FAIL: count query failed for $table"
    fail=1
    return
  fi
  if [ "$count" -gt 0 ]; then
    echo "OK   count($table)=$count"
  else
    echo "FAIL count($table)=$count (expected > 0)"
    fail=1
  fi
}

check_recency() {
  local table="$1"
  local age_hours
  if ! age_hours="$(psql_in_scratch \
      "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(created_at)))/3600, 99999) FROM $table")"; then
    echo "FAIL: recency query failed for $table"
    fail=1
    return
  fi
  # bash can't do float compare directly; use awk.
  if awk -v a="$age_hours" -v t="$RECENCY_HOURS" 'BEGIN{exit !(a<t)}'; then
    echo "OK   recency($table) max(created_at) ${age_hours}h ago (< ${RECENCY_HOURS}h)"
  else
    echo "FAIL recency($table) max(created_at) ${age_hours}h ago (>= ${RECENCY_HOURS}h)"
    fail=1
  fi
}

echo
echo "Sanity checks:"
check_count companies
check_count projects
check_count takeoff_measurements

# Recency checks. Use takeoff_measurements as the most active write target;
# fall back to projects if takeoff_measurements has no rows yet.
check_recency takeoff_measurements

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS: restore drill OK ($latest)"
  exit 0
else
  echo "FAIL: one or more checks failed ($latest)"
  exit 1
fi
