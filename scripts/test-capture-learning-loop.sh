#!/usr/bin/env bash
#
# One-session learning-loop smoke.
#
# Runs the already-focused capture proofs against the same capture_session_id:
#   1. API/browser-equivalent capture session smoke (start/events/artifacts/finalize)
#   2. worker artifact analysis readiness
#   3. analysis-ready Mesh dispatch bridge (fake Mesh by default)
#   4. product-trace forwarding (fake product-trace by default)
#   5. corpus export for capture/agent-cli review
#   6. reviewer-result import back onto the capture work item
#
# This is intentionally an orchestrator over the focused smokes, not a rewrite
# of their assertions.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  SITELAYER_API_URL=http://localhost:3000 \
  SITELAYER_AUTH_TOKEN=e2e-admin \
  DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer \
  npm run capture:learning-smoke

Required:
  SITELAYER_API_URL
  SITELAYER_AUTH_TOKEN or SITELAYER_TOKEN
  DATABASE_URL

Optional:
  ALLOW_CAPTURE_LEARNING_LOOP_SMOKE=1  allow non-local DATABASE_URL
  CAPTURE_LEARNING_EXPORT_DIR=DIR      override export directory
  KEEP_CAPTURE_LEARNING_SMOKE_FILES=1  keep intermediate JSON files
  CAPTURE_LEARNING_SKIP_REVIEW_IMPORT=1
                                        skip synthetic reviewer import step

Real Mesh modes are inherited by the focused smokes:
  ALLOW_REAL_MESH_DISPATCH_SMOKE=1 + MESH_WORK_REQUEST_DISPATCH_URL
  REQUIRE_MESH_DISPATCH_DB_VERIFY=1 + MESH_POSTGRES_DSN/CONTROL_PLANE_POSTGRES_DSN
  REQUIRE_CAPTURE_CALLBACK_REPLAY=1 + SITELAYER_API_URL
  ALLOW_REAL_MESH_TRACE_SMOKE=1 + MESH_TRACE_*
  MESH_POSTGRES_DSN or CONTROL_PLANE_POSTGRES_DSN for trace DB verification
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

require_cmd jq
require_cmd npm

if [ -z "${SITELAYER_API_URL:-}" ]; then
  err "SITELAYER_API_URL is required"
  exit 5
fi
if [ -z "${SITELAYER_AUTH_TOKEN:-${SITELAYER_TOKEN:-}}" ]; then
  err "SITELAYER_AUTH_TOKEN or SITELAYER_TOKEN is required"
  exit 5
fi
if [ -z "${DATABASE_URL:-}" ]; then
  err "DATABASE_URL is required"
  exit 5
fi
if ! is_local_database_url "$DATABASE_URL" && [ "${ALLOW_CAPTURE_LEARNING_LOOP_SMOKE:-0}" != "1" ]; then
  err "Refusing non-local DATABASE_URL without ALLOW_CAPTURE_LEARNING_LOOP_SMOKE=1"
  exit 5
fi

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

tmp_dir="$(mktemp -d)"
if [ "${KEEP_CAPTURE_LEARNING_SMOKE_FILES:-0}" = "1" ]; then
  log "Keeping intermediate files in $tmp_dir"
else
  trap 'rm -rf "$tmp_dir"' EXIT
fi

capture_json="$tmp_dir/capture.json"
analyze_json="$tmp_dir/analyze.json"
dispatch_json="$tmp_dir/dispatch.json"
trace_json="$tmp_dir/trace.json"
export_json="$tmp_dir/export.json"
review_import_json="$tmp_dir/review-import.json"
review_file="$tmp_dir/synthetic-review.md"

log "Step 1/6: capture API smoke"
npm --silent run capture:smoke >"$capture_json"
normalize_json_file "$capture_json"
capture_session_id="$(jq -r '.capture_session_id // empty' "$capture_json")"
if [ -z "$capture_session_id" ]; then
  err "capture:smoke did not return capture_session_id"
  cat "$capture_json" >&2
  exit 1
fi
ok "Capture session $capture_session_id"

log "Step 2/6: artifact analysis"
CAPTURE_SESSION_ID="$capture_session_id" npm --silent run capture:analyze >"$analyze_json"
normalize_json_file "$analyze_json"
ok "Artifact analysis ready"

log "Step 3/6: analysis-ready dispatch"
CAPTURE_SESSION_ID="$capture_session_id" npm --silent run capture:dispatch-smoke >"$dispatch_json"
normalize_json_file "$dispatch_json"
ok "Dispatch bridge proved"

log "Step 4/6: product trace forwarding"
CAPTURE_SESSION_ID="$capture_session_id" npm --silent run capture:trace-smoke >"$trace_json"
normalize_json_file "$trace_json"
ok "Product trace lane proved"

log "Step 5/6: capture export"
export_dir="${CAPTURE_LEARNING_EXPORT_DIR:-$tmp_dir/export}"
CAPTURE_SESSION_ID="$capture_session_id" npm --silent run capture:export -- --include-artifact-files --out-dir "$export_dir" >"$export_json"
normalize_json_file "$export_json"
ok "Capture corpus exported"

if [ "${CAPTURE_LEARNING_SKIP_REVIEW_IMPORT:-0}" = "1" ]; then
  printf '{"skipped":true,"reason":"CAPTURE_LEARNING_SKIP_REVIEW_IMPORT=1"}\n' >"$review_import_json"
  ok "Reviewer import skipped"
else
  log "Step 6/6: reviewer output import"
  cat >"$review_file" <<EOF_REVIEW
# Synthetic Capture Reviewer Result

Capture session: $capture_session_id

This synthetic reviewer output proves the Gemini/Antigravity/operator review
return path. A real reviewer should replace this file with model-generated
findings over the exported capture corpus and any video/frame artifacts.
EOF_REVIEW
  CAPTURE_SESSION_ID="$capture_session_id" \
    REVIEW_FILE="$review_file" \
    CAPTURE_REVIEWER=operator \
    CAPTURE_REVIEW_SOURCE_COMMAND="capture:learning-smoke synthetic reviewer fixture" \
    npm --silent run capture:review-import >"$review_import_json"
  normalize_json_file "$review_import_json"
  ok "Reviewer output imported"
fi

jq -n \
  --slurpfile capture "$capture_json" \
  --slurpfile analyze "$analyze_json" \
  --slurpfile dispatch "$dispatch_json" \
  --slurpfile trace "$trace_json" \
  --slurpfile export "$export_json" \
  --slurpfile review_import "$review_import_json" \
  '{
    capture_session_id: $capture[0].capture_session_id,
    work_item_id: $capture[0].work_item_id,
    support_packet_id: $capture[0].support_packet_id,
    capture: $capture[0],
    analyze: $analyze[0],
    dispatch: $dispatch[0],
    trace: $trace[0],
    export: $export[0],
    review_import: $review_import[0]
  }'

ok "Capture learning-loop smoke completed"
