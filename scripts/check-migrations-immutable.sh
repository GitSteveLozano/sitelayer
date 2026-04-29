#!/usr/bin/env bash
#
# Forward-only migration guard.
#
# Migrations under docker/postgres/init/*.sql are append-only. Once a file
# lands on main and has been applied to a real Postgres (preview or prod),
# editing or deleting it is a bug: the runtime ledger will detect a
# checksum mismatch and refuse to apply, which means the deploy that
# included the edit will be rejected at the migration step.
#
# This script catches that class of mistake at PR time so it never reaches
# a deploy. It compares the current branch against the merge base with
# origin/main and fails if any pre-existing migration file is modified or
# removed. New files (status A) are always allowed.
#
# Run locally:
#   bash scripts/check-migrations-immutable.sh
#
# CI usage: see .github/workflows/quality.yml.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_DIR="docker/postgres/init"
DEFAULT_BASE="${BASE_REF:-origin/main}"

cd "$REPO_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not inside a git work tree" >&2
  exit 1
fi

# Prefer the merge-base so feature branches that lag behind main don't
# trip on unrelated commits. Fall back to comparing directly when the
# merge-base lookup fails (e.g. shallow clone in CI without history).
if base="$(git merge-base "$DEFAULT_BASE" HEAD 2>/dev/null)"; then
  range="$base...HEAD"
else
  range="$DEFAULT_BASE...HEAD"
fi

# git diff --name-status returns codes like:
#   A  added
#   M  modified
#   D  deleted
#   R### renamed
# Allow only A. Anything else against an existing migration is forbidden.
violations="$(git diff --name-status "$range" -- "$MIGRATION_DIR" \
  | awk '$1 != "A" && $2 ~ /^docker\/postgres\/init\/.*\.sql$/ { print }' || true)"

if [ -n "$violations" ]; then
  echo "ERROR: migrations are append-only. The following pre-existing migration files were modified or removed against $DEFAULT_BASE:" >&2
  printf '%s\n' "$violations" >&2
  echo >&2
  echo "If you must change behavior, add a NEW migration with the next sequential number." >&2
  echo "If you genuinely need to amend an unapplied migration on a feature branch and" >&2
  echo "are sure it has not been applied to any environment, set MIGRATION_GUARD_OVERRIDE=1." >&2
  if [ "${MIGRATION_GUARD_OVERRIDE:-}" != "1" ]; then
    exit 2
  fi
  echo "MIGRATION_GUARD_OVERRIDE=1 set; continuing." >&2
fi

echo "Migration immutability check passed (range: $range)"
