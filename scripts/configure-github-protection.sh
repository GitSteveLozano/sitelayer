#!/usr/bin/env bash
set -euo pipefail

OWNER_REPO="${OWNER_REPO:-${GITHUB_REPOSITORY:-GitSteveLozano/sitelayer}}"
BRANCH="${BRANCH:-main}"
QUALITY_CONTEXT="${QUALITY_CONTEXT:-Quality / validate}"

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
  "required_status_checks": {
    "strict": true,
    "contexts": ["$QUALITY_CONTEXT"]
  },
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

echo "Configured protection for $OWNER_REPO:$BRANCH requiring '$QUALITY_CONTEXT'"
echo "Configure the GitHub production environment with required reviewers to enforce deploy approval."
