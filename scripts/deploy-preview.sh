#!/usr/bin/env bash
set -euo pipefail

# Deploys a preview stack.
#
# PREVIEW_MODE defaults to `dev` — a source-mounted, watch-mode stack that iterates
# in seconds. Subsequent commits to the same PR only rsync source; tsx + vite HMR
# pick the change up without rebuilding.
#
# PREVIEW_MODE=prod runs a full prod-bundle build via docker-compose.preview-prod.yml.
# Use this for a final pre-merge smoke test (slower; full `npm ci`, tsc, vite build).

PREVIEW_ROOT="${PREVIEW_ROOT:-/app/previews}"
SOURCE_DIR="${PREVIEW_SOURCE_DIR:-$(pwd)}"
SHARED_ENV="${PREVIEW_SHARED_ENV:-$PREVIEW_ROOT/.env.shared}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-preview.sitelayer.sandolab.xyz}"
PREVIEW_ENABLE_WORKER="${PREVIEW_ENABLE_WORKER:-0}"
PREVIEW_MODE="${PREVIEW_MODE:-dev}"

case "$PREVIEW_MODE" in
  dev)  compose_file="docker-compose.preview.yml"      ;;
  prod) compose_file="docker-compose.preview-prod.yml" ;;
  *)
    echo "ERROR: PREVIEW_MODE must be 'dev' or 'prod' (got '$PREVIEW_MODE')" >&2
    exit 1
    ;;
esac

raw_slug="${PREVIEW_SLUG:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-manual}}}"
preview_slug="$(printf '%s' "$raw_slug" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
if [ -z "$preview_slug" ]; then
  echo "ERROR: preview slug resolved to empty value" >&2
  exit 1
fi

preview_host="${PREVIEW_HOST:-$preview_slug.$PREVIEW_DOMAIN}"
project_name="sitelayer-${preview_slug}"
target_dir="$PREVIEW_ROOT/$preview_slug"
schema_slug="$(printf '%s' "$preview_slug" | tr '-' '_' | sed -E 's/[^a-z0-9_]+/_/g; s/^_+//; s/_+$//; s/_+/_/g')"
preview_db_schema="${PREVIEW_DB_SCHEMA:-sitelayer_${schema_slug}}"
if [[ ! "$preview_db_schema" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "ERROR: invalid preview database schema: $preview_db_schema" >&2
  exit 1
fi

if [ ! -f "$SOURCE_DIR/$compose_file" ]; then
  echo "ERROR: $compose_file not found in $SOURCE_DIR" >&2
  exit 1
fi

if [ ! -f "$SHARED_ENV" ]; then
  echo "ERROR: shared preview env missing at $SHARED_ENV" >&2
  exit 1
fi

# Pre-flight orphan reap. The preview droplet has 4GB of RAM; left unchecked,
# closed-PR stacks accumulate (the `cleanup` job in deploy-preview.yml fires
# on `pull_request closed`, which silently no-ops when the self-hosted runner
# is OOM). Before provisioning a new stack, tear down any `sitelayer-pr-*`
# project whose corresponding PR is no longer open. Best-effort: never block
# the deploy on reap failures — the daily preview-gc.yml workflow is the
# durable backstop running on the self-hosted preview runner.
if [ "${PREVIEW_DEPLOY_SKIP_REAP:-0}" != "1" ]; then
  open_prs_csv="${PREVIEW_OPEN_PRS:-}"
  if [ -z "$open_prs_csv" ] && command -v gh >/dev/null 2>&1; then
    open_prs_csv="$(gh pr list --state open --limit 500 --json number \
      --jq 'map(.number) | join(",")' 2>/dev/null || true)"
  fi

  if [ -z "$open_prs_csv" ]; then
    echo "Pre-flight reap: skipped (no open-PR list available; daily GC will catch this)"
  else
    open_list="$(printf '%s\n' "$open_prs_csv" | tr ',' '\n' | awk 'NF')"
    # Enumerate compose projects via container labels — invariant across the
    # `docker compose ls` schema churn between Compose v2 minor releases.
    mapfile -t reap_projects < <(
      docker ps -a --format '{{.Label "com.docker.compose.project"}}' \
        | awk 'NF' \
        | grep -E '^sitelayer-pr-[0-9]+$' \
        | sort -u
    )

    for stale in "${reap_projects[@]}"; do
      stale_pr="${stale#sitelayer-pr-}"
      [[ "$stale_pr" =~ ^[0-9]+$ ]] || continue
      # Never reap the stack we're about to redeploy.
      [ "$stale" = "$project_name" ] && continue
      if printf '%s\n' "$open_list" | grep -Fxq "$stale_pr"; then
        continue
      fi
      echo "Pre-flight reap: stale stack $stale (PR #$stale_pr is closed)"
      stale_dir="$PREVIEW_ROOT/pr-$stale_pr"
      stale_compose=""
      for candidate in docker-compose.preview.yml docker-compose.preview-prod.yml; do
        if [ -f "$stale_dir/$candidate" ]; then
          stale_compose="$candidate"
          break
        fi
      done
      if [ -n "$stale_compose" ]; then
        env_args=()
        [ -f "$stale_dir/.env" ] && env_args=(--env-file "$stale_dir/.env")
        ( cd "$stale_dir" && \
          docker compose "${env_args[@]}" -f "$stale_compose" -p "$stale" \
            down -v --remove-orphans \
        ) || echo "WARN: pre-flight reap failed for $stale (continuing deploy)"
      else
        docker compose -p "$stale" down -v --remove-orphans \
          || echo "WARN: pre-flight reap (project-only) failed for $stale (continuing deploy)"
      fi
    done
  fi
fi

mkdir -p "$target_dir"

t_start=$(date +%s)

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
  printf 'PREVIEW_MODE=%s\n' "$PREVIEW_MODE"
  printf 'PREVIEW_DB_SCHEMA=%s\n' "$preview_db_schema"
  printf 'DB_SCHEMA=%s\n' "$preview_db_schema"
  printf 'PGOPTIONS=-c search_path=%s,public\n' "$preview_db_schema"
  printf 'PREVIEW_IMAGE_TAG=%s\n' "${PREVIEW_IMAGE_TAG:-$preview_slug}"
  printf 'SENTRY_RELEASE=%s\n' "${SENTRY_RELEASE:-$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || printf '%s' "$preview_slug")}"
  printf 'VITE_SENTRY_RELEASE=%s\n' "${VITE_SENTRY_RELEASE:-${SENTRY_RELEASE:-$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || printf '%s' "$preview_slug")}}"
  printf 'ALLOWED_ORIGINS=https://%s\n' "$preview_host"
  printf 'QBO_REDIRECT_URI=https://%s/api/integrations/qbo/callback\n' "$preview_host"
  printf 'QBO_SUCCESS_REDIRECT_URI=https://%s/?qbo=connected\n' "$preview_host"
  printf 'VITE_API_URL=https://%s\n' "$preview_host"
  printf 'VITE_SENTRY_ENVIRONMENT=preview\n'
} >"$target_dir/.env"
chmod 600 "$target_dir/.env"

if [ "$(id -u)" -eq 0 ] && id sitelayer >/dev/null 2>&1; then
  chown -R sitelayer:sitelayer "$target_dir"
fi

cd "$target_dir"

compose_args=(--env-file .env -f "$compose_file" -p "$project_name")
profile_args=()
services=(api web)
if [ "$PREVIEW_ENABLE_WORKER" = "1" ]; then
  profile_args=(--profile worker)
  services=(api web worker)
fi

# Apply migrations on a fresh schema. If the SHA hasn't moved since last deploy,
# skip — the schema is already current.
current_sha="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || printf '')"
migrations_marker="$target_dir/.migrations-applied-sha"
if [ -n "$current_sha" ] && [ -f "$migrations_marker" ] && [ "$(cat "$migrations_marker")" = "$current_sha" ]; then
  echo "Migrations already applied for $current_sha — skipping"
else
  PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$target_dir/.env" "$target_dir/scripts/ensure-preview-schema.sh"
  PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$target_dir/.env" "$target_dir/scripts/migrate-db.sh"
  PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$target_dir/.env" "$target_dir/scripts/check-db-schema.sh"
  [ -n "$current_sha" ] && printf '%s' "$current_sha" >"$migrations_marker"
fi

docker compose "${compose_args[@]}" config >/dev/null

if [ "$PREVIEW_MODE" = "prod" ]; then
  docker compose "${compose_args[@]}" "${profile_args[@]}" up -d --build --remove-orphans "${services[@]}"
else
  # Dev-mode: no --build (images are node:20-alpine pulled once). Containers stay up
  # across deploys; rsync + tsx watch + vite HMR propagate changes in seconds.
  docker compose "${compose_args[@]}" "${profile_args[@]}" up -d --remove-orphans "${services[@]}"
fi

# Fast health-check poll. Tight loop for first ~30s, then back off.
deadline=$(( $(date +%s) + 120 ))
while :; do
  if curl -fsS --max-time 5 "https://$preview_host/health" >/dev/null 2>&1 &&
    curl -fsSI --max-time 5 "https://$preview_host/" >/dev/null 2>&1; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"$target_dir/.last_deployed_at"
    elapsed=$(( $(date +%s) - t_start ))
    echo "Preview ready: https://$preview_host (mode=$PREVIEW_MODE, ${elapsed}s)"
    exit 0
  fi
  now=$(date +%s)
  [ "$now" -ge "$deadline" ] && break
  remaining=$(( deadline - now ))
  # 1s poll for the first 30s, 3s after.
  if [ $(( deadline - now )) -gt 90 ]; then
    sleep 1
  else
    sleep 3
  fi
done

echo "ERROR: preview did not pass health check within 120s: https://$preview_host/health" >&2
docker compose "${compose_args[@]}" logs --tail=120 api web >&2
exit 1
