#!/usr/bin/env bash
# Monthly restore drill.
#
# Spins up a throwaway postgres:18-alpine container, restores the most
# recent local pg_dump into it, runs sanity queries (row counts +
# BACKUP-age recency check), tears down the scratch container, prints
# PASS/FAIL, and emits a durable result (a JSON result file plus a
# best-effort mesh record_restore_drill_result call).
#
# Usage:
#   bash scripts/restore-drill.sh
#
# What "recency" measures (IMPORTANT):
#   The drill verifies that we are taking BACKUPS regularly, NOT that
#   prod has fresh row writes. A healthy backup of a quiet prod (no new
#   rows for >48h) must still PASS. So recency is measured against the
#   BACKUP file's age (mtime of the dump we restored), not the newest
#   row's created_at. A stale-data prod is a product question; a stale
#   BACKUP is the DR failure this drill exists to catch.
#
# Env overrides:
#   BACKUP_DIR              default: /app/backups/postgres
#   BACKUP_NAME_GLOB        default: sitelayer-*.sql.gz
#   PG_IMAGE                default: postgres:18-alpine pinned by digest
#                           (override to track a newer Postgres minor)
#   SCRATCH_CONTAINER       default: sitelayer-restore-drill-<epoch>
#   SCRATCH_DB              default: sitelayer_drill
#   RECENCY_HOURS           default: 48 (max age of the BACKUP file)
#   SCRATCH_BOOT_TIMEOUT    default: 60 (seconds to wait for pg_isready)
#   RESULT_FILE            default: $BACKUP_DIR/restore-drill-last.json
#                          (durable PASS/FAIL result, overwritten each run)
#   RESTORE_DRILL_HOST     default: $(hostname) — recorded in the result
#   RESTORE_DRILL_SUBSYSTEM default: sitelayer-prod-postgres
#   MESH_API_URL          optional; if set, POST a best-effort
#                          record_restore_drill_result (never fails the drill)
#   MESH_API_TOKEN        optional bearer for the mesh call
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/app/backups/postgres}"
BACKUP_NAME_GLOB="${BACKUP_NAME_GLOB:-sitelayer-*.sql.gz}"
# Digest pin keeps restore drills deterministic: the drill exercises the
# exact image we last validated rather than whatever upstream
# postgres:18-alpine resolves to today. Bump after each successful
# weekly drill against a fresh tag.
PG_IMAGE="${PG_IMAGE:-postgres:18-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7}"
SCRATCH_CONTAINER="${SCRATCH_CONTAINER:-sitelayer-restore-drill-$(date +%s)}"
SCRATCH_DB="${SCRATCH_DB:-sitelayer_drill}"
SCRATCH_PASSWORD="${SCRATCH_PASSWORD:-drill}"
RECENCY_HOURS="${RECENCY_HOURS:-48}"
SCRATCH_BOOT_TIMEOUT="${SCRATCH_BOOT_TIMEOUT:-60}"
RESULT_FILE="${RESULT_FILE:-$BACKUP_DIR/restore-drill-last.json}"
RESTORE_DRILL_HOST="${RESTORE_DRILL_HOST:-$(hostname 2>/dev/null || echo unknown)}"
RESTORE_DRILL_SUBSYSTEM="${RESTORE_DRILL_SUBSYSTEM:-sitelayer-prod-postgres}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Result state, populated as the drill progresses. Defaults to a failure so
# an early/unexpected exit records a FAILED result rather than nothing.
RESULT_STATUS="failed"
RESULT_DETAIL="drill did not complete"
RESULT_EMITTED=0

# emit_result writes a durable JSON result file and makes a best-effort
# mesh record_restore_drill_result call. It NEVER fails the drill (all
# side effects are guarded) and is idempotent within a single run.
# shellcheck disable=SC2317  # also invoked indirectly via trap
emit_result() {
  [ "$RESULT_EMITTED" = "1" ] && return 0
  RESULT_EMITTED=1
  local completed_at
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local json
  json="$(
    cat <<JSON
{
  "subsystem": "${RESTORE_DRILL_SUBSYSTEM}",
  "host": "${RESTORE_DRILL_HOST}",
  "status": "${RESULT_STATUS}",
  "started_at": "${STARTED_AT}",
  "completed_at": "${completed_at}",
  "backup_file": "${latest:-}",
  "backup_age_hours": ${backup_age_hours:-null},
  "recency_hours_threshold": ${RECENCY_HOURS},
  "detail": "${RESULT_DETAIL//\"/\\\"}"
}
JSON
  )"

  # Durable local result file (best-effort; mkdir in case BACKUP_DIR moved).
  if mkdir -p "$(dirname "$RESULT_FILE")" 2>/dev/null; then
    if printf '%s\n' "$json" >"$RESULT_FILE" 2>/dev/null; then
      chmod 600 "$RESULT_FILE" 2>/dev/null || true
      echo "Result written: $RESULT_FILE (status=${RESULT_STATUS})"
    else
      echo "WARN: could not write result file $RESULT_FILE" >&2
    fi
  fi

  # Best-effort mesh notification. The MCP tool record_restore_drill_result is
  # surfaced over the mesh HTTP API; a shell drill on the droplet reaches it
  # only if MESH_API_URL is configured AND mesh is reachable on the Tailnet.
  # Any failure (no curl, no mesh, network error) is swallowed — the drill's
  # PASS/FAIL must not depend on mesh being up.
  if [ -n "${MESH_API_URL:-}" ] && command -v curl >/dev/null 2>&1; then
    local auth_args=()
    if [ -n "${MESH_API_TOKEN:-}" ]; then
      auth_args=(-H "Authorization: Bearer ${MESH_API_TOKEN}")
    fi
    if curl -fsS --max-time 10 \
      -X POST "${MESH_API_URL%/}/api/tools/record_restore_drill_result" \
      -H "Content-Type: application/json" \
      "${auth_args[@]}" \
      -d "$json" >/dev/null 2>&1; then
      echo "Recorded restore-drill result to mesh (${RESULT_STATUS})"
    else
      echo "WARN: best-effort mesh record_restore_drill_result failed (ignored)" >&2
    fi
  fi
  return 0
}

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required" >&2
  RESULT_DETAIL="docker is required but not on PATH"
  emit_result
  exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: BACKUP_DIR not found: $BACKUP_DIR" >&2
  RESULT_DETAIL="BACKUP_DIR not found: $BACKUP_DIR"
  emit_result
  exit 1
fi

latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$BACKUP_NAME_GLOB" \
  -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {print $2}')"

if [ -z "${latest:-}" ]; then
  echo "ERROR: no backup files matching $BACKUP_NAME_GLOB in $BACKUP_DIR" >&2
  # Even with no backup to restore, emit a durable FAILED result so the
  # absence of backups is itself visible to the monitor / dashboard.
  RESULT_STATUS="failed"
  RESULT_DETAIL="no backup files matching $BACKUP_NAME_GLOB in $BACKUP_DIR"
  emit_result
  exit 1
fi

# Backup-age recency is the real DR signal (see header). Capture the dump
# file's mtime NOW, before we restore, so a quiet-but-healthy prod passes.
backup_mtime_epoch="$(stat -c %Y "$latest" 2>/dev/null || stat -f %m "$latest" 2>/dev/null || echo 0)"
now_epoch="$(date -u +%s)"
backup_age_hours=$(((now_epoch - backup_mtime_epoch) / 3600))

echo "Restore drill against: $latest"
echo "Backup file age: ${backup_age_hours}h (mtime epoch ${backup_mtime_epoch})"
echo "Scratch container: $SCRATCH_CONTAINER"

# shellcheck disable=SC2317  # invoked indirectly via trap
cleanup() {
  set +e
  # Make sure a durable result is always emitted, even on an unexpected
  # exit between here and the final PASS/FAIL block (RESULT_STATUS defaults
  # to "failed" so a crash records a failure, not silence).
  emit_result
  docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1
}
trap cleanup EXIT

# Throwaway container, no port mapping, tmpfs-backed Postgres dir so we never
# touch host state.
docker run -d --rm \
  --name "$SCRATCH_CONTAINER" \
  -e POSTGRES_PASSWORD="$SCRATCH_PASSWORD" \
  -e POSTGRES_DB="$SCRATCH_DB" \
  --tmpfs /var/lib/postgresql:rw \
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
  RESULT_DETAIL="scratch container not ready within ${SCRATCH_BOOT_TIMEOUT}s"
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
  RESULT_DETAIL="restore raised an error (see /tmp/restore-drill.log)"
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

count_rows() {
  local table="$1"
  psql_in_scratch "SELECT count(*) FROM $table"
}

# Recency = how old the BACKUP is, NOT how old the newest row is. A backup of
# a quiet prod (no row writes in days) is still a HEALTHY backup; what would
# make this a DR failure is the backup itself being stale (the timer stopped
# producing dumps). We measure against the dump file's mtime, captured before
# the restore. (`backup_age_hours` is set at the top, near `latest`.)
check_backup_recency() {
  if [ -z "${backup_age_hours:-}" ] || [ "${backup_mtime_epoch:-0}" -le 0 ]; then
    echo "FAIL recency: could not determine backup file mtime for $latest"
    fail=1
    return
  fi
  if [ "$backup_age_hours" -lt "$RECENCY_HOURS" ]; then
    echo "OK   recency: backup is ${backup_age_hours}h old (< ${RECENCY_HOURS}h)"
  else
    echo "FAIL recency: backup is ${backup_age_hours}h old (>= ${RECENCY_HOURS}h) — backup pipeline may be stale"
    fail=1
  fi
}

echo
echo "Sanity checks:"
check_count companies
check_count projects
takeoff_count="$(count_rows takeoff_measurements || printf '0')"
if [ "$takeoff_count" -gt 0 ]; then
  echo "OK   count(takeoff_measurements)=$takeoff_count"
else
  echo "WARN count(takeoff_measurements)=0 (skipping takeoff recency until pilot data exists)"
fi

# Backup-age recency: verifies the BACKUP is fresh, not that prod has fresh
# rows. A quiet prod still produces (and must pass) a fresh backup.
check_backup_recency

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS: restore drill OK ($latest)"
  RESULT_STATUS="passed"
  RESULT_DETAIL="restore + sanity checks OK; backup ${backup_age_hours}h old (< ${RECENCY_HOURS}h)"
  emit_result
  exit 0
else
  echo "FAIL: one or more checks failed ($latest)"
  RESULT_STATUS="failed"
  RESULT_DETAIL="one or more restore-drill checks failed (backup ${backup_age_hours:-?}h old)"
  emit_result
  exit 1
fi
