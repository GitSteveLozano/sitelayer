#!/usr/bin/env bash
#
# Operator-context chat dispatch end-to-end test harness.
#
# Synthesises the full pipeline:
#   1. POST /api/ai/chat → stage_message audit row + mesh task created
#   2. Verify the mesh task lands in /api/orchestrate/tasks (when MESH_API_URL set)
#   3. Manually fire the webhook POST that a real CLI runner would make
#   4. Verify GET /api/ai/chat/:id/response flips to 200 with body
#
# Use against a DEV TIER ONLY. The dev stack at dev.sitelayer.sandolab.xyz
# (or your local `npm run dev`) is the right target. NEVER run against prod —
# the harness creates a real audit row + mesh task; running in prod would
# burn a real Claude CLI session on a synthetic message.
#
# Required env:
#   SITELAYER_API_URL          e.g. http://localhost:3001 OR https://dev.sitelayer.sandolab.xyz
#   SITELAYER_AUTH_TOKEN       Clerk bearer token OR dev `x-sitelayer-act-as` value (use 'e2e-admin' on local)
#   SITELAYER_COMPANY_SLUG     e.g. la-operations (default for local dev seed)
#   SITELAYER_CHAT_WEBHOOK_TOKEN  Same token the prod env carries (use dev value locally)
#
# Optional env:
#   MESH_API_URL               If set, harness probes the mesh task; otherwise skips that hop
#   AUDIT_EVENT_ID_OVERRIDE    Skip the staging POST and jump straight to webhook+poll for an existing audit_event_id
#   CHAT_MESSAGE               Override the test message (default: synthetic)
#   POLL_TIMEOUT_SECONDS       Default 90
#
# Exit codes:
#   0 — full loop succeeded
#   1 — staging failed
#   2 — mesh task probe failed
#   3 — webhook failed
#   4 — polling timed out
#   5 — env validation failed

set -euo pipefail

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
err() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*" >&2; }
log() { printf '\033[36m· %s\033[0m\n' "$*" >&2; }

require_env() {
    local missing=0
    for v in "$@"; do
        if [ -z "${!v:-}" ]; then
            err "Required env var unset: $v"
            missing=1
        fi
    done
    if [ "$missing" = "1" ]; then
        exit 5
    fi
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "Required command missing: $1"
        exit 5
    fi
}

# ----------------------------------------------------------------------------
# Prerequisites
# ----------------------------------------------------------------------------
require_cmd curl
require_cmd jq
require_env SITELAYER_API_URL SITELAYER_AUTH_TOKEN SITELAYER_CHAT_WEBHOOK_TOKEN

SITELAYER_COMPANY_SLUG="${SITELAYER_COMPANY_SLUG:-la-operations}"
CHAT_MESSAGE="${CHAT_MESSAGE:-Test message from scripts/test-chat-dispatch.sh at $(date -Iseconds)}"
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-90}"

# Refuse to run against the prod host. The smoke harness creates a real
# audit row + mesh task; running in prod burns CLI session quota.
case "$SITELAYER_API_URL" in
    *sitelayer.sandolab.xyz)
        if [ "$SITELAYER_API_URL" = "https://sitelayer.sandolab.xyz" ] || [ "$SITELAYER_API_URL" = "http://sitelayer.sandolab.xyz" ]; then
            err "Refusing to run against prod (SITELAYER_API_URL=$SITELAYER_API_URL). Use dev/preview/local."
            exit 5
        fi
        ;;
esac

log "Target: $SITELAYER_API_URL"
log "Company: $SITELAYER_COMPANY_SLUG"
log "Message: $CHAT_MESSAGE"

# Auth helper. If the token is a JWT it's a Bearer; if it's an
# x-sitelayer-act-as fixture (e2e-admin etc.) we send it as that header
# instead. Heuristic: JWTs have at least two dots and >100 chars.
auth_args=()
if [[ "$SITELAYER_AUTH_TOKEN" =~ ^e2e- ]] || [ "${#SITELAYER_AUTH_TOKEN}" -lt 50 ]; then
    auth_args=(-H "x-sitelayer-act-as: $SITELAYER_AUTH_TOKEN")
    log "Auth mode: dev act-as ($SITELAYER_AUTH_TOKEN)"
else
    auth_args=(-H "Authorization: Bearer $SITELAYER_AUTH_TOKEN")
    log "Auth mode: Bearer JWT (length ${#SITELAYER_AUTH_TOKEN})"
fi
auth_args+=(-H "x-sitelayer-company-slug: $SITELAYER_COMPANY_SLUG")

# ----------------------------------------------------------------------------
# Step 1 — Stage the chat message
# ----------------------------------------------------------------------------
audit_event_id="${AUDIT_EVENT_ID_OVERRIDE:-}"

if [ -z "$audit_event_id" ]; then
    log "Step 1/4 — POST /api/ai/chat (stage message)"
    stage_body=$(jq -nc \
        --arg msg "$CHAT_MESSAGE" \
        '{
          messages: [
            { id: "op-test-1", role: "operator", body: $msg }
          ],
          operatorContext: {
            subject: "test-harness operator",
            generated_at: now | todateiso8601,
            origin: "sitelayer.sandolab.xyz",
            current_focus: { label: "test-harness", confidence: 0.5 },
            origin_context: { project: "sitelayer", label: "sitelayer", repo_branch: "test" }
          }
        }')
    stage_resp=$(curl -sS -X POST "${SITELAYER_API_URL}/api/ai/chat" \
        "${auth_args[@]}" \
        -H "Content-Type: application/json" \
        -d "$stage_body" || true)
    if [ -z "$stage_resp" ]; then
        err "Staging POST returned empty response"
        exit 1
    fi
    stage_status=$(printf '%s' "$stage_resp" | jq -r '.status // "error"')
    if [ "$stage_status" != "staged" ]; then
        err "Staging POST returned non-staged status: $stage_resp"
        exit 1
    fi
    audit_event_id=$(printf '%s' "$stage_resp" | jq -r '.audit_event_id // ""')
    mesh_task_id=$(printf '%s' "$stage_resp" | jq -r '.mesh_task_id // "null"')
    dispatch_error=$(printf '%s' "$stage_resp" | jq -r '.dispatch_error // ""')
    ok "Staged audit_event_id=$audit_event_id mesh_task_id=$mesh_task_id"
    if [ -n "$dispatch_error" ] && [ "$dispatch_error" != "null" ]; then
        log "  dispatch_error: $dispatch_error (expected when MESH_API_URL unset on sitelayer side)"
    fi
else
    log "Step 1/4 — skipped (AUDIT_EVENT_ID_OVERRIDE=$audit_event_id)"
fi

if [ -z "$audit_event_id" ] || [ "$audit_event_id" = "null" ]; then
    err "No audit_event_id resolved"
    exit 1
fi

# ----------------------------------------------------------------------------
# Step 2 — Verify mesh task (optional)
# ----------------------------------------------------------------------------
if [ -n "${MESH_API_URL:-}" ]; then
    log "Step 2/4 — Probe mesh for task (q=audit:${audit_event_id})"
    # The task's created_by carries sitelayer:audit:<id>. Search by it.
    task_probe=$(curl -sS \
        "${MESH_API_URL}/api/orchestrate/tasks?q=sitelayer:audit:${audit_event_id}&limit=5" \
        || true)
    if [ -z "$task_probe" ]; then
        err "Mesh probe returned empty response"
        exit 2
    fi
    task_count=$(printf '%s' "$task_probe" | jq 'length')
    if [ "$task_count" = "0" ]; then
        err "No mesh task found referencing audit_event_id=$audit_event_id"
        log "  This is OK if MESH_API_URL was unset on the sitelayer side during staging,"
        log "  but means the harness can't trace the full hop. Set MESH_API_URL on sitelayer"
        log "  and re-run to validate the full path."
        # Don't exit; the webhook step can still validate the sitelayer side.
    else
        first_task=$(printf '%s' "$task_probe" | jq '.[0] | {id, state, subject}')
        ok "Mesh task found: $first_task"
    fi
else
    log "Step 2/4 — skipped (MESH_API_URL not set; webhook hop still validated)"
fi

# ----------------------------------------------------------------------------
# Step 3 — Fire the webhook (simulating the CLI runner)
# ----------------------------------------------------------------------------
log "Step 3/4 — POST /api/ai/chat/${audit_event_id}/respond (synthetic CLI reply)"
synthetic_reply="Synthetic test reply from scripts/test-chat-dispatch.sh. In production a Claude CLI runner generates this. Test message echo: ${CHAT_MESSAGE}"
respond_body=$(jq -nc --arg body "$synthetic_reply" '{
    body: $body,
    model: "test-harness-stub"
}')
respond_resp=$(curl -sS -X POST "${SITELAYER_API_URL}/api/ai/chat/${audit_event_id}/respond" \
    -H "Authorization: Bearer $SITELAYER_CHAT_WEBHOOK_TOKEN" \
    -H "Content-Type: application/json" \
    -w "\n%{http_code}" \
    -d "$respond_body" || true)
respond_http=$(printf '%s' "$respond_resp" | tail -n1)
respond_json=$(printf '%s' "$respond_resp" | head -n -1)
if [ "$respond_http" != "201" ]; then
    err "Webhook POST returned HTTP $respond_http (expected 201)"
    err "Response: $respond_json"
    exit 3
fi
response_audit=$(printf '%s' "$respond_json" | jq -r '.response_audit_event_id // ""')
ok "Webhook recorded response_audit_event_id=$response_audit"

# ----------------------------------------------------------------------------
# Step 4 — Poll the GET endpoint until 200
# ----------------------------------------------------------------------------
log "Step 4/4 — Poll GET /api/ai/chat/${audit_event_id}/response (timeout ${POLL_TIMEOUT_SECONDS}s)"
deadline=$(( $(date +%s) + POLL_TIMEOUT_SECONDS ))
attempt=0
while [ "$(date +%s)" -lt "$deadline" ]; do
    attempt=$(( attempt + 1 ))
    poll_resp=$(curl -sS "${SITELAYER_API_URL}/api/ai/chat/${audit_event_id}/response" \
        "${auth_args[@]}" \
        -w "\n%{http_code}" \
        || true)
    poll_http=$(printf '%s' "$poll_resp" | tail -n1)
    poll_json=$(printf '%s' "$poll_resp" | head -n -1)
    case "$poll_http" in
        200)
            poll_status=$(printf '%s' "$poll_json" | jq -r '.status // "?"')
            if [ "$poll_status" = "responded" ]; then
                body=$(printf '%s' "$poll_json" | jq -r '.body // ""')
                ok "Polled: status=responded body=\"$(printf '%.80s' "$body")\""
                break
            fi
            log "  attempt $attempt: 200 but status=$poll_status; continuing"
            ;;
        202)
            log "  attempt $attempt: 202 staged; continuing"
            ;;
        *)
            err "Polling returned unexpected HTTP $poll_http: $poll_json"
            exit 4
            ;;
    esac
    sleep 2
done

if [ "$(date +%s)" -ge "$deadline" ]; then
    err "Polling timed out after ${POLL_TIMEOUT_SECONDS}s without seeing status=responded"
    exit 4
fi

# ----------------------------------------------------------------------------
# Success
# ----------------------------------------------------------------------------
echo
ok "Full chat-dispatch loop succeeded"
echo "  audit_event_id:           $audit_event_id"
echo "  response_audit_event_id:  $response_audit"
echo "  attempts to poll:         $attempt"
echo
echo "Next: run this in a real subscription-CLI flow by leaving the webhook step out"
echo "      (export SKIP_WEBHOOK=1 and use this harness with a queued mesh task picked up"
echo "       by a real Claude CLI runner)."
