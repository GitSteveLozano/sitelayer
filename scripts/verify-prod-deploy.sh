#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${VERIFY_DOMAIN:-sitelayer.sandolab.xyz}"
RESOLVE_IP="${VERIFY_RESOLVE_IP:-127.0.0.1}"
EXPECTED_SHA="${EXPECTED_SHA:-${GIT_SHA:-}}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
CURL_MAX_TIME="${VERIFY_CURL_MAX_TIME:-10}"

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "ERROR: neither docker compose nor docker-compose is installed" >&2
  exit 1
fi

base_url="https://$DOMAIN"
curl_tls=(curl -fsS --max-time "$CURL_MAX_TIME" --resolve "$DOMAIN:443:$RESOLVE_IP")

echo "Verifying public health endpoint"
health_json="$("${curl_tls[@]}" "$base_url/health")"
printf '%s\n' "$health_json"

echo "Verifying deployed API version"
version_json="$("${curl_tls[@]}" "$base_url/api/version")"
printf '%s\n' "$version_json"
if [ -n "$EXPECTED_SHA" ] && ! printf '%s\n' "$version_json" | grep -Eq "\"build_sha\"[[:space:]]*:[[:space:]]*\"$EXPECTED_SHA\""; then
  echo "ERROR: /api/version build_sha does not match expected SHA $EXPECTED_SHA" >&2
  exit 1
fi

echo "Verifying web root"
curl -fsSI --max-time "$CURL_MAX_TIME" --resolve "$DOMAIN:443:$RESOLVE_IP" "$base_url/" >/dev/null

echo "Verifying metrics endpoint is gated"
metrics_body="$(mktemp)"
metrics_code="$(
  curl -sS -o "$metrics_body" -w '%{http_code}' --max-time "$CURL_MAX_TIME" \
    --resolve "$DOMAIN:443:$RESOLVE_IP" "$base_url/api/metrics" || true
)"
rm -f "$metrics_body"
if [ "$metrics_code" != "401" ]; then
  echo "ERROR: /api/metrics returned HTTP $metrics_code without a bearer token; expected 401" >&2
  exit 1
fi

echo "Verifying compose services"
"${compose[@]}" -f "$COMPOSE_FILE" ps

api_container="$("${compose[@]}" -f "$COMPOSE_FILE" ps -q api)"
if [ -z "$api_container" ]; then
  echo "ERROR: api container not found" >&2
  exit 1
fi
api_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$api_container")"
if [ "$api_health" != "healthy" ]; then
  echo "ERROR: api container health is $api_health, expected healthy" >&2
  exit 1
fi

for service in web worker caddy; do
  container="$("${compose[@]}" -f "$COMPOSE_FILE" ps -q "$service")"
  if [ -z "$container" ]; then
    echo "ERROR: $service container not found" >&2
    exit 1
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$container")"
  if [ "$running" != "true" ]; then
    echo "ERROR: $service container is not running" >&2
    exit 1
  fi
done

echo "Production verification passed"
