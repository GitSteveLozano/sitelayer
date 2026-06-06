#!/usr/bin/env bash
#
# Synthetic speech-to-text QA for the capture stack.
#
# This proves the no-paid path that Sitelayer capture uses now:
# local Piper TTS -> local voice-tools Whisper HTTP -> local WER scoring.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  npm run capture:audio-qa

Optional:
  CAPTURE_AUDIO_QA_OUT_DIR      default: /tmp/sitelayer-capture-audio-qa/<timestamp>
  CAPTURE_AUDIO_QA_MAX_WER      default: 0.25
  CAPTURE_AUDIO_QA_WPMS         default: "130 180 230"
  CAPTURE_ARTIFACT_WHISPER_URL default: VT_WHISPER_URL or http://127.0.0.1:5678
  CAPTURE_AUDIO_QA_TIMEOUT      default: 120
  VOICE_TOOLS_DIR               default: /home/taylorsando/projects/voice-tools

Extra arguments:
  --wpm N                       add one WPM case; repeatable
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

require_cmd curl
require_cmd python3

voice_tools_dir="${VOICE_TOOLS_DIR:-/home/taylorsando/projects/voice-tools}"
if [ -f "$voice_tools_dir/config/voice-tools.env" ]; then
  # shellcheck source=/home/taylorsando/projects/voice-tools/config/voice-tools.env
  source "$voice_tools_dir/config/voice-tools.env"
fi

piper_bin="${VT_PIPER_BIN:-$voice_tools_dir/models/piper/piper}"
piper_model="${VT_PIPER_MODEL:-$voice_tools_dir/models/piper/en_US-lessac-high.onnx}"
whisper_url="${CAPTURE_ARTIFACT_WHISPER_URL:-${VT_WHISPER_URL:-http://127.0.0.1:${VT_WHISPER_PORT:-5678}}}"
whisper_url="${whisper_url%/}"
timeout="${CAPTURE_AUDIO_QA_TIMEOUT:-120}"
max_wer="${CAPTURE_AUDIO_QA_MAX_WER:-0.25}"

if [ ! -x "$piper_bin" ]; then
  err "Piper binary not found or not executable: $piper_bin"
  exit 5
fi
if [ ! -f "$piper_model" ]; then
  err "Piper model not found: $piper_model"
  exit 5
fi

wpms=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --wpm)
      wpms+=("${2:?--wpm requires a value}")
      shift 2
      ;;
    *)
      err "Unknown argument: $1"
      exit 2
      ;;
  esac
done
if [ "${#wpms[@]}" -eq 0 ]; then
  # shellcheck disable=SC2206
  wpms=(${CAPTURE_AUDIO_QA_WPMS:-130 180 230})
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="${CAPTURE_AUDIO_QA_OUT_DIR:-/tmp/sitelayer-capture-audio-qa/$stamp}"
mkdir -p "$out_dir"

log "Whisper URL: $whisper_url"
log "Audio QA output: $out_dir"
log "Max allowed WER: $max_wer"

curl -fsS --max-time 5 "$whisper_url/health" >"$out_dir/whisper-health.json" || {
  err "Whisper health check failed at $whisper_url/health"
  exit 1
}

export LD_LIBRARY_PATH="$(dirname "$piper_bin"):${LD_LIBRARY_PATH:-}"

case_files=()
case_index=0
for wpm in "${wpms[@]}"; do
  case_index=$((case_index + 1))
  case_dir="$out_dir/case-$case_index-wpm-$wpm"
  mkdir -p "$case_dir"
  expected="The Sitelayer capture audio pipeline records clear feedback and writes a retryable local transcript for the issue board."
  wav="$case_dir/input.wav"
  request_json="$case_dir/whisper-request.json"
  transcript="$case_dir/transcript.txt"
  response_json="$case_dir/whisper-response.json"
  case_json="$case_dir/case.json"
  length_scale="$(python3 - "$wpm" <<'PY'
import sys
wpm = float(sys.argv[1])
print(round(175.0 / wpm, 3))
PY
)"

  printf '%s\n' "$expected" | "$piper_bin" \
    --model "$piper_model" \
    --length_scale "$length_scale" \
    --output_file "$wav" >/dev/null 2>&1

  python3 - "$wav" "$request_json" <<'PY'
import base64, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
out.write_text(json.dumps({
    "audio_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
    "filename": path.name,
    "content_type": "audio/wav",
}, separators=(",", ":")), encoding="utf-8")
PY
  curl -fsS --max-time "$timeout" \
    -X POST "$whisper_url/transcribe" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_json" >"$response_json"

  python3 - "$expected" "$response_json" "$transcript" "$case_json" "$wpm" "$wav" <<'PY'
import json, pathlib, re, sys

expected, response_path, transcript_path, case_path, wpm, wav_path = sys.argv[1:]
response = json.loads(pathlib.Path(response_path).read_text())
actual = str(response.get("text") or "")
pathlib.Path(transcript_path).write_text(actual + "\n", encoding="utf-8")

def words(text):
    return re.findall(r"[a-z0-9]+", text.lower())

ref = words(expected)
hyp = words(actual)
dp = [[0] * (len(hyp) + 1) for _ in range(len(ref) + 1)]
for i in range(len(ref) + 1):
    dp[i][0] = i
for j in range(len(hyp) + 1):
    dp[0][j] = j
for i, rw in enumerate(ref, 1):
    for j, hw in enumerate(hyp, 1):
        dp[i][j] = min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + (0 if rw == hw else 1),
        )
edits = dp[-1][-1]
wer = edits / max(len(ref), 1)
case = {
    "wpm": int(float(wpm)),
    "audio_path": wav_path,
    "transcript_path": transcript_path,
    "expected": expected,
    "transcript": actual,
    "score": {
        "wer": wer,
        "edits": edits,
        "reference_words": len(ref),
        "hypothesis_words": len(hyp),
    },
    "whisper": {
        "language": response.get("language"),
        "duration": response.get("duration"),
        "transcription_time": response.get("transcription_time"),
        "transcript_quality": response.get("transcript_quality"),
    },
}
pathlib.Path(case_path).write_text(json.dumps(case, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  case_files+=("$case_json")
done

python3 - "$out_dir/audio-qa-results.stdout.json" "$whisper_url" "$max_wer" "${case_files[@]}" <<'PY'
import json, pathlib, sys

out_path = pathlib.Path(sys.argv[1])
whisper_url = sys.argv[2]
max_wer = float(sys.argv[3])
cases = [json.loads(pathlib.Path(path).read_text()) for path in sys.argv[4:]]
result = {
    "output_dir": str(out_path.parent),
    "whisper_url": whisper_url,
    "max_wer": max_wer,
    "cases": cases,
}
out_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps({
    "output_dir": result["output_dir"],
    "whisper_url": whisper_url,
    "cases": [
        {
            "wpm": case["wpm"],
            "transcript_path": case["transcript_path"],
            "score": case["score"],
            "wall_time_s": case["whisper"].get("transcription_time"),
        }
        for case in cases
    ],
}, indent=2, sort_keys=True))
if any((case.get("score", {}).get("wer", 999) > max_wer) for case in cases):
    raise SystemExit(1)
PY

ok "Audio QA passed"
