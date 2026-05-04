#!/usr/bin/env bash
#
# Block new files under apps/web/src/ (v1, retired).
#
# Production runs apps/web-v2/. The Dockerfile only COPYs apps/web-v2/dist,
# docker-compose.prod.yml runs `npm start -w @sitelayer/web-v2`, and v1
# is kept only as the rollback target during the post-cutover release
# window per ADR 0002 cutover criterion #6.
#
# Despite that, agents (and Steve via web-UI uploads) keep adding net-new
# screens, components, and views under apps/web/src/. PR #229 and #231
# together added 1,700+ LOC of mobile design system into v1 — none of it
# ships, and it duplicates primitives that already exist in
# apps/web-v2/src/components/mobile/.
#
# This guard catches that at PR time. Modifications to existing files
# under apps/web/src/ are allowed (so the rollback target stays
# patchable), but new files (git status A) are rejected. The right
# place for new mobile UI work is apps/web-v2/src/.
#
# Run locally:
#   bash scripts/check-no-new-v1-files.sh
#
# CI usage: see .github/workflows/quality.yml.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARDED_PATH="apps/web/src"
DEFAULT_BASE="${BASE_REF:-origin/main}"

cd "$REPO_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not inside a git work tree" >&2
  exit 1
fi

# Prefer merge-base so feature branches that lag behind main don't trip
# on unrelated commits. Fall back to comparing directly when merge-base
# fails (shallow clone in CI without history).
if base="$(git merge-base "$DEFAULT_BASE" HEAD 2>/dev/null)"; then
  range="$base...HEAD"
else
  range="$DEFAULT_BASE...HEAD"
fi

# Allow modifications (M), deletions (D), renames (R) of existing files —
# only block additions (A) of net-new files.
new_files="$(git diff --name-status "$range" -- "$GUARDED_PATH" \
  | awk -v p="$GUARDED_PATH" '$1 == "A" && $2 ~ p {print $2}' || true)"

if [ -n "$new_files" ]; then
  cat >&2 <<EOF
ERROR: new files added under $GUARDED_PATH/ on this branch:

$(printf '  %s\n' $new_files)

apps/web/ is RETIRED (see apps/web/RETIRED.md). It exists only as the
post-cutover rollback target per ADR 0002. New UI work belongs in
apps/web-v2/, where the production app lives.

If you are adding a new mobile primitive, the place is:
  apps/web-v2/src/components/mobile/

If you are adding a new screen, the place is:
  apps/web-v2/src/screens/<persona>/

Modifications to existing files under apps/web/src/ are allowed (so the
rollback target stays patchable). To override this guard for a
legitimate v1 rollback patch that genuinely needs a new file, set
V1_GUARD_OVERRIDE=1.
EOF
  if [ "${V1_GUARD_OVERRIDE:-}" != "1" ]; then
    exit 2
  fi
  echo "V1_GUARD_OVERRIDE=1 set; continuing." >&2
fi

echo "v1 no-new-files check passed (range: $range)"
