#!/usr/bin/env bash
# Back up the production blueprint Docker volume and copy it off-host.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/app/backups/blueprints}"
VOLUME_NAME="${BLUEPRINT_VOLUME_NAME:-sitelayer_blueprint_storage}"
BACKUP_PREFIX="${BACKUP_PREFIX:-sitelayer-blueprints}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
OFFSITE_HOST="${OFFSITE_HOST:-sitelayer@10.118.0.2}"
OFFSITE_DIR="${OFFSITE_DIR:-/app/offsite-backups/blueprints-from-prod}"
OFFSITE_RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-30}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15}"
RSYNC_OPTS="${RSYNC_OPTS:--az --partial --inplace}"
TAR_DOCKER_IMAGE="${TAR_DOCKER_IMAGE:-alpine:3.20}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required" >&2
  exit 1
fi
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
if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  echo "ERROR: Docker volume not found: $VOLUME_NAME" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="$BACKUP_PREFIX-$timestamp.tgz"
backup_file="$BACKUP_DIR/$backup_name"
tmp_file="$BACKUP_DIR/.$backup_name.tmp"

echo "Blueprint backup: Docker volume $VOLUME_NAME -> $backup_file"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$VOLUME_NAME:/blueprints:ro" \
  -v "$BACKUP_DIR:/backup" \
  "$TAR_DOCKER_IMAGE" \
  sh -c "cd /blueprints && tar -czf /backup/$(basename "$tmp_file") ."
chmod 600 "$tmp_file"
mv "$tmp_file" "$backup_file"

local_sha="$(sha256sum "$backup_file" | awk '{print $1}')"
remote_final="$OFFSITE_DIR/$backup_name"
remote_tmp="$remote_final.tmp"

# shellcheck disable=SC2086,SC2029
ssh $SSH_OPTS "$OFFSITE_HOST" "mkdir -p $(printf '%q' "$OFFSITE_DIR") && chmod 700 $(printf '%q' "$OFFSITE_DIR")"

# shellcheck disable=SC2086
rsync $RSYNC_OPTS -e "ssh $SSH_OPTS" "$backup_file" "$OFFSITE_HOST:$remote_tmp"

# shellcheck disable=SC2086,SC2029
remote_sha="$(ssh $SSH_OPTS "$OFFSITE_HOST" \
  "sync $(printf '%q' "$remote_tmp") 2>/dev/null || sync; sha256sum $(printf '%q' "$remote_tmp") | awk '{print \$1}'")"

if [ "$local_sha" != "$remote_sha" ]; then
  echo "ERROR: sha256 mismatch (local=$local_sha remote=$remote_sha); leaving .tmp in place" >&2
  exit 1
fi

# shellcheck disable=SC2086,SC2029
ssh $SSH_OPTS "$OFFSITE_HOST" \
  "mv $(printf '%q' "$remote_tmp") $(printf '%q' "$remote_final") && chmod 600 $(printf '%q' "$remote_final")"

find "$BACKUP_DIR" -maxdepth 1 -type f -name "$BACKUP_PREFIX-*.tgz" -mtime +"$RETENTION_DAYS" -delete

# shellcheck disable=SC2086,SC2029
ssh $SSH_OPTS "$OFFSITE_HOST" \
  "find $(printf '%q' "$OFFSITE_DIR") -maxdepth 1 -type f -name $(printf '%q' "$BACKUP_PREFIX-*.tgz") -mtime +$OFFSITE_RETENTION_DAYS -delete; \
   find $(printf '%q' "$OFFSITE_DIR") -maxdepth 1 -type f -name '*.tmp' -mtime +1 -delete"

echo "Blueprint backup OK: $remote_final (sha256=$local_sha)"
