#!/usr/bin/env bash
#
# Export one Sitelayer capture session and optionally run the existing
# capture/agent-cli reviewer lane.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  CAPTURE_SESSION_ID=<uuid> DATABASE_URL=postgres://... npm run capture:review

Required:
  CAPTURE_SESSION_ID
  DATABASE_URL

Optional:
  CAPTURE_REVIEWER=gemini|antigravity|auto  default: gemini
  CAPTURE_REVIEW_OUT_DIR=DIR                default: /tmp/sitelayer-capture-export/<id>
  CAPTURE_REVIEW_USE_VIDEO=1                prefer run-capture-analyze-video.sh when available
  CAPTURE_REVIEW_DEEP=1                     ask capture-analyze for one comprehensive task
  CAPTURE_REVIEW_EXECUTE=1                  actually run capture-analyze

Default behavior is prepare-only. It exports the corpus, prints the generated
command path, and does not spend Gemini/Antigravity/agent-cli quota unless
CAPTURE_REVIEW_EXECUTE=1 is set. After a reviewer writes markdown/json output,
attach it back to the same session with:

  CAPTURE_SESSION_ID=<uuid> REVIEW_FILE=/path/review.md DATABASE_URL=... npm run capture:review-import
EOF
  exit 0
fi

err() { printf '\033[31mFAIL %s\033[0m\n' "$*" >&2; }
log() { printf '\033[36mINFO %s\033[0m\n' "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command missing: $1"
    exit 5
  fi
}

require_cmd jq
require_cmd npm

if [ -z "${CAPTURE_SESSION_ID:-}" ]; then
  err "CAPTURE_SESSION_ID is required"
  exit 5
fi
if [ -z "${DATABASE_URL:-}" ]; then
  err "DATABASE_URL is required"
  exit 5
fi

reviewer="${CAPTURE_REVIEWER:-gemini}"
case "$reviewer" in
  auto|gemini|antigravity) ;;
  *)
    err "CAPTURE_REVIEWER must be auto, gemini, or antigravity"
    exit 5
    ;;
esac

out_dir="${CAPTURE_REVIEW_OUT_DIR:-/tmp/sitelayer-capture-export/$CAPTURE_SESSION_ID}"
export_json="$(mktemp)"
trap 'rm -f "$export_json"' EXIT

args=(--include-artifact-files --out-dir "$out_dir" --reviewer "$reviewer")
if [ "${CAPTURE_REVIEW_DEEP:-0}" = "1" ]; then
  args+=(--deep)
fi

log "Exporting capture corpus for reviewer=$reviewer"
npm --silent run capture:export -- "${args[@]}" >"$export_json"

command_file="$(jq -r '.command_file // empty' "$export_json")"
video_command_file="$(jq -r '.video_command_file // empty' "$export_json")"
selected_command="$command_file"
if [ "${CAPTURE_REVIEW_USE_VIDEO:-0}" = "1" ] && [ -n "$video_command_file" ]; then
  selected_command="$video_command_file"
fi

if [ -z "$selected_command" ] || [ ! -x "$selected_command" ]; then
  err "Generated capture-analyze command is missing or not executable: $selected_command"
  cat "$export_json" >&2
  exit 6
fi

if [ "${CAPTURE_REVIEW_EXECUTE:-0}" != "1" ]; then
  jq --arg selected_command "$selected_command" \
    '. + {
      prepared_only: true,
      selected_command: $selected_command,
      execute_note: "Set CAPTURE_REVIEW_EXECUTE=1 to run the selected capture-analyze command."
    }' "$export_json"
  exit 0
fi

log "Running $selected_command"
"$selected_command"
