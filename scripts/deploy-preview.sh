#!/usr/bin/env bash
set -euo pipefail

PREVIEW_ROOT="${PREVIEW_ROOT:-/app/previews}"
SOURCE_DIR="${PREVIEW_SOURCE_DIR:-$(pwd)}"
SHARED_ENV="${PREVIEW_SHARED_ENV:-$PREVIEW_ROOT/.env.shared}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-preview.sitelayer.sandolab.xyz}"
PREVIEW_ENABLE_WORKER="${PREVIEW_ENABLE_WORKER:-0}"

raw_slug="${PREVIEW_SLUG:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-manual}}}"
preview_slug="$(printf '%s' "$raw_slug" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
if [ -z "$preview_slug" ]; then
  echo "ERROR: preview slug resolved to empty value" >&2
  exit 1
fi

preview_host="${PREVIEW_HOST:-$preview_slug.$PREVIEW_DOMAIN}"
project_name="sitelayer-${preview_slug}"
target_dir="$PREVIEW_ROOT/$preview_slug"

if [ ! -f "$SOURCE_DIR/docker-compose.preview.yml" ]; then
  echo "ERROR: docker-compose.preview.yml not found in $SOURCE_DIR" >&2
  exit 1
fi

if [ ! -f "$SHARED_ENV" ]; then
  echo "ERROR: shared preview env missing at $SHARED_ENV" >&2
  exit 1
fi

mkdir -p "$target_dir"
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'coverage/' \
  --exclude '.env' \
  --exclude '.env.*' \
  "$SOURCE_DIR/" "$target_dir/"

{
  cat "$SHARED_ENV"
  printf '\n'
  printf 'PREVIEW_SLUG=%s\n' "$preview_slug"
  printf 'PREVIEW_HOST=%s\n' "$preview_host"
  printf 'PREVIEW_IMAGE_TAG=%s\n' "${PREVIEW_IMAGE_TAG:-$preview_slug}"
  printf 'ALLOWED_ORIGINS=https://%s\n' "$preview_host"
  printf 'QBO_REDIRECT_URI=https://%s/api/integrations/qbo/callback\n' "$preview_host"
  printf 'QBO_SUCCESS_REDIRECT_URI=https://%s/?qbo=connected\n' "$preview_host"
  printf 'VITE_API_URL=\n'
  printf 'VITE_SENTRY_ENVIRONMENT=preview\n'
} >"$target_dir/.env"
chmod 600 "$target_dir/.env"

if [ "$(id -u)" -eq 0 ] && id sitelayer >/dev/null 2>&1; then
  chown -R sitelayer:sitelayer "$target_dir"
fi

cd "$target_dir"

compose_args=(--env-file .env -f docker-compose.preview.yml -p "$project_name")
profile_args=()
services=(api web)
if [ "$PREVIEW_ENABLE_WORKER" = "1" ]; then
  profile_args=(--profile worker)
  services=(api web worker)
fi

PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$target_dir/.env" "$target_dir/scripts/migrate-db.sh"
PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$target_dir/.env" "$target_dir/scripts/check-db-schema.sh"

docker compose "${compose_args[@]}" config >/dev/null
docker compose "${compose_args[@]}" "${profile_args[@]}" up -d --build --remove-orphans "${services[@]}"

for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 "https://$preview_host/health" >/dev/null 2>&1; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"$target_dir/.last_deployed_at"
    echo "Preview ready: https://$preview_host"
    exit 0
  fi
  sleep 4
done

echo "ERROR: preview did not pass health check: https://$preview_host/health" >&2
docker compose "${compose_args[@]}" logs --tail=120 api web >&2
exit 1
