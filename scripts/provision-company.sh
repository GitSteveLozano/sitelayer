#!/usr/bin/env bash
#
# Provision a NEW construction company on a running sitelayer API (prod,
# preview, dev, or local) — the clean, GENERIC, multi-tenant onboarding
# entrypoint for company #2..#N.
#
# This is the trade-neutral successor to scripts/provision-pilot-company.sh
# (which hard-defaults to L&A Operations' own reference data). It:
#
#   1. POST /api/companies                  creates the company row, makes the
#      { slug, name, template }             CALLER (the platform admin running
#                                           this script) the bootstrap admin,
#                                           and seeds GENERIC construction
#                                           defaults (trade-neutral divisions +
#                                           service items) — NOT LA's
#                                           stucco/EIFS divisions. Pass
#                                           --template la-operations to clone
#                                           LA's set instead.
#
#   2a. POST /api/companies/:id/invites     (when --admin-email is given) emails
#       { email, role: admin }              the real first admin an accept link;
#                                           they sign in with Clerk and accept.
#
#   2b. POST /api/companies/:id/memberships (when --admin-clerk-id is given)
#       { clerk_user_id, role: admin }      directly grants admin to a known
#                                           Clerk user id (no email round-trip).
#
#   2c. additional --invite <id>:<role>     extra crew members by Clerk user id.
#
# IDEMPOTENT: re-running with the same --slug is safe. A slug collision on
# step 1 surfaces the API's 409 (and its suggested alternative slug); the
# membership + invite endpoints upsert, so re-running to finish a partial run
# just re-applies the same grants. Step 1's company creation is NOT silently
# skipped on collision — the operator gets a clear 409 so a typo'd slug never
# attaches the wrong tenant.
#
# WHY a script (not a wizard UI): provisioning is a one-time operator bootstrap
# done AFTER deploy with the platform admin's Clerk identity. Curl-from-host is
# the right granularity, and keeps the trust boundary (platform-admin-gated
# POST /api/companies) on the server, not the client.
#
# ---------------------------------------------------------------------------
# Required env:
#   SITELAYER_API_URL       e.g. https://sitelayer.sandolab.xyz or
#                                http://localhost:3001  (with or without /api)
#   SITELAYER_CLERK_TOKEN   Bearer JWT from the platform admin's Clerk session.
#                                The caller MUST be a platform admin (in
#                                PLATFORM_SUPERADMIN_CLERK_IDS or the
#                                platform_admins table) unless the server has
#                                ALLOW_OPEN_COMPANY_SIGNUP=1.
#
# Required args:
#   --slug <slug>           lowercase letters/digits/dashes, 2-64 chars
#   --name "<Display Name>" human-readable company name
#
# Optional args:
#   --template <slug>       seed template slug (default: generic-construction).
#                                Known: generic-construction, la-operations.
#                                Unknown slugs fall back to generic on the API.
#   --no-seed               create the company with NO seed defaults at all.
#   --admin-email <email>   invite the first admin by email (they accept in
#                                the app). Repeatable for more admins.
#   --admin-clerk-id <id>   grant admin directly to a known Clerk user id.
#                                Repeatable.
#   --invite <id>:<role>    add a crew member by Clerk user id with one of:
#                                admin, member, foreman, office, bookkeeper.
#                                Repeatable.
#
# Examples:
#
#   export SITELAYER_API_URL=https://sitelayer.sandolab.xyz
#   export SITELAYER_CLERK_TOKEN="<platform-admin bearer jwt>"
#
#   # Generic construction company, invite the owner by email:
#   ./scripts/provision-company.sh \
#       --slug "northstar-builders" \
#       --name "Northstar Builders" \
#       --admin-email "owner@northstar.example"
#
#   # Clone L&A's reference set for a similar stucco sub, admin by Clerk id:
#   ./scripts/provision-company.sh \
#       --slug "westside-stucco" --name "Westside Stucco" \
#       --template la-operations \
#       --admin-clerk-id "user_2bRJ8sX..." \
#       --invite "user_2bRMqWk...":foreman
#
# Exit codes:
#   0  all calls returned 2xx
#   1  argument validation failed
#   2  POST /api/companies failed (4xx/5xx; the company was not created)
#   3  one or more invite/membership calls failed (company exists; rerun with
#      the same --slug + remaining grants to retry — the API upserts)

set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;s/^#$//'
  exit "${1:-1}"
}

SLUG=""
NAME=""
TEMPLATE="generic-construction"
SEED="true"
ADMIN_EMAILS=()
ADMIN_CLERK_IDS=()
INVITES=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --slug)           SLUG="${2:-}"; shift 2 ;;
    --name)           NAME="${2:-}"; shift 2 ;;
    --template)       TEMPLATE="${2:-}"; shift 2 ;;
    --no-seed)        SEED="false"; shift ;;
    --admin-email)    ADMIN_EMAILS+=("${2:-}"); shift 2 ;;
    --admin-clerk-id) ADMIN_CLERK_IDS+=("${2:-}"); shift 2 ;;
    --invite)         INVITES+=("${2:-}"); shift 2 ;;
    -h|--help)        usage 0 ;;
    *)                echo "unknown arg: $1" >&2; usage 1 ;;
  esac
done

: "${SITELAYER_API_URL:?SITELAYER_API_URL must point at the sitelayer API base URL}"
: "${SITELAYER_CLERK_TOKEN:?SITELAYER_CLERK_TOKEN must be the platform-admin bearer JWT}"

if [ -z "$SLUG" ] || [ -z "$NAME" ]; then
  echo "ERROR: both --slug and --name are required" >&2
  usage 1
fi

if ! echo "$SLUG" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'; then
  echo "ERROR: --slug must be 2-64 chars, lowercase letters/digits/dashes" >&2
  exit 1
fi

# Normalize the base URL: accept a value with or without a trailing /api.
API_BASE="${SITELAYER_API_URL%/}"
API_BASE="${API_BASE%/api}"
AUTH_HEADER="Authorization: Bearer ${SITELAYER_CLERK_TOKEN}"

json_field() {
  # $1 = json, $2 = dotted path like company.id ; prints value or empty.
  python3 -c "import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split('.'):
    d=d.get(k) if isinstance(d,dict) else None
    if d is None: break
print('' if d is None else d)" "$2" <<<"$1"
}

echo "→ provisioning company slug=${SLUG} name=${NAME} template=${TEMPLATE} seed=${SEED}"
echo "  against ${API_BASE}/api"

# --- Step 1: create the company + generic defaults -------------------------
CREATE_BODY=$(python3 -c "import json,sys
print(json.dumps({'slug': sys.argv[1], 'name': sys.argv[2], 'template': sys.argv[3], 'seed_defaults': sys.argv[4]=='true'}))" \
  "$SLUG" "$NAME" "$TEMPLATE" "$SEED")

CREATE_RESP=$(curl -sS -X POST \
  -H "$AUTH_HEADER" -H "Content-Type: application/json" \
  -d "$CREATE_BODY" -w '\n%{http_code}' \
  "${API_BASE}/api/companies")

CREATE_CODE="${CREATE_RESP##*$'\n'}"
CREATE_JSON="${CREATE_RESP%$'\n'*}"

if [ "$CREATE_CODE" != "201" ]; then
  echo "ERROR: POST /api/companies returned ${CREATE_CODE}" >&2
  echo "$CREATE_JSON" >&2
  exit 2
fi

COMPANY_ID=$(json_field "$CREATE_JSON" company.id)
SEED_TEMPLATE=$(json_field "$CREATE_JSON" seed_template)
if [ -z "$COMPANY_ID" ]; then
  echo "ERROR: could not read company.id from create response" >&2
  echo "$CREATE_JSON" >&2
  exit 2
fi
echo "  ✓ company created: id=${COMPANY_ID} seeded_template=${SEED_TEMPLATE:-<none>}"

EXIT=0

# --- Step 2a: invite first admin(s) by email -------------------------------
for ADMIN_EMAIL in "${ADMIN_EMAILS[@]:-}"; do
  [ -z "$ADMIN_EMAIL" ] && continue
  I_BODY=$(python3 -c "import json,sys; print(json.dumps({'email': sys.argv[1], 'role': 'admin'}))" "$ADMIN_EMAIL")
  I_RESP=$(curl -sS -X POST \
    -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    -d "$I_BODY" -w '\n%{http_code}' \
    "${API_BASE}/api/companies/${COMPANY_ID}/invites")
  I_CODE="${I_RESP##*$'\n'}"
  I_JSON="${I_RESP%$'\n'*}"
  case "$I_CODE" in
    200|201) echo "  ✓ admin invite sent: ${ADMIN_EMAIL} (HTTP ${I_CODE})" ;;
    *)       echo "  ✗ admin invite failed for ${ADMIN_EMAIL}: HTTP ${I_CODE}" >&2
             echo "    $I_JSON" >&2; EXIT=3 ;;
  esac
done

# --- Step 2b/2c: direct membership grants ----------------------------------
grant_membership() {
  local user="$1" role="$2"
  local body resp code json
  body=$(python3 -c "import json,sys; print(json.dumps({'clerk_user_id': sys.argv[1], 'role': sys.argv[2]}))" "$user" "$role")
  resp=$(curl -sS -X POST \
    -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    -d "$body" -w '\n%{http_code}' \
    "${API_BASE}/api/companies/${COMPANY_ID}/memberships")
  code="${resp##*$'\n'}"
  json="${resp%$'\n'*}"
  if [ "$code" = "201" ]; then
    echo "  ✓ membership granted: ${user} as ${role}"
  else
    echo "  ✗ membership failed for ${user} (${role}): HTTP ${code}" >&2
    echo "    $json" >&2
    EXIT=3
  fi
}

for ADMIN_ID in "${ADMIN_CLERK_IDS[@]:-}"; do
  [ -z "$ADMIN_ID" ] && continue
  grant_membership "$ADMIN_ID" "admin"
done

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
  grant_membership "$INVITE_USER" "$INVITE_ROLE"
done

echo "done — company_id=${COMPANY_ID} (exit=${EXIT})"
exit "$EXIT"
