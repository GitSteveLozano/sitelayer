#!/usr/bin/env bash
#
# External/reference capture ingress smoke.
#
# Proves the Steve/operator path where the evidence was captured outside the
# in-app recorder: browser-bridge trace id, external recording/transcript
# references, and operator notes become one capture_session_id, finalize into a
# context work item, get deterministic reference-artifact analysis, and export
# into the review corpus.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  SITELAYER_API_URL=http://localhost:3001 \
  SITELAYER_AUTH_TOKEN=e2e-admin \
  DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5433/sitelayer \
  npm run capture:reference-smoke

Required:
  SITELAYER_API_URL
  SITELAYER_AUTH_TOKEN or SITELAYER_TOKEN
  DATABASE_URL

Optional:
  CAPTURE_REFERENCE_SMOKE_ID=ID
  CAPTURE_REFERENCE_EXPORT_DIR=DIR
  KEEP_CAPTURE_REFERENCE_SMOKE_FILES=1
  ALLOW_CAPTURE_REFERENCE_SMOKE_DB=1   allow non-local DATABASE_URL
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
if ! is_local_database_url "$DATABASE_URL" && [ "${ALLOW_CAPTURE_REFERENCE_SMOKE_DB:-0}" != "1" ]; then
  err "Refusing non-local DATABASE_URL without ALLOW_CAPTURE_REFERENCE_SMOKE_DB=1"
  exit 5
fi

tmp_dir="$(mktemp -d)"
if [ "${KEEP_CAPTURE_REFERENCE_SMOKE_FILES:-0}" = "1" ]; then
  log "Keeping intermediate files in $tmp_dir"
else
  trap 'rm -rf "$tmp_dir"' EXIT
fi

smoke_id="${CAPTURE_REFERENCE_SMOKE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
reference_json="$tmp_dir/reference.json"
analyze_json="$tmp_dir/analyze.json"
export_json="$tmp_dir/export.json"
transcript_path="$tmp_dir/operator-transcript.txt"
video_path="$tmp_dir/operator-recording.mp4"
export_dir="${CAPTURE_REFERENCE_EXPORT_DIR:-$tmp_dir/export}"

printf 'Reference smoke %s: operator says the takeoff scale verification did not give feedback.\n' "$smoke_id" >"$transcript_path"
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -v error -f lavfi -i color=c=black:s=64x64:d=1 -pix_fmt yuv420p -movflags +faststart "$video_path"
else
  printf 'reference smoke placeholder video for %s\n' "$smoke_id" >"$video_path"
fi

log "Step 1/3: create external reference capture"
npm --silent run capture:reference -- \
  --mode desktop \
  --source "reference_ingest_smoke" \
  --route-path "/desktop/takeoff" \
  --browser-trace-id "operator-trace:reference-smoke:$smoke_id" \
  --recording-uri "$video_path" \
  --recording-file "$video_path" \
  --transcript-file "$transcript_path" \
  --note "Synthetic reference smoke: Verify Scale did not provide feedback on the takeoff canvas." \
  --title "Reference capture smoke" \
  --summary "Synthetic external reference smoke proving browser-bridge, video, transcript, and operator notes enter one capture-session spine." \
  >"$reference_json"
normalize_json_file "$reference_json"
capture_session_id="$(jq -r '.capture_session_id // empty' "$reference_json")"
if [ -z "$capture_session_id" ]; then
  err "capture:reference did not return capture_session_id"
  cat "$reference_json" >&2
  exit 1
fi
ok "Reference capture session $capture_session_id"
uploaded_count="$(jq -r '(.uploaded_artifacts // []) | length' "$reference_json")"
if [ "$uploaded_count" -lt 2 ]; then
  err "Expected at least 2 stored uploaded artifacts"
  cat "$reference_json" >&2
  exit 1
fi

log "Step 2/3: analyze reference artifacts"
CAPTURE_SESSION_ID="$capture_session_id" npm --silent run capture:analyze >"$analyze_json"
normalize_json_file "$analyze_json"
eligible_count="$(jq -r '.eligible_artifact_count // 0' "$analyze_json")"
analysis_count="$(jq -r '.analysis_event_count // 0' "$analyze_json")"
if [ "$eligible_count" -lt 3 ] || [ "$analysis_count" -lt 3 ]; then
  err "Expected at least 3 reference artifacts analyzed; eligible=$eligible_count analysis=$analysis_count"
  cat "$analyze_json" >&2
  exit 2
fi
ok "Reference artifact analysis ready"

log "Step 3/3: export reference corpus"
CAPTURE_SESSION_ID="$capture_session_id" npm --silent run capture:export -- --include-artifact-files --out-dir "$export_dir" >"$export_json"
normalize_json_file "$export_json"
artifact_count="$(jq -r '.artifact_count // 0' "$export_json")"
exported_file_count="$(jq -r '.exported_artifact_file_count // 0' "$export_json")"
video_command_file="$(jq -r '.video_command_file // empty' "$export_json")"
if [ "$artifact_count" -lt 4 ] || [ "$exported_file_count" -lt 2 ] || [ -z "$video_command_file" ]; then
  err "Expected at least 4 artifacts, 2 exported files, and video handoff command; got artifacts=$artifact_count exported_files=$exported_file_count video_command_file=${video_command_file:-none}"
  cat "$export_json" >&2
  exit 3
fi
ok "Reference corpus exported"

jq -n \
  --slurpfile reference "$reference_json" \
  --slurpfile analyze "$analyze_json" \
  --slurpfile export "$export_json" \
  '{
    capture_session_id: $reference[0].capture_session_id,
    work_item_id: $reference[0].work_item_id,
    support_packet_id: $reference[0].support_packet_id,
    reference: $reference[0],
    analyze: $analyze[0],
    export: $export[0]
  }'

ok "Reference capture ingress smoke completed"
