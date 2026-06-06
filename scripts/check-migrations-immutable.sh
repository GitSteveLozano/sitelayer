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
# This script catches that class of mistake before a deploy. It compares the
# current branch against the merge base with origin/main and fails if any
# pre-existing migration file is modified or removed. New files (status A) are
# always allowed.
#
# Run locally:
#   bash scripts/check-migrations-immutable.sh
#
# Gate usage: this runs as part of the local gate scripts/verify-local.sh,
# which scripts/deploy.sh runs before it ships. The repo runs no GitHub
# Actions.
#
# This check HARD-FAILS by default: any modified/removed pre-existing migration
# is exit 2 unless MIGRATION_GUARD_OVERRIDE is EXPLICITLY set to exactly "1".
# The override is the sanctioned squash escape (docs/MIGRATION_BASELINE.md) and
# is intentionally LOUD when used so it can never be mistaken for a passing gate.
# Any value other than "1" (including empty/unset) leaves the guard armed.

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
  # Hard-fail unless the operator EXPLICITLY opted into the sanctioned squash
  # escape with exactly MIGRATION_GUARD_OVERRIDE=1. Empty/unset/any-other-value
  # keeps the guard armed (exit 2) — this is the whole point of the gate.
  if [ "${MIGRATION_GUARD_OVERRIDE:-}" != "1" ]; then
    exit 2
  fi
  # Be LOUD: the override means migration history is being intentionally
  # rewritten. This banner makes the bypass impossible to miss in gate logs.
  echo "############################################################" >&2
  echo "## MIGRATION_GUARD_OVERRIDE=1 — immutability guard BYPASSED" >&2
  echo "## A pre-existing migration was modified/removed and allowed" >&2
  echo "## through DELIBERATELY (sanctioned squash; see"             >&2
  echo "## docs/MIGRATION_BASELINE.md). Confirm this is intended."   >&2
  echo "############################################################" >&2
fi

echo "Migration immutability check passed (range: $range)"
