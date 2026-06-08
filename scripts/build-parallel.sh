#!/usr/bin/env bash
#
# Parallel monorepo build by dependency tier.
#
# The default root `npm run build` chains all 16 workspaces with `&&` — strictly
# serial, so on the 24-core fleet build host it uses ~1 core at a time. Each
# workspace build is single-threaded (`tsc -p tsconfig.build.json`, or `vite
# build` for web), so the win is running INDEPENDENT workspaces concurrently.
#
# The internal @sitelayer/* dependency graph is a clean 3-tier DAG (verified):
#   tier 0 (no internal deps):  config domain logger workflows capture-schema formula-evaluator
#   tier 1 (depend on tier 0):  queue scenario capture-catalog pipe-blueprint pipe-roomplan pipe-photogrammetry pipe-drone
#   tier 2 (apps):              api web worker
# A package only needs the .d.ts of packages in an EARLIER tier, so each tier is
# built concurrently and tiers run in order. Fails fast if ANY package fails.
#
# Used by `npm run build` (the gate + deploy both call it). `npm run build:serial`
# keeps the original chain as a fallback.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/sitelayer-build.XXXXXX")"
trap 'rm -rf "$LOGDIR"' EXIT

build_tier() {
  local name="$1"; shift
  echo "==> [build] tier '$name': $*"
  local pids=() entry pid ws rc=0
  for ws in "$@"; do
    npm run build --workspace "$ws" >"$LOGDIR/${ws##*/}.log" 2>&1 &
    pids+=("$!:$ws")
  done
  for entry in "${pids[@]}"; do
    pid="${entry%%:*}"; ws="${entry#*:}"
    if ! wait "$pid"; then
      echo "ERROR: build failed: $ws" >&2
      echo "------ $ws build output ------" >&2
      cat "$LOGDIR/${ws##*/}.log" >&2
      rc=1
    fi
  done
  return "$rc"
}

t0=$(date +%s)
build_tier "leaf" @sitelayer/config @sitelayer/domain @sitelayer/logger @sitelayer/workflows @sitelayer/projectkit-bridge @sitelayer/capture-schema @sitelayer/formula-evaluator || exit 1
build_tier "mid"  @sitelayer/queue @sitelayer/scenario @sitelayer/capture-catalog @sitelayer/pipe-blueprint @sitelayer/pipe-roomplan @sitelayer/pipe-photogrammetry @sitelayer/pipe-drone || exit 1
build_tier "apps" @sitelayer/api @sitelayer/web @sitelayer/worker || exit 1
echo "==> [build] parallel build complete in $(( $(date +%s) - t0 ))s"
