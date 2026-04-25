#!/usr/bin/env bash
# Off-host backup copy.
#
# Reads the most recent local pg_dump produced by scripts/backup-postgres.sh
# and rsyncs it to a remote host over SSH using the private network.
#
# Idempotent + transactional:
#   1. Copy to <name>.tmp on the remote.
#   2. fsync (rsync --fsync if supported, else `sync` over ssh).
#   3. Verify sha256 matches.
#   4. Atomic rename to final filename.
#   5. Mirror retention on the remote side.
#
# The local source file is never deleted. If the remote copy fails the next
# run will retry — the local prod retention (30d) gives us a wide window.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/app/backups/postgres}"
OFFSITE_HOST="${OFFSITE_HOST:-sitelayer@10.118.0.2}"
OFFSITE_DIR="${OFFSITE_DIR:-/app/offsite-backups/postgres-from-prod}"
OFFSITE_RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-30}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15}"
RSYNC_OPTS="${RSYNC_OPTS:--az --partial --inplace}"
BACKUP_NAME_GLOB="${BACKUP_NAME_GLOB:-sitelayer-*.sql.gz}"

if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync is required" >&2
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "ERROR: ssh is required" >&2
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "ERROR: sha256sum is required" >&2
  exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: BACKUP_DIR not found: $BACKUP_DIR" >&2
  exit 1
fi

# Find the newest local dump. -printf '%T@ %p\n' is GNU find specific; the
# prod droplet runs Ubuntu 22.04 so this is fine.
latest_local="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$BACKUP_NAME_GLOB" \
  -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {print $2}')"

if [ -z "${latest_local:-}" ]; then
  echo "ERROR: no backup files matching $BACKUP_NAME_GLOB in $BACKUP_DIR" >&2
  exit 1
fi

backup_basename="$(basename "$latest_local")"
remote_final="$OFFSITE_DIR/$backup_basename"
remote_tmp="$remote_final.tmp"

echo "Off-site backup: $latest_local -> $OFFSITE_HOST:$remote_final"

# Ensure remote dir exists (mode 700, sitelayer owned).
# Variables in the remote command intentionally expand client-side and are
# quoted via printf %q before reaching the remote shell.
# shellcheck disable=SC2086,SC2029
ssh $SSH_OPTS "$OFFSITE_HOST" "mkdir -p $(printf '%q' "$OFFSITE_DIR") && chmod 700 $(printf '%q' "$OFFSITE_DIR")"

# Compute local sha256 once.
local_sha="$(sha256sum "$latest_local" | awk '{print $1}')"

# Copy to .tmp on the remote. --inplace + --partial give us resumable transfer
# without surprising partial-file dotnames.
# shellcheck disable=SC2086
rsync $RSYNC_OPTS -e "ssh $SSH_OPTS" \
  "$latest_local" "$OFFSITE_HOST:$remote_tmp"

# Force the remote filesystem to flush, then verify sha256.
# shellcheck disable=SC2086,SC2029
remote_sha="$(ssh $SSH_OPTS "$OFFSITE_HOST" \
  "sync $(printf '%q' "$remote_tmp") 2>/dev/null || sync; sha256sum $(printf '%q' "$remote_tmp") | awk '{print \$1}'")"

if [ "$local_sha" != "$remote_sha" ]; then
  echo "ERROR: sha256 mismatch (local=$local_sha remote=$remote_sha) — leaving .tmp in place for inspection" >&2
  exit 1
fi

# Atomic rename + chmod 600.
# shellcheck disable=SC2086,SC2029
ssh $SSH_OPTS "$OFFSITE_HOST" \
  "mv $(printf '%q' "$remote_tmp") $(printf '%q' "$remote_final") && chmod 600 $(printf '%q' "$remote_final")"

# Mirror retention on the remote side.
# shellcheck disable=SC2086,SC2029
ssh $SSH_OPTS "$OFFSITE_HOST" \
  "find $(printf '%q' "$OFFSITE_DIR") -maxdepth 1 -type f -name $(printf '%q' "$BACKUP_NAME_GLOB") -mtime +$OFFSITE_RETENTION_DAYS -delete; \
   find $(printf '%q' "$OFFSITE_DIR") -maxdepth 1 -type f -name '*.tmp' -mtime +1 -delete"

echo "Off-site backup OK: $remote_final (sha256=$local_sha)"
