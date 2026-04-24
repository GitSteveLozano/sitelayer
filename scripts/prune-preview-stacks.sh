#!/usr/bin/env bash
set -euo pipefail

PREVIEW_ROOT="${PREVIEW_ROOT:-/app/previews}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-14}"
DRY_RUN="${DRY_RUN:-1}"

if [ ! -d "$PREVIEW_ROOT" ]; then
  echo "Preview root does not exist: $PREVIEW_ROOT"
  exit 0
fi

now_epoch="$(date +%s)"
max_age_seconds=$((MAX_AGE_DAYS * 24 * 60 * 60))

find "$PREVIEW_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 | while IFS= read -r -d '' preview_dir; do
  slug="$(basename "$preview_dir")"
  if [ "$slug" = "main" ]; then
    continue
  fi

  if [ ! -f "$preview_dir/.env" ] && [ ! -f "$preview_dir/docker-compose.preview.yml" ]; then
    continue
  fi

  marker_file="$preview_dir/.last_deployed_at"
  if [ -f "$marker_file" ]; then
    modified_epoch="$(stat -c %Y "$marker_file")"
  else
    modified_epoch="$(stat -c %Y "$preview_dir")"
  fi
  age_seconds=$((now_epoch - modified_epoch))
  if [ "$age_seconds" -lt "$max_age_seconds" ]; then
    continue
  fi

  echo "Pruning preview older than $MAX_AGE_DAYS days: $slug"
  if [ "$DRY_RUN" = "1" ]; then
    continue
  fi

  PREVIEW_ROOT="$PREVIEW_ROOT" PREVIEW_SLUG="$slug" DELETE_PREVIEW_DIR=1 "$(dirname "$0")/cleanup-preview.sh"
done

if [ "$DRY_RUN" != "1" ]; then
  docker image prune -f --filter "until=${MAX_AGE_DAYS}d"
fi
