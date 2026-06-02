#!/usr/bin/env bash
#
# Install the repo-tracked git hooks by pointing git at .githooks via
# core.hooksPath. Idempotent: re-running just re-asserts the config and
# re-marks the hooks executable.
#
# Why core.hooksPath (not copying into .git/hooks): the hooks are VERSIONED in
# .githooks/ so every clone gets the same pre-push gate, and a stray edit to a
# .git/hooks file can't silently diverge from what's committed. The tradeoff is
# that core.hooksPath is per-clone local config, so each developer runs this
# once after cloning.
#
# Usage:
#   scripts/install-git-hooks.sh          # set core.hooksPath = .githooks
#   scripts/install-git-hooks.sh --check  # report current state, change nothing
#   scripts/install-git-hooks.sh --uninstall  # unset core.hooksPath
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HOOKS_DIR=".githooks"
ACTION="install"

for arg in "$@"; do
  case "$arg" in
    --check) ACTION="check" ;;
    --uninstall) ACTION="uninstall" ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install-git-hooks: unknown argument: $arg" >&2
      echo "  see: scripts/install-git-hooks.sh --help" >&2
      exit 2
      ;;
  esac
done

current="$(git config --local --get core.hooksPath 2>/dev/null || true)"

if [ "$ACTION" = "check" ]; then
  if [ "$current" = "$HOOKS_DIR" ]; then
    echo "git hooks: INSTALLED (core.hooksPath = $current)"
    exit 0
  fi
  echo "git hooks: NOT installed (core.hooksPath = '${current:-<unset>}', expected $HOOKS_DIR)"
  echo "  run: scripts/install-git-hooks.sh"
  exit 1
fi

if [ "$ACTION" = "uninstall" ]; then
  if [ -n "$current" ]; then
    git config --local --unset core.hooksPath || true
    echo "==> Unset core.hooksPath (was '$current'). Repo git hooks are now disabled."
  else
    echo "==> core.hooksPath was not set; nothing to do."
  fi
  exit 0
fi

# install
if [ ! -d "$HOOKS_DIR" ]; then
  echo "ERROR: $HOOKS_DIR/ not found at repo root ($REPO_ROOT)." >&2
  exit 1
fi

# Make every tracked hook executable (idempotent).
find "$HOOKS_DIR" -maxdepth 1 -type f -exec chmod +x {} +

if [ "$current" = "$HOOKS_DIR" ]; then
  echo "==> core.hooksPath already = $HOOKS_DIR (idempotent no-op)."
else
  git config --local core.hooksPath "$HOOKS_DIR"
  echo "==> Set core.hooksPath = $HOOKS_DIR (was '${current:-<unset>}')."
fi

echo
echo "Installed git hooks (versioned in $HOOKS_DIR/):"
find "$HOOKS_DIR" -maxdepth 1 -type f -printf '  %f\n' | sort
echo
cat <<'EOF'
The pre-push hook now runs the STANDARD verification gate (npm run verify) when
you push to 'dev' or 'main', and blocks the push on failure.

  Bypass (emergency only): git push --no-verify
  Check state:             scripts/install-git-hooks.sh --check
  Disable:                 scripts/install-git-hooks.sh --uninstall

e2e is intentionally NOT in the hook (the standard level excludes it) — it runs
on the async runner / npm run verify:full on a quiet box.
EOF
