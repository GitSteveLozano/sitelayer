#!/usr/bin/env sh
set -eu

DIST_DIR="${1:-apps/web/dist}"
SENTRY_ORG="${SENTRY_ORG:-sandolabs}"
SENTRY_WEB_PROJECT="${SENTRY_WEB_PROJECT:-sitelayer-web}"

if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "ERROR: SENTRY_AUTH_TOKEN is required to upload sourcemaps" >&2
  exit 1
fi

if [ -z "${SENTRY_RELEASE:-}" ]; then
  echo "ERROR: SENTRY_RELEASE is required to upload sourcemaps" >&2
  exit 1
fi

if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: sourcemap dist directory not found: $DIST_DIR" >&2
  exit 1
fi

npx @sentry/cli sourcemaps inject --org "$SENTRY_ORG" --project "$SENTRY_WEB_PROJECT" "$DIST_DIR"
npx @sentry/cli sourcemaps upload --org "$SENTRY_ORG" --project "$SENTRY_WEB_PROJECT" --release "$SENTRY_RELEASE" "$DIST_DIR"
