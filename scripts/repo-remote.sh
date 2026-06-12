#!/usr/bin/env bash
#
# Shared repo-remote resolution — the ONE place the Sitelayer git remote URL is
# defined for every deploy/verify consumer:
#
#   scripts/deploy.sh                  (preview-droplet checkout, dev/demo)
#   scripts/deploy-production-local.sh (prod-droplet checkout)
#   scripts/fleet-auto-deploy.sh       (fleet watcher's dedicated checkout)
#   scripts/e2e-runner.sh              (e2e runner's dedicated checkout)
#
# Override with SITELAYER_REPO_URL. Supported forms:
#   https://github.com/GitSteveLozano/sitelayer.git              (anonymous —
#       only works while the repo is public; today's default)
#   https://x-access-token:<TOKEN>@github.com/GitSteveLozano/sitelayer.git
#       (fine-grained read-only deploy token, for the private cutover)
#   git@github.com:GitSteveLozano/sitelayer.git                  (SSH deploy key)
#
# SECRET HYGIENE: the URL may embed a token. NEVER echo/log it raw — pass it
# through sitelayer_repo_url_redacted first, and never `set -x` around code
# that expands it. The cutover steps live in
# docs/RUNBOOK_REPO_PRIVATE_CUTOVER.md.
#
# Exported so child scripts (e.g. fleet-auto-deploy.sh -> deploy.sh in the
# dedicated checkout) resolve the SAME remote without re-plumbing.

export SITELAYER_REPO_URL="${SITELAYER_REPO_URL:-https://github.com/GitSteveLozano/sitelayer.git}"

# Print the URL with any https userinfo (user:token@) redacted — the only form
# safe for logs, echoes, and error messages.
sitelayer_repo_url_redacted() {
  local url="${1:-$SITELAYER_REPO_URL}"
  printf '%s' "$url" | sed -E 's#^([a-z+]+://)[^/@]+@#\1***@#'
}
