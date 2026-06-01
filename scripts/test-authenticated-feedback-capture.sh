#!/usr/bin/env bash
#
# Authenticated browser feedback capture smoke.
#
# Drives the real authenticated Record feedback dock in a browser, against the
# real local/dev API. Then runs deterministic artifact analysis and exports the
# same capture_session_id for reviewer handoff.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  SITELAYER_API_URL=http://localhost:3001 \
  DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5433/sitelayer \
  DO_SPACES_KEY=sitelayerlocal \
  DO_SPACES_SECRET=sitelayerlocal \
  DO_SPACES_REGION=us-east-1 \
  DO_SPACES_BUCKET=sitelayer-blueprints-local \
  DO_SPACES_ENDPOINT=http://localhost:9000 \
  npm run capture:auth-smoke

Required:
  SITELAYER_API_URL
  DATABASE_URL

Optional:
  AUTH_CAPTURE_EXPORT_DIR=DIR
  AUTH_CAPTURE_SMOKE_WEB_PORT=5173
  AUTH_CAPTURE_SMOKE_PROJECTS=desktop|mobile|tablet       default desktop
  AUTH_CAPTURE_SMOKE_DEVICE=mobile|tablet                 alias for one project
  KEEP_AUTH_CAPTURE_SMOKE_FILES=1
  ALLOW_AUTH_CAPTURE_SMOKE_DB=1   allow non-local DATABASE_URL
EOF
  exit 0
fi

err() { printf '\033[31mFAIL %s\033[0m\n' "$*" >&2; }
ok() { printf '\033[32mOK   %s\033[0m\n' "$*" >&2; }
log() { printf '\033[36mINFO %s\033[0m\n' "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command missing: $1"
    exit 5
  fi
}

is_local_database_url() {
  local value="$1"
  [[ "$value" =~ ^postgres(ql)?://([^/@]+@)?(localhost|127\.0\.0\.1|\[::1\]|postgres|db)(:|/|$) ]]
}

normalize_json_file() {
  local file="$1"
  local tmp="$file.normalized"
  awk '
    found { print; next }
    {
      line=$0
      sub(/^[ \t\r]*/, "", line)
      first=substr(line, 1, 1)
      if (first == "{" || first == "[") {
        found=1
        print
      }
    }
  ' "$file" >"$tmp"
  if ! jq empty "$tmp" >/dev/null 2>&1; then
    err "Expected JSON output in $file"
    cat "$file" >&2
    rm -f "$tmp"
    exit 1
  fi
  mv "$tmp" "$file"
}

require_cmd jq
require_cmd npm
require_cmd curl

SITELAYER_API_URL="${SITELAYER_API_URL:-http://localhost:3001}"
SITELAYER_API_URL="${SITELAYER_API_URL%/}"
AUTH_CAPTURE_SMOKE_WEB_PORT="${AUTH_CAPTURE_SMOKE_WEB_PORT:-5173}"
AUTH_CAPTURE_SMOKE_WEB_ORIGIN="${AUTH_CAPTURE_SMOKE_WEB_ORIGIN:-http://localhost:$AUTH_CAPTURE_SMOKE_WEB_PORT}"
if [ -z "${DATABASE_URL:-}" ]; then
  err "DATABASE_URL is required"
  exit 5
fi
if ! is_local_database_url "$DATABASE_URL" && [ "${ALLOW_AUTH_CAPTURE_SMOKE_DB:-0}" != "1" ]; then
  err "Refusing non-local DATABASE_URL without ALLOW_AUTH_CAPTURE_SMOKE_DB=1"
  exit 5
fi

probe_code="$(
  curl -sS -o /tmp/sitelayer-auth-capture-api-probe.json -w '%{http_code}' \
    -H 'x-sitelayer-act-as: e2e-admin' \
    -H 'x-sitelayer-company-slug: e2e-fixtures' \
    "$SITELAYER_API_URL/api/session" || true
)"
if [ "$probe_code" != "200" ]; then
  err "API probe failed with HTTP $probe_code at $SITELAYER_API_URL"
  cat /tmp/sitelayer-auth-capture-api-probe.json >&2 || true
  exit 5
fi
cors_headers="$(mktemp)"
cors_code="$(
  curl -sS -o /tmp/sitelayer-auth-capture-cors-probe.txt -D "$cors_headers" -w '%{http_code}' \
    -X OPTIONS \
    -H "Origin: $AUTH_CAPTURE_SMOKE_WEB_ORIGIN" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type,x-sitelayer-act-as,x-sitelayer-company-slug,x-request-id' \
    "$SITELAYER_API_URL/api/capture-sessions" || true
)"
cors_origin="$(
  awk 'BEGIN{IGNORECASE=1} /^access-control-allow-origin:/ { sub(/\r$/, "", $0); sub(/^[^:]+:[ \t]*/, "", $0); print; exit }' "$cors_headers"
)"
rm -f "$cors_headers"
if [ "$cors_code" != "204" ] && [ "$cors_code" != "200" ]; then
  err "API CORS preflight failed with HTTP $cors_code for origin $AUTH_CAPTURE_SMOKE_WEB_ORIGIN"
  cat /tmp/sitelayer-auth-capture-cors-probe.txt >&2 || true
  exit 5
fi
if [ "$cors_origin" != "*" ] && [ "$cors_origin" != "$AUTH_CAPTURE_SMOKE_WEB_ORIGIN" ]; then
  err "API CORS does not allow browser origin $AUTH_CAPTURE_SMOKE_WEB_ORIGIN (allow-origin: ${cors_origin:-missing})"
  exit 5
fi

tmp_dir="$(mktemp -d)"
if [ "${KEEP_AUTH_CAPTURE_SMOKE_FILES:-0}" = "1" ]; then
  log "Keeping intermediate files in $tmp_dir"
else
  trap 'rm -rf "$tmp_dir"' EXIT
fi

browser_json="$tmp_dir/browser.json"
analyze_json="$tmp_dir/analyze.json"
export_json="$tmp_dir/export.json"
export_dir="${AUTH_CAPTURE_EXPORT_DIR:-$tmp_dir/export}"

log "Step 1/3: browser drives authenticated Record feedback against real API"
AUTH_CAPTURE_SMOKE_OUT="$browser_json" \
  AUTH_CAPTURE_SMOKE_WEB_PORT="$AUTH_CAPTURE_SMOKE_WEB_PORT" \
  E2E_API_BASE_URL="$SITELAYER_API_URL" \
  SITELAYER_API_URL="$SITELAYER_API_URL" \
  npm --silent run capture:auth-browser-smoke
normalize_json_file "$browser_json"
capture_session_id="$(jq -r '.capture_session_id // empty' "$browser_json")"
if [ -z "$capture_session_id" ]; then
  err "Browser smoke did not return capture_session_id"
  cat "$browser_json" >&2
  exit 1
fi
ok "Browser capture session $capture_session_id"

log "Step 2/3: analyze browser-created artifacts"
CAPTURE_SESSION_ID="$capture_session_id" npm --silent run capture:analyze >"$analyze_json"
normalize_json_file "$analyze_json"
ok "Artifact analysis ready"

log "Step 3/3: export browser-created capture corpus"
CAPTURE_SESSION_ID="$capture_session_id" npm --silent run capture:export -- --include-artifact-files --out-dir "$export_dir" >"$export_json"
normalize_json_file "$export_json"
ok "Capture corpus exported"

jq -n \
  --slurpfile browser "$browser_json" \
  --slurpfile analyze "$analyze_json" \
  --slurpfile export "$export_json" \
  '{
    capture_session_id: $browser[0].capture_session_id,
    work_item_id: $browser[0].work_item_id,
    support_packet_id: $browser[0].support_packet_id,
    browser: $browser[0],
    analyze: $analyze[0],
    export: $export[0]
  }'

ok "Authenticated browser feedback capture smoke completed"
