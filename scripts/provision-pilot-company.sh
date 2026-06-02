#!/usr/bin/env bash
#
# Provision a sitelayer pilot company + initial memberships against a
# running API (prod, preview, or local). Wraps the two endpoints listed
# as Phase 3 onboarding items in CLAUDE.md:
#
#   1. POST /api/companies                              creates the company
#                                                       and makes the
#                                                       caller (admin) the
#                                                       first member
#   2. POST /api/companies/:id/memberships              invites each crew
#                                                       member by their
#                                                       Clerk user id
#
# Why a script (not a wizard UI):
#   - The pilot rollout doctrine in CLAUDE.md ("Provision first pilot
#     company + memberships") names these two endpoints explicitly. A
#     bash wrapper is the smallest thing that ratchets it from
#     "unchecked" to "checked".
#   - Production deploys go through the local-fleet path
#     (scripts/deploy.sh prod, off GitHub Actions), but provisioning is a
#     one-time tenant bootstrap done by the operator AFTER deploy with
#     their Clerk identity. Curl-from-host is the right granularity.
#
# Required env:
#   SITELAYER_API_URL       e.g. https://sitelayer.sandolab.xyz/api or
#                                http://localhost:3001
#   SITELAYER_CLERK_TOKEN   Bearer JWT from the operator's Clerk session.
#                                Capture from browser DevTools →
#                                Application → Session Token (or via the
#                                Clerk Dashboard).
#
# Required args:
#   --slug <slug>           lowercase letters/digits/dashes, 2-64 chars
#   --name "<Display Name>" human-readable company name
#
# Optional args (repeatable):
#   --invite <clerk_user_id>:<role>
#                                 invite a crew member by Clerk user id
#                                 with one of: admin, member, foreman,
#                                 office, bookkeeper
#
# Examples:
#
#   # Provision a brand-new pilot company with a foreman + an office user.
#   export SITELAYER_API_URL=https://sitelayer.sandolab.xyz
#   export SITELAYER_CLERK_TOKEN="<bearer jwt>"
#   ./scripts/provision-pilot-company.sh \
#       --slug "acme-construction" \
#       --name "Acme Construction" \
#       --invite "user_2bRJ8sX...":foreman \
#       --invite "user_2bRMqWk...":office
#
# Exit codes:
#   0  all calls returned 2xx
#   1  argument validation failed
#   2  POST /api/companies failed (4xx/5xx; the company was not created)
#   3  one or more membership invites failed (company was created but
#      partial membership state; rerun with the same --slug + remaining
#      --invite args to retry — the API upserts by (company_id, clerk_user_id))

set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;s/^#$//'
  exit "${1:-1}"
}

SLUG=""
NAME=""
INVITES=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --slug)        SLUG="${2:-}"; shift 2 ;;
    --name)        NAME="${2:-}"; shift 2 ;;
    --invite)      INVITES+=("${2:-}"); shift 2 ;;
    -h|--help)     usage 0 ;;
    *)             echo "unknown arg: $1" >&2; usage 1 ;;
  esac
done

: "${SITELAYER_API_URL:?SITELAYER_API_URL must point at the sitelayer API base URL}"
: "${SITELAYER_CLERK_TOKEN:?SITELAYER_CLERK_TOKEN must be the operator bearer JWT}"

if [ -z "$SLUG" ] || [ -z "$NAME" ]; then
  echo "ERROR: both --slug and --name are required" >&2
  usage 1
fi

if ! echo "$SLUG" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'; then
  echo "ERROR: --slug must be 2-64 chars, lowercase letters/digits/dashes" >&2
  exit 1
fi

API_BASE="${SITELAYER_API_URL%/}"
AUTH_HEADER="Authorization: Bearer ${SITELAYER_CLERK_TOKEN}"

echo "→ provisioning company slug=${SLUG} name=${NAME} against ${API_BASE}"

CREATE_BODY=$(printf '{"slug":"%s","name":"%s"}' "$SLUG" "$NAME")
CREATE_RESP=$(curl -sS -X POST \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "$CREATE_BODY" \
  -w '\n%{http_code}' \
  "${API_BASE}/api/companies")

CREATE_CODE="${CREATE_RESP##*$'\n'}"
CREATE_JSON="${CREATE_RESP%$'\n'*}"

if [ "$CREATE_CODE" != "201" ]; then
  echo "ERROR: POST /api/companies returned ${CREATE_CODE}" >&2
  echo "$CREATE_JSON" >&2
  exit 2
fi

COMPANY_ID=$(echo "$CREATE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['company']['id'])")
echo "  ✓ company created: id=${COMPANY_ID}"

EXIT=0
for INVITE in "${INVITES[@]:-}"; do
  [ -z "$INVITE" ] && continue
  INVITE_USER="${INVITE%%:*}"
  INVITE_ROLE="${INVITE##*:}"
  if [ -z "$INVITE_USER" ] || [ -z "$INVITE_ROLE" ] || [ "$INVITE_USER" = "$INVITE_ROLE" ]; then
    echo "WARN: skipping malformed --invite ${INVITE} (expected clerk_user_id:role)" >&2
    EXIT=3
    continue
  fi
  case "$INVITE_ROLE" in
    admin|member|foreman|office|bookkeeper) : ;;
    *)
      echo "WARN: skipping --invite ${INVITE} (role must be admin|member|foreman|office|bookkeeper)" >&2
      EXIT=3
      continue ;;
  esac

  M_BODY=$(printf '{"clerk_user_id":"%s","role":"%s"}' "$INVITE_USER" "$INVITE_ROLE")
  M_RESP=$(curl -sS -X POST \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$M_BODY" \
    -w '\n%{http_code}' \
    "${API_BASE}/api/companies/${COMPANY_ID}/memberships")

  M_CODE="${M_RESP##*$'\n'}"
  M_JSON="${M_RESP%$'\n'*}"

  if [ "$M_CODE" != "201" ]; then
    echo "  ✗ membership invite failed for ${INVITE_USER} (${INVITE_ROLE}): HTTP ${M_CODE}" >&2
    echo "    $M_JSON" >&2
    EXIT=3
  else
    echo "  ✓ membership invited: ${INVITE_USER} as ${INVITE_ROLE}"
  fi
done

echo "done — company_id=${COMPANY_ID} (exit=${EXIT})"
exit "$EXIT"
