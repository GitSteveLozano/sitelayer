#!/usr/bin/env bash
#
# Context handoff / work-request smoke harness.
#
# Exercises the loop that matters for agent handoff:
#   1. POST /api/work-requests with entity + UI/server context
#   2. POST /api/work-requests/:id/dispatch/mesh
#   3. GET /api/work-requests/:id and /queue-health
#   4. Optional: read the scoped callback from mutation_outbox and replay an
#      agent.proposal_ready callback to validate the return path
#   5. Optional: probe Mesh for the created task when MESH_API_URL is set
#
# Use against DEV by default. The script creates a real work item and may queue
# a real Mesh task. To run against production, set ALLOW_PROD_WORK_REQUEST_SMOKE=1.
#
# Required env:
#   SITELAYER_API_URL       e.g. https://dev.sitelayer.sandolab.xyz
#   SITELAYER_AUTH_TOKEN    Clerk bearer token, or dev act-as value like e2e-admin
#
# Optional env:
#   SITELAYER_TOKEN         Backcompat alias for SITELAYER_AUTH_TOKEN
#   SITELAYER_COMPANY_SLUG  default: la-operations
#   DATABASE_URL            Enables scoped callback replay by reading mutation_outbox
#   MESH_API_URL            Enables Mesh task probe
#   MESH_API_TOKEN          Optional Bearer token for Mesh probe
#   WORK_REQUEST_SMOKE_ID   Override the generated smoke entity/idempotency suffix

set -euo pipefail

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
  jq -r "$1 // \"\"" <<<"$2"
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

require_cmd curl
require_cmd jq

SITELAYER_API_URL="${SITELAYER_API_URL:-}"
SITELAYER_AUTH_TOKEN="${SITELAYER_AUTH_TOKEN:-${SITELAYER_TOKEN:-}}"
SITELAYER_COMPANY_SLUG="${SITELAYER_COMPANY_SLUG:-la-operations}"

if [ -z "$SITELAYER_API_URL" ] || [ -z "$SITELAYER_AUTH_TOKEN" ]; then
  err "Set SITELAYER_API_URL and SITELAYER_AUTH_TOKEN (or SITELAYER_TOKEN)."
  exit 5
fi

SITELAYER_API_URL="${SITELAYER_API_URL%/}"
case "$SITELAYER_API_URL" in
  https://sitelayer.sandolab.xyz|http://sitelayer.sandolab.xyz)
    if [ "${ALLOW_PROD_WORK_REQUEST_SMOKE:-0}" != "1" ]; then
      err "Refusing production smoke without ALLOW_PROD_WORK_REQUEST_SMOKE=1."
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

smoke_id="${WORK_REQUEST_SMOKE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
client_request_id="context-work-smoke:${smoke_id}"
entity_id="context-work-smoke:${smoke_id}"
request_id="smoke-context-work-${smoke_id}"

log "Target: $SITELAYER_API_URL"
log "Company: $SITELAYER_COMPANY_SLUG"
log "Smoke id: $smoke_id"

create_body="$(
  jq -nc \
    --arg client_request_id "$client_request_id" \
    --arg entity_id "$entity_id" \
    --arg request_id "$request_id" \
    '{
      title: "Context handoff smoke",
      summary: "Synthetic context handoff smoke created by scripts/test-context-work-request.sh.",
      severity: "low",
      lane: "agent",
      category: "smoke",
      route: "/work/context-handoff-smoke",
      client_request_id: $client_request_id,
      client: {
        source: "context_work_request_smoke",
        page: {
          path: "/work/context-handoff-smoke",
          route: "/work/context-handoff-smoke"
        },
        entity: {
          entity_type: "context_handoff_smoke",
          entity_id: $entity_id
        },
        runtime: {
          xstate_state: "smoke.ready",
          server_state: "scripted",
          request_id: $request_id
        },
        evidence_refs: [
          { type: "script", path: "scripts/test-context-work-request.sh" }
        ]
      }
    }'
)"

log "Step 1/5: create work request"
create_resp="$(http_json POST "$SITELAYER_API_URL/api/work-requests" "$create_body")"
create_http="$(tail -n1 <<<"$create_resp")"
create_json="$(sed '$d' <<<"$create_resp")"
if [ "$create_http" != "201" ] && [ "$create_http" != "200" ]; then
  err "Create returned HTTP $create_http"
  printf '%s\n' "$create_json" >&2
  exit 1
fi
work_item_id="$(json_field '.work_item.id' "$create_json")"
support_packet_id="$(json_field '.support_packet.id' "$create_json")"
if [ -z "$work_item_id" ]; then
  err "Create did not return work_item.id"
  printf '%s\n' "$create_json" >&2
  exit 1
fi
ok "Created work_item_id=$work_item_id support_packet_id=$support_packet_id"

log "Step 2/5: queue Mesh dispatch"
dispatch_resp="$(http_json POST "$SITELAYER_API_URL/api/work-requests/$work_item_id/dispatch/mesh" '{}')"
dispatch_http="$(tail -n1 <<<"$dispatch_resp")"
dispatch_json="$(sed '$d' <<<"$dispatch_resp")"
if [ "$dispatch_http" != "202" ]; then
  err "Dispatch returned HTTP $dispatch_http"
  printf '%s\n' "$dispatch_json" >&2
  exit 2
fi
outbox_status="$(json_field '.outbox.status' "$dispatch_json")"
dispatch_queued="$(json_field '.dispatch_queued' "$dispatch_json")"
ok "Dispatch outbox status=$outbox_status dispatch_queued=$dispatch_queued"

log "Step 3/5: read work item and queue health"
detail_resp="$(http_json GET "$SITELAYER_API_URL/api/work-requests/$work_item_id")"
detail_http="$(tail -n1 <<<"$detail_resp")"
detail_json="$(sed '$d' <<<"$detail_resp")"
if [ "$detail_http" != "200" ]; then
  err "Detail returned HTTP $detail_http"
  printf '%s\n' "$detail_json" >&2
  exit 3
fi
status="$(json_field '.work_item.status' "$detail_json")"
event_count="$(jq -r '.events | length' <<<"$detail_json")"
ok "Detail status=$status events=$event_count"

health_resp="$(http_json GET "$SITELAYER_API_URL/api/work-requests/queue-health")"
health_http="$(tail -n1 <<<"$health_resp")"
health_json="$(sed '$d' <<<"$health_resp")"
if [ "$health_http" = "200" ]; then
  mesh_configured="$(json_field '.config.mesh_dispatch_configured' "$health_json")"
  pending_count="$(json_field '.dispatch_outbox.pending' "$health_json")"
  ok "Queue health mesh_dispatch_configured=$mesh_configured pending=$pending_count"
else
  log "Queue health skipped/failed with HTTP $health_http"
fi

log "Step 4/5: scoped callback replay"
if [ -z "${DATABASE_URL:-}" ]; then
  log "DATABASE_URL not set; skipped callback replay."
else
  require_cmd psql
  callback_row="$(
    psql "$DATABASE_URL" -AtX -F $'\t' -c "
      select coalesce(payload->'callback'->>'url', ''),
             coalesce(payload->'callback'->>'path', ''),
             coalesce(payload->'callback'->>'token', ''),
             coalesce(payload->'callback'->>'expires_at', '')
        from mutation_outbox
       where entity_type = 'context_work_item'
         and entity_id = '$work_item_id'
         and mutation_type = 'dispatch_mesh_work_request'
       order by created_at desc
       limit 1
    " 2>/dev/null || true
  )"
  callback_url="$(cut -f1 <<<"$callback_row")"
  callback_path="$(cut -f2 <<<"$callback_row")"
  callback_token="$(cut -f3 <<<"$callback_row")"
  callback_expires_at="$(cut -f4 <<<"$callback_row")"
  if [ -z "$callback_token" ]; then
    log "No callback token found in mutation_outbox; skipped callback replay."
  else
    if [ -z "$callback_url" ]; then
      callback_url="$SITELAYER_API_URL$callback_path"
    fi
    callback_body="$(
      jq -nc \
        --arg idempotency_key "context-work-smoke-callback:${smoke_id}" \
        --arg expires_at "$callback_expires_at" \
        '{
          event_type: "agent.proposal_ready",
          agent_ref: "scripts/test-context-work-request.sh",
          message: "Synthetic proposal-ready callback from the context handoff smoke.",
          body: "The scoped callback URL and token accepted an agent proposal-ready event.",
          metadata: {
            smoke: true,
            callback_expires_at: $expires_at
          },
          idempotency_key: $idempotency_key
        }'
    )"
    callback_out="$(mktemp)"
    callback_http="$(
      curl -sS -o "$callback_out" -w '%{http_code}' -X POST "$callback_url" \
        -H "Authorization: Bearer $callback_token" \
        -H "x-sitelayer-company-slug: $SITELAYER_COMPANY_SLUG" \
        -H "Content-Type: application/json" \
        --data-binary "$callback_body" || true
    )"
    callback_json="$(cat "$callback_out")"
    rm -f "$callback_out"
    if [ "$callback_http" != "202" ]; then
      err "Callback returned HTTP $callback_http"
      printf '%s\n' "$callback_json" >&2
      exit 4
    fi
    callback_status="$(json_field '.work_item.status' "$callback_json")"
    ok "Callback accepted; work item status=$callback_status"
  fi
fi

log "Step 5/5: optional Mesh probe"
if [ -z "${MESH_API_URL:-}" ]; then
  log "MESH_API_URL not set; skipped Mesh task probe."
else
  mesh_headers=()
  if [ -n "${MESH_API_TOKEN:-}" ]; then
    mesh_headers=(-H "Authorization: Bearer $MESH_API_TOKEN")
  fi
  mesh_url="${MESH_API_URL%/}/api/orchestrate/tasks?q=$work_item_id&limit=5"
  mesh_out="$(mktemp)"
  mesh_http="$(
    curl -sS -o "$mesh_out" -w '%{http_code}' "$mesh_url" "${mesh_headers[@]}" || true
  )"
  mesh_json="$(cat "$mesh_out")"
  rm -f "$mesh_out"
  if [ "$mesh_http" = "200" ]; then
    mesh_count="$(jq -r 'if type == "array" then length else 0 end' <<<"$mesh_json")"
    ok "Mesh probe returned $mesh_count matching task(s)"
  else
    log "Mesh probe returned HTTP $mesh_http"
  fi
fi

echo
ok "Context handoff smoke completed"
echo "  work_item_id:      $work_item_id"
echo "  support_packet_id: $support_packet_id"
echo "  status:            $(json_field '.work_item.status' "$(http_json GET "$SITELAYER_API_URL/api/work-requests/$work_item_id" | sed '$d')")"
