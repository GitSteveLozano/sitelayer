#!/usr/bin/env bash
#
# Sitelayer post-deploy authenticated-MOUNT synthetic (gap #8).
#
#   scripts/render-synthetic.sh <host>
#   scripts/render-synthetic.sh dev.sitelayer.sandolab.xyz
#   SYNTHETIC_HOST=dev.sitelayer.sandolab.xyz scripts/render-synthetic.sh
#
# This is DETECTION, not a gate (same posture as scripts/smoke-tier.sh): it
# runs AFTER a successful dev/demo deploy (wired into the tail of
# scripts/fleet-auto-deploy.sh, right after the smoke step) to confirm a few
# AUTHENTICATED screens actually MOUNT and RENDER on the freshly shipped tier.
#
# WHY THIS EXISTS. smoke-tier.sh only probes JSON endpoints (/health,
# /api/version, /api/session, /api/bootstrap, /api/demo) — nothing renders a
# mounted React screen, so a "blind port" (a screen ported but rendering-broken)
# ships at HTTP 200 and the smoke stays green. This synthetic drives a headless
# browser to mount the cluster screens + the owner-denied screen and asserts
# none of them crash into the root error boundary or render blank.
#
# It reuses the SAME act-as identity channel the e2e fixtures + visual baselines
# use (e2e/synthetic/authenticated-mount.synthetic.spec.ts). On the DEV tier
# that header travels (header fallback ON) so the authed screens mount fully; on
# the DEMO tier the API runs Clerk-ON and ignores the header, so each authed
# route lands on the sign-in shell — the spec treats that as a graceful per-route
# SKIP (not a crash), since the JSON smoke already proved demo is alive +
# correctly auth-gated. So this synthetic is most meaningful on the dev tier,
# which is exactly where blind ports land first.
#
# REQUIREMENTS: node + npx + a Playwright chromium in the checkout that runs it.
# When any is missing the synthetic SKIPS gracefully (exit 0) rather than
# failing a deploy that already shipped — it is detection only.
#
# Exit code: 0 = all mounts rendered (or gracefully skipped), 1 = a render
# failure was detected. The watcher logs a failure LOUDLY but does NOT crash on
# it (the deploy already happened — this only surfaces drift).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

HOST="${1:-${SYNTHETIC_HOST:-}}"
SYNTHETIC_SCHEME="${SYNTHETIC_SCHEME:-https}"
# Allow disabling entirely (e.g. a box with no browser); loud, never silent.
SYNTHETIC_ENABLED="${SYNTHETIC_ENABLED:-1}"

log() { printf 'synthetic[%s] %s\n' "${HOST:-?}" "$*"; }
warn() { printf 'synthetic[%s] WARN %s\n' "${HOST:-?}" "$*" >&2; }

if [ -z "$HOST" ]; then
  echo "usage: scripts/render-synthetic.sh <host>   (or set SYNTHETIC_HOST=<host>)" >&2
  exit 2
fi

if [ "$SYNTHETIC_ENABLED" != "1" ]; then
  log "SKIP — SYNTHETIC_ENABLED=$SYNTHETIC_ENABLED (authenticated-mount synthetic disabled)"
  exit 0
fi

# Detection-only: a missing toolchain must NOT fail a deploy that already
# shipped. Skip gracefully (exit 0) when node/npx is absent.
if ! command -v npx >/dev/null 2>&1; then
  log "SKIP — npx not on PATH; cannot run the headless mount synthetic (detection only)"
  exit 0
fi
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  log "SKIP — node_modules absent in $REPO_ROOT; the mount synthetic needs Playwright installed (detection only)"
  exit 0
fi

BASE_URL="$SYNTHETIC_SCHEME://$HOST"
log "mounting authenticated screens against $BASE_URL"

set +e
( cd "$REPO_ROOT" && E2E_BASE_URL="$BASE_URL" npx playwright test -c e2e/synthetic.config.ts )
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
  log "OK — all authenticated mounts rendered (or were Clerk-gated/skipped)"
  exit 0
fi

# A Playwright run can fail because the browser is not installed (infra), which
# is NOT a render regression. Distinguish: if no chromium is present, SKIP.
if ! ( cd "$REPO_ROOT" && npx playwright install --dry-run chromium >/dev/null 2>&1 ) &&
   [ ! -d "${HOME}/.cache/ms-playwright" ]; then
  warn "Playwright chromium appears unavailable — treating as SKIP, not a render failure (detection only)"
  exit 0
fi

warn "a screen FAILED to render (root error boundary / blank page) — investigate $BASE_URL"
exit 1
