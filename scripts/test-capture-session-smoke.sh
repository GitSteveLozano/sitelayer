#!/usr/bin/env bash
#
# Capture-session end-to-end smoke harness.
#
# Exercises the loop that matters for end-user feedback capture:
#   1. POST /api/capture-sessions
#   2. POST /api/capture-sessions/:id/events
#   3. POST /api/capture-sessions/:id/artifacts/upload for transcript + rrweb
#   4. POST /api/capture-sessions/:id/finalize
#   5. GET /api/capture-sessions/:id and re-finalize for idempotency
#
# Use against DEV by default. The script creates a real support packet and
# context work item. To run against production, set ALLOW_PROD_CAPTURE_SMOKE=1.
#
# Required env:
#   SITELAYER_API_URL       e.g. https://dev.sitelayer.sandolab.xyz
#   SITELAYER_AUTH_TOKEN    Clerk bearer token, or dev act-as value like e2e-admin
#
# Optional env:
#   SITELAYER_TOKEN         Backcompat alias for SITELAYER_AUTH_TOKEN
#   SITELAYER_COMPANY_SLUG  default: e2e-fixtures for e2e-* users, otherwise la-operations
#   CAPTURE_SMOKE_ID        Override the generated smoke suffix
#   CAPTURE_SESSION_ID      Override the generated UUID

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  SITELAYER_API_URL=https://dev.sitelayer.sandolab.xyz \
  SITELAYER_AUTH_TOKEN=e2e-admin \
  npm run capture:smoke

Required:
  SITELAYER_API_URL
  SITELAYER_AUTH_TOKEN or SITELAYER_TOKEN

Optional:
  SITELAYER_COMPANY_SLUG
  CAPTURE_SMOKE_ID
  CAPTURE_SESSION_ID
  ALLOW_PROD_CAPTURE_SMOKE=1
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

json_field() {
  jq -r "($1) as \$value | if \$value == null then \"\" else \$value end" <<<"$2"
}

new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    cat /proc/sys/kernel/random/uuid
  fi
}

http_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local out body_file code
  out="$(mktemp)"
  body_file="$(mktemp)"
  if [ -n "$body" ]; then
    printf '%s' "$body" >"$body_file"
    code="$(
      curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
        "${auth_args[@]}" \
        -H "Content-Type: application/json" \
        --data-binary "@$body_file" || true
    )"
  else
    code="$(
      curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
        "${auth_args[@]}" || true
    )"
  fi
  rm -f "$body_file"
  printf '%s\n%s' "$(cat "$out")" "$code"
  rm -f "$out"
}

http_multipart() {
  local url="$1"
  local kind="$2"
  local file_path="$3"
  local content_type="$4"
  local metadata="$5"
  local out code
  out="$(mktemp)"
  code="$(
    curl -sS -o "$out" -w '%{http_code}' -X POST "$url" \
      "${auth_args[@]}" \
      -F "kind=$kind" \
      -F "pii_level=private" \
      -F "access_policy=support_only" \
      -F "metadata=$metadata" \
      -F "file=@$file_path;type=$content_type" || true
  )"
  printf '%s\n%s' "$(cat "$out")" "$code"
  rm -f "$out"
}

require_cmd curl
require_cmd jq

SITELAYER_API_URL="${SITELAYER_API_URL:-}"
SITELAYER_AUTH_TOKEN="${SITELAYER_AUTH_TOKEN:-${SITELAYER_TOKEN:-}}"
if [ -z "${SITELAYER_COMPANY_SLUG:-}" ]; then
  if [[ "$SITELAYER_AUTH_TOKEN" =~ ^e2e- ]]; then
    SITELAYER_COMPANY_SLUG="e2e-fixtures"
  else
    SITELAYER_COMPANY_SLUG="la-operations"
  fi
fi

if [ -z "$SITELAYER_API_URL" ] || [ -z "$SITELAYER_AUTH_TOKEN" ]; then
  err "Set SITELAYER_API_URL and SITELAYER_AUTH_TOKEN (or SITELAYER_TOKEN)."
  exit 5
fi

SITELAYER_API_URL="${SITELAYER_API_URL%/}"
case "$SITELAYER_API_URL" in
  https://sitelayer.sandolab.xyz|http://sitelayer.sandolab.xyz)
    if [ "${ALLOW_PROD_CAPTURE_SMOKE:-0}" != "1" ]; then
      err "Refusing production smoke without ALLOW_PROD_CAPTURE_SMOKE=1."
      exit 5
    fi
    ;;
esac

auth_args=()
if [[ "$SITELAYER_AUTH_TOKEN" =~ ^e2e- ]] || [ "${#SITELAYER_AUTH_TOKEN}" -lt 50 ]; then
  auth_args=(-H "x-sitelayer-act-as: $SITELAYER_AUTH_TOKEN")
  log "Auth mode: dev act-as"
else
  auth_args=(-H "Authorization: Bearer $SITELAYER_AUTH_TOKEN")
  log "Auth mode: Bearer"
fi
auth_args+=(-H "x-sitelayer-company-slug: $SITELAYER_COMPANY_SLUG")

smoke_id="${CAPTURE_SMOKE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
capture_session_id="${CAPTURE_SESSION_ID:-$(new_uuid)}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

transcript_file="$tmp_dir/transcript.txt"
rrweb_file="$tmp_dir/replay.json"
printf 'Capture smoke %s: user says Verify Scale did nothing after opening the takeoff canvas.\n' "$smoke_id" >"$transcript_file"
jq -nc \
  --arg smoke_id "$smoke_id" \
  '{
    schema_version: 1,
    artifact_type: "capture.rrweb_replay",
    captured_at: "2026-05-31T00:00:00.000Z",
    event_count: 2,
    smoke_id: $smoke_id,
    events: [
      {type: "full_snapshot", data: {route: "/desktop/takeoff"}},
      {type: "click", data: {target: "Verify Scale"}}
    ]
  }' >"$rrweb_file"

log "Target: $SITELAYER_API_URL"
log "Company: $SITELAYER_COMPANY_SLUG"
log "Smoke id: $smoke_id"
log "Capture session: $capture_session_id"

start_body="$(
  jq -nc \
    --arg id "$capture_session_id" \
    --arg smoke_id "$smoke_id" \
    '{
      capture_session_id: $id,
      mode: "feedback",
      consent_version: "capture-smoke-v1",
      route_path: "/smoke/capture-session",
      device_kind: "desktop",
      platform: "scripted-smoke",
      viewport: "headless",
      metadata: {
        source: "capture_session_smoke",
        smoke_id: $smoke_id
      },
      consent_scope: {
        streams: ["transcript", "rrweb"],
        dom_replay: true,
        scripted_smoke: true
      }
    }'
)"

log "Step 1/6: start capture session"
start_resp="$(http_json POST "$SITELAYER_API_URL/api/capture-sessions" "$start_body")"
start_http="$(tail -n1 <<<"$start_resp")"
start_json="$(sed '$d' <<<"$start_resp")"
if [ "$start_http" != "200" ]; then
  err "Start returned HTTP $start_http"
  printf '%s\n' "$start_json" >&2
  exit 1
fi
ok "Started capture session"

events_body="$(
  jq -nc \
    --arg smoke_id "$smoke_id" \
    '{
      events: [
        {
          client_event_id: ("capture-smoke:" + $smoke_id + ":nav"),
          seq: 1,
          event_type: "smoke.nav",
          event_class: "smoke",
          route_path: "/desktop/takeoff",
          payload: {screen: "takeoff_canvas"}
        },
        {
          client_event_id: ("capture-smoke:" + $smoke_id + ":dead-button"),
          seq: 2,
          event_type: "ui.dead_button",
          event_class: "interaction",
          route_path: "/desktop/takeoff?sheet=A101",
          workflow_id: "capture_smoke",
          entity_type: "smoke",
          entity_id: $smoke_id,
          payload: {control: "Verify Scale", expected: "persist calibration feedback"}
        }
      ]
    }'
)"

log "Step 2/6: append capture events"
events_resp="$(http_json POST "$SITELAYER_API_URL/api/capture-sessions/$capture_session_id/events" "$events_body")"
events_http="$(tail -n1 <<<"$events_resp")"
events_json="$(sed '$d' <<<"$events_resp")"
if [ "$events_http" != "202" ]; then
  err "Events returned HTTP $events_http"
  printf '%s\n' "$events_json" >&2
  exit 2
fi
accepted_events="$(json_field '.accepted' "$events_json")"
ok "Accepted events=$accepted_events"

log "Step 3/6: upload transcript artifact"
transcript_meta="$(jq -nc --arg smoke_id "$smoke_id" '{source:"capture_session_smoke", smoke_id:$smoke_id, artifact_type:"transcript"}')"
transcript_resp="$(
  http_multipart \
    "$SITELAYER_API_URL/api/capture-sessions/$capture_session_id/artifacts/upload" \
    transcript \
    "$transcript_file" \
    text/plain \
    "$transcript_meta"
)"
transcript_http="$(tail -n1 <<<"$transcript_resp")"
transcript_json="$(sed '$d' <<<"$transcript_resp")"
if [ "$transcript_http" != "201" ]; then
  err "Transcript upload returned HTTP $transcript_http"
  printf '%s\n' "$transcript_json" >&2
  exit 3
fi
transcript_artifact_id="$(json_field '.artifact.id' "$transcript_json")"
ok "Uploaded transcript artifact=$transcript_artifact_id"

log "Step 4/6: upload rrweb replay artifact"
rrweb_meta="$(jq -nc --arg smoke_id "$smoke_id" '{source:"capture_session_smoke", smoke_id:$smoke_id, artifact_type:"capture.rrweb_replay"}')"
rrweb_resp="$(
  http_multipart \
    "$SITELAYER_API_URL/api/capture-sessions/$capture_session_id/artifacts/upload" \
    rrweb \
    "$rrweb_file" \
    application/json \
    "$rrweb_meta"
)"
rrweb_http="$(tail -n1 <<<"$rrweb_resp")"
rrweb_json="$(sed '$d' <<<"$rrweb_resp")"
if [ "$rrweb_http" != "201" ]; then
  err "rrweb upload returned HTTP $rrweb_http"
  printf '%s\n' "$rrweb_json" >&2
  exit 4
fi
rrweb_artifact_id="$(json_field '.artifact.id' "$rrweb_json")"
ok "Uploaded rrweb artifact=$rrweb_artifact_id"

finalize_body="$(
  jq -nc \
    --arg smoke_id "$smoke_id" \
    '{
      title: "Capture smoke feedback",
      summary: "Synthetic capture smoke proving session events plus transcript and rrweb artifacts finalize into one triage work item.",
      lane: "triage",
      severity: "low",
      route_path: "/smoke/capture-session",
      category: "smoke",
      client_request_id: ("capture-session-smoke:" + $smoke_id)
    }'
)"

log "Step 5/6: finalize capture session"
finalize_resp="$(http_json POST "$SITELAYER_API_URL/api/capture-sessions/$capture_session_id/finalize" "$finalize_body")"
finalize_http="$(tail -n1 <<<"$finalize_resp")"
finalize_json="$(sed '$d' <<<"$finalize_resp")"
if [ "$finalize_http" != "201" ] && [ "$finalize_http" != "200" ]; then
  err "Finalize returned HTTP $finalize_http"
  printf '%s\n' "$finalize_json" >&2
  exit 5
fi
work_item_id="$(json_field '.work_item.id' "$finalize_json")"
support_packet_id="$(json_field '.support_packet.id' "$finalize_json")"
if [ -z "$work_item_id" ]; then
  err "Finalize did not return work_item.id"
  printf '%s\n' "$finalize_json" >&2
  exit 5
fi
ok "Finalized work_item_id=$work_item_id support_packet_id=$support_packet_id"

log "Step 6/6: verify counts and idempotency"
detail_resp="$(http_json GET "$SITELAYER_API_URL/api/capture-sessions/$capture_session_id")"
detail_http="$(tail -n1 <<<"$detail_resp")"
detail_json="$(sed '$d' <<<"$detail_resp")"
if [ "$detail_http" != "200" ]; then
  err "Detail returned HTTP $detail_http"
  printf '%s\n' "$detail_json" >&2
  exit 6
fi
event_count="$(json_field '.event_count' "$detail_json")"
artifact_count="$(json_field '.artifact_count' "$detail_json")"
if [ "${event_count:-0}" -lt 2 ] || [ "${artifact_count:-0}" -lt 2 ]; then
  err "Expected at least 2 events and 2 artifacts; got events=$event_count artifacts=$artifact_count"
  printf '%s\n' "$detail_json" >&2
  exit 6
fi

replay_resp="$(http_json POST "$SITELAYER_API_URL/api/capture-sessions/$capture_session_id/finalize" "$finalize_body")"
replay_http="$(tail -n1 <<<"$replay_resp")"
replay_json="$(sed '$d' <<<"$replay_resp")"
idempotent_replay="$(json_field '.idempotent_replay' "$replay_json")"
if [ "$replay_http" != "200" ] || [ "$idempotent_replay" != "true" ]; then
  err "Re-finalize did not return idempotent replay"
  printf '%s\n' "$replay_json" >&2
  exit 6
fi
ok "Verified counts events=$event_count artifacts=$artifact_count and idempotent replay"

cat <<EOF
{
  "capture_session_id": "$capture_session_id",
  "work_item_id": "$work_item_id",
  "support_packet_id": "$support_packet_id",
  "transcript_artifact_id": "$transcript_artifact_id",
  "rrweb_artifact_id": "$rrweb_artifact_id",
  "event_count": $event_count,
  "artifact_count": $artifact_count
}
EOF

ok "Capture-session smoke completed"
