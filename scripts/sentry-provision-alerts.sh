#!/usr/bin/env bash
# Idempotent provisioning of Sentry alert rules for Sitelayer.
#
# Default Sentry already emails ActiveMembers (= Taylor) when an issue is
# marked high-priority — that's the auto-rule "Send a notification for
# high priority issues" created at project setup. This script adds two
# more rules per project (sitelayer-api, sitelayer-web):
#
#   1. Error spike: 10+ events in 5 minutes (catches incidents before the
#      high-priority heuristic kicks in).
#   2. New issue first-seen: any new issue in production. Lower volume,
#      higher signal — early warning for novel failure modes.
#
# Idempotent by rule name: skips rules that already exist. Run as often
# as needed.
#
# Prereq: SENTRY_PROVISION_TOKEN with project:write or alerts:write.
# Mint at https://sentry.io/settings/account/api/auth-tokens/ (User-scoped
# token, "Create New Token", scopes: project:read, project:write,
# alerts:read, alerts:write).
#
# Usage:
#   SENTRY_PROVISION_TOKEN=sntryu_... ./scripts/sentry-provision-alerts.sh
#
# To smoke-test the email destination after provisioning, throw a known
# error into prod (e.g. hit a debug endpoint) and confirm the email lands.

set -euo pipefail

ORG="${SENTRY_ORG:-sandolabs}"
PROJECTS=("sitelayer-api" "sitelayer-web")
TOKEN="${SENTRY_PROVISION_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "error: SENTRY_PROVISION_TOKEN is required (mint at https://sentry.io/settings/account/api/auth-tokens/)" >&2
  exit 1
fi

call() {
  curl -fsS \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

ensure_rule() {
  local project="$1"
  local rule_name="$2"
  local rule_body="$3"

  local existing_id
  existing_id="$(call "https://sentry.io/api/0/projects/$ORG/$project/rules/" \
    | jq -r --arg n "$rule_name" '.[] | select(.name == $n) | .id' \
    | head -1)"

  if [ -n "$existing_id" ]; then
    echo "  exists: [$project] $rule_name (id=$existing_id)"
    return 0
  fi

  echo "  creating: [$project] $rule_name"
  call -X POST "https://sentry.io/api/0/projects/$ORG/$project/rules/" \
    -d "$rule_body" >/dev/null
}

for project in "${PROJECTS[@]}"; do
  echo "Project: $project"

  # Rule 1 — error spike (count-based)
  spike_body="$(cat <<EOF
{
  "name": "$project — error spike (10+ events in 5 minutes)",
  "environment": "production",
  "actionMatch": "all",
  "filterMatch": "all",
  "frequency": 30,
  "conditions": [
    {
      "id": "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
      "interval": "5m",
      "value": 10,
      "comparisonType": "count"
    }
  ],
  "filters": [],
  "actions": [
    {
      "id": "sentry.mail.actions.NotifyEmailAction",
      "targetType": "IssueOwners",
      "fallthroughType": "ActiveMembers"
    }
  ]
}
EOF
  )"
  ensure_rule "$project" "$project — error spike (10+ events in 5 minutes)" "$spike_body"

  # Rule 2 — new issue first-seen in production
  newissue_body="$(cat <<EOF
{
  "name": "$project — new issue in production",
  "environment": "production",
  "actionMatch": "all",
  "filterMatch": "all",
  "frequency": 30,
  "conditions": [
    {
      "id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"
    }
  ],
  "filters": [],
  "actions": [
    {
      "id": "sentry.mail.actions.NotifyEmailAction",
      "targetType": "IssueOwners",
      "fallthroughType": "ActiveMembers"
    }
  ]
}
EOF
  )"
  ensure_rule "$project" "$project — new issue in production" "$newissue_body"
done

echo
echo "Done. Verify in https://sentry.io/organizations/$ORG/alerts/rules/"
echo "Email destination: ActiveMembers fallback → all members of the org will receive."
echo "Test by triggering an error in prod (e.g. \`curl https://sitelayer.sandolab.xyz/api/intentional-500\` if such a debug endpoint exists)."
