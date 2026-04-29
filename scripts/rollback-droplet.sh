#!/usr/bin/env bash
#
# Production rollback. Runs on the prod droplet (or via SSH from a
# trusted operator). Reads `.last_previous_deployed_sha` written by
# the deploy workflow, pulls that image from the registry, swaps the
# containers, verifies health.
#
# Usage on the droplet (must run as root since the deploy user can't
# write `.last_*` markers in some setups):
#
#   sudo bash /app/sitelayer/scripts/rollback-droplet.sh
#
# Override the target SHA explicitly:
#
#   sudo TARGET_SHA=abcdef1 bash /app/sitelayer/scripts/rollback-droplet.sh
#
# Drill mode (no-op exit after pulling, useful for runbook practice):
#
#   sudo DRY_RUN=1 bash /app/sitelayer/scripts/rollback-droplet.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/app/sitelayer}"
DOCKER_CONFIG_PATH="${DOCKER_CONFIG_PATH:-/home/sitelayer/.docker}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

cd "$APP_DIR"

if [ -z "${TARGET_SHA:-}" ]; then
  if [ ! -f "$APP_DIR/.last_previous_deployed_sha" ]; then
    echo "ERROR: no .last_previous_deployed_sha marker; pass TARGET_SHA explicitly" >&2
    exit 1
  fi
  TARGET_SHA="$(cat "$APP_DIR/.last_previous_deployed_sha")"
fi

if [ -z "$TARGET_SHA" ]; then
  echo "ERROR: TARGET_SHA is empty" >&2
  exit 1
fi

CURRENT_SHA=""
if [ -f "$APP_DIR/.last_successful_deployed_sha" ]; then
  CURRENT_SHA="$(cat "$APP_DIR/.last_successful_deployed_sha")"
fi

TARGET_IMAGE="registry.digitalocean.com/sitelayer/sitelayer:${TARGET_SHA}"

echo "==> Rollback target:  $TARGET_SHA ($TARGET_IMAGE)"
echo "==> Current deploy:   ${CURRENT_SHA:-<unknown>}"
echo "==> Compose file:     $COMPOSE_FILE"

if [ ! -d "$DOCKER_CONFIG_PATH" ]; then
  echo "WARNING: $DOCKER_CONFIG_PATH not found — registry pull may fail" >&2
fi

echo "==> Pulling image"
DOCKER_CONFIG="$DOCKER_CONFIG_PATH" \
  APP_IMAGE="$TARGET_IMAGE" \
  docker compose -f "$COMPOSE_FILE" pull api web worker

echo "==> Verifying image is on disk"
docker image inspect "$TARGET_IMAGE" >/dev/null

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1 — image pulled and verified, NOT swapping containers"
  exit 0
fi

echo "==> Swapping containers"
# APP_BUILD_SHA / GIT_SHA / SENTRY_RELEASE are exported so the version
# endpoint and Sentry release tag reflect the rolled-back SHA. Without
# these, the running api reports build_sha='unknown' (a real wrinkle
# discovered in the first rollback drill — see DEPLOY_RUNBOOK.md).
APP_BUILD_SHA="$TARGET_SHA" \
  GIT_SHA="$TARGET_SHA" \
  SENTRY_RELEASE="$TARGET_SHA" \
  APP_IMAGE="$TARGET_IMAGE" \
  docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

echo "==> Waiting for HTTPS health"
for attempt in $(seq 1 30); do
  if curl -fsS --resolve sitelayer.sandolab.xyz:443:127.0.0.1 https://sitelayer.sandolab.xyz/health >/dev/null 2>&1; then
    echo "    healthy after ${attempt}s"
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "ERROR: HTTPS health check failed after $attempt attempts" >&2
    exit 1
  fi
  sleep 1
done

echo "==> Verifying live build_sha"
live_sha="$(curl -sS https://sitelayer.sandolab.xyz/api/version | sed -n 's/.*"build_sha":"\([^"]*\)".*/\1/p' || true)"
echo "    live build_sha: $live_sha"
if [ "$live_sha" != "$TARGET_SHA" ]; then
  echo "WARNING: live build_sha ($live_sha) != target ($TARGET_SHA)" >&2
fi

echo "==> Rollback complete: prod is now on $TARGET_SHA"
echo "    Note: the next merge to main will deploy normally over this rollback."
echo "    To re-deploy the previously-current SHA without merging anything new:"
echo "      sudo TARGET_SHA=${CURRENT_SHA:-<original-sha>} bash $APP_DIR/scripts/rollback-droplet.sh"
