#!/usr/bin/env bash
#
# Synthetic speech-to-text QA for the capture stack.
#
# This is intentionally a wrapper around the existing capture repo tool:
# /home/taylorsando/projects/capture/bin/capture-audio-qa. It does not invent a
# second STT path. It generates known speech with local Piper, transcribes it
# through the local voice-tools Whisper server, scores word error rate, and
# fails if any case exceeds CAPTURE_AUDIO_QA_MAX_WER.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  npm run capture:audio-qa

Optional:
  CAPTURE_AUDIO_QA_BIN       default: ../capture/bin/capture-audio-qa when present
  CAPTURE_AUDIO_QA_OUT_DIR   default: /tmp/sitelayer-capture-audio-qa/<timestamp>
  CAPTURE_AUDIO_QA_MAX_WER   default: 0.25
  CAPTURE_SESSION_ID         optional local capture registry join key

Extra arguments are forwarded to capture-audio-qa. Examples:
  npm run capture:audio-qa -- --wpm 130 --wpm 230
  CAPTURE_AUDIO_QA_MAX_WER=0.12 npm run capture:audio-qa
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

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
default_bin="$(cd "$repo_root/.." && pwd)/capture/bin/capture-audio-qa"
qa_bin="${CAPTURE_AUDIO_QA_BIN:-$default_bin}"
if [ ! -x "$qa_bin" ]; then
  qa_bin="${CAPTURE_AUDIO_QA_BIN:-capture-audio-qa}"
fi

require_cmd jq
if ! command -v "$qa_bin" >/dev/null 2>&1 && [ ! -x "$qa_bin" ]; then
  err "capture-audio-qa not found. Set CAPTURE_AUDIO_QA_BIN."
  exit 5
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="${CAPTURE_AUDIO_QA_OUT_DIR:-/tmp/sitelayer-capture-audio-qa/$stamp}"
max_wer="${CAPTURE_AUDIO_QA_MAX_WER:-0.25}"
mkdir -p "$out_dir"

args=(--output-dir "$out_dir" --json)
if [ -n "${CAPTURE_SESSION_ID:-}" ]; then
  args+=(--capture-session-id "$CAPTURE_SESSION_ID")
fi
args+=("$@")

log "Audio QA output: $out_dir"
log "Max allowed WER: $max_wer"
"$qa_bin" "${args[@]}" >"$out_dir/audio-qa-results.stdout.json"

jq -e --argjson max "$max_wer" '
  .cases as $cases
  | ($cases | length) > 0
  and all($cases[]; (.score.wer // 999) <= $max)
' "$out_dir/audio-qa-results.stdout.json" >/dev/null || {
  err "One or more audio QA cases exceeded WER threshold $max_wer"
  jq '{output_dir, cases: [.cases[] | {wpm, transcript, score}]}' "$out_dir/audio-qa-results.stdout.json" >&2
  exit 1
}

jq '{output_dir, whisper_url, cases: [.cases[] | {wpm, transcript_path, score, wall_time_s}]}' \
  "$out_dir/audio-qa-results.stdout.json"
ok "Audio QA passed"
