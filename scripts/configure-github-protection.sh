#!/usr/bin/env bash
#
# OPTIONAL code-review hygiene for the `main` branch (require PR + 1 review,
# block force-push/deletions). This is NOT a deploy gate and is NOT required
# for deploying: under the local-fleet model the prod-ship gate is the LOCAL
# verification gate scripts/verify-local.sh, run by scripts/deploy.sh before
# it ships, and nothing in the deploy path queries GitHub.
#
# The repo runs ZERO GitHub Actions (quality.yml was deleted 2026-06-02), so
# there are NO status checks to require — this configures PR + review hygiene
# only. Requiring a non-existent status-check context would wedge every PR, so
# required_status_checks is left null here.
set -euo pipefail

OWNER_REPO="${OWNER_REPO:-${GITHUB_REPOSITORY:-GitSteveLozano/sitelayer}}"
BRANCH="${BRANCH:-main}"

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is required" >&2
  exit 1
fi

gh auth status >/dev/null

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/$OWNER_REPO/branches/$BRANCH/protection" \
  --input - <<JSON
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "require_last_push_approval": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON

echo "Configured protection for $OWNER_REPO:$BRANCH"
echo "  required status checks: none (the repo runs zero GitHub Actions)"
echo "  required PR reviews: 1 (dismiss stale, require last-push approval)"
echo "  force-push: disabled; deletions: disabled; conversation resolution: required"
echo "Note: this is code-review hygiene only. Deploy approval is NOT a GitHub concern —"
echo "      the prod gate is the local verification gate scripts/verify-local.sh,"
echo "      run by scripts/deploy.sh."
