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
  # Untagged-image cleanup. The 14d filter is intentionally loose; the
  # registry-side image churn is what really moves the needle.
  docker image prune -f --filter "until=${MAX_AGE_DAYS}d"

  # Aggressive untagged-image sweep: drops registry image tags that
  # aren't referenced by any running container. The deploy pulls a new
  # tag on every prod push and never deletes the old one, so 60+ tags
  # had accumulated (~40 GB) before this guard. Keep only what's
  # actively in use plus the floating `main` tag for fast rollback.
  docker image prune -af --filter "label!=keep" --filter "until=${IMAGE_PRUNE_UNTIL:-72h}" || true

  # Build cache cleanup. BuildKit caches every layer of every build.
  # On a host that runs both the prod-image build AND ~20 preview
  # stacks per week, this is the dominant disk consumer (~41 GB
  # observed on 2026-04-29, triggering DO disk >80% alerts every
  # 30 min). 72h retention gives next-deploy cache reuse without
  # letting the cache balloon. Keep at least 2 GB so a normal incremental
  # rebuild still benefits from cache.
  docker builder prune -af --filter "until=${BUILDER_PRUNE_UNTIL:-72h}" \
    --keep-storage "${BUILDER_PRUNE_KEEP_STORAGE:-2GB}" || true

  # Volumes orphaned by deleted preview stacks.
  docker volume prune -f || true
fi
