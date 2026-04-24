#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREVIEW_ROOT="${PREVIEW_ROOT:-/app/previews}"
raw_slug="${PREVIEW_SLUG:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-}}}"
preview_slug="$(printf '%s' "$raw_slug" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"

if [ -z "$preview_slug" ]; then
  echo "ERROR: set PREVIEW_SLUG to the preview environment to clean up" >&2
  exit 1
fi

project_name="sitelayer-${preview_slug}"
target_dir="$PREVIEW_ROOT/$preview_slug"

case "$target_dir" in
  "$PREVIEW_ROOT"/*) ;;
  *)
    echo "ERROR: refusing to clean up path outside $PREVIEW_ROOT" >&2
    exit 1
    ;;
esac

if [ -f "$target_dir/docker-compose.preview.yml" ]; then
  env_args=()
  if [ -f "$target_dir/.env" ]; then
    env_args=(--env-file "$target_dir/.env")
  fi
  docker compose "${env_args[@]}" -f "$target_dir/docker-compose.preview.yml" -p "$project_name" down --remove-orphans
else
  docker compose -p "$project_name" down --remove-orphans || true
fi

if [ -f "$target_dir/.env" ] && grep -qE '^PREVIEW_DB_SCHEMA=' "$target_dir/.env"; then
  drop_schema_script="$target_dir/scripts/drop-preview-schema.sh"
  if [ ! -f "$drop_schema_script" ]; then
    drop_schema_script="$SCRIPT_DIR/drop-preview-schema.sh"
  fi

  if [ -f "$drop_schema_script" ]; then
    PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$target_dir/.env" "$drop_schema_script" || \
      echo "WARNING: failed to drop preview database schema for $preview_slug" >&2
  else
    echo "WARNING: preview schema cleanup script missing for $preview_slug" >&2
  fi
fi

if [ "${DELETE_PREVIEW_DIR:-1}" = "1" ]; then
  rm -rf "$target_dir"
fi

echo "Preview cleaned up: $preview_slug"
