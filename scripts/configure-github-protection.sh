#!/usr/bin/env bash
set -euo pipefail

OWNER_REPO="${OWNER_REPO:-${GITHUB_REPOSITORY:-GitSteveLozano/sitelayer}}"
BRANCH="${BRANCH:-main}"

# Required status-check contexts. The Quality workflow (.github/workflows/quality.yml)
# exposes one check per JOB, and GitHub reports each check's context as the job's
# `name:` — or, when a job has no `name:`, the job *id*. None of the Quality jobs
# set a `name:`, so the contexts are the job ids verbatim:
#   lint-and-typecheck / build / test / test-integration / e2e
# (The previous single "Quality / validate" context never existed — that job was
#  renamed/split — so protection was effectively requiring a check that never
#  reports, which would have wedged every PR.)
# Override with QUALITY_CONTEXTS="a b c" if the job set ever changes.
QUALITY_CONTEXTS="${QUALITY_CONTEXTS:-lint-and-typecheck build test test-integration e2e}"

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is required" >&2
  exit 1
fi

gh auth status >/dev/null

# Build the JSON contexts array from the space-separated QUALITY_CONTEXTS
# (pure bash, no jq dependency). The job ids contain only [a-z-] so plain
# quoting is safe.
CONTEXTS_JSON=""
for ctx in $QUALITY_CONTEXTS; do
  CONTEXTS_JSON="${CONTEXTS_JSON:+$CONTEXTS_JSON, }\"$ctx\""
done
CONTEXTS_JSON="[$CONTEXTS_JSON]"

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/$OWNER_REPO/branches/$BRANCH/protection" \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": $CONTEXTS_JSON
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

echo "Configured protection for $OWNER_REPO:$BRANCH"
echo "  required status checks (strict): $QUALITY_CONTEXTS"
echo "  required PR reviews: 1 (dismiss stale, require last-push approval)"
echo "  force-push: disabled; deletions: disabled; conversation resolution: required"
echo "Configure the GitHub production environment with required reviewers to enforce deploy approval."
