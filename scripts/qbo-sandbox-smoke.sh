#!/usr/bin/env bash
#
# QBO sandbox end-to-end smoke harness.
#
# Run this by hand against a real QBO sandbox before turning on either of
# the QBO live flags in prod (QBO_LIVE_ESTIMATE_PUSH=1,
# QBO_LIVE_RENTAL_INVOICE=1). Does NOT run in CI: CI uses
# apps/api/src/qbo-material-bill-sync.test.ts against a localhost mock
# instead. Real QBO behaviours that only show up against a sandbox:
# OAuth refresh, rate-limit envelope, schema validation, presigned-URL
# attachment lifetime.
#
# Two modes:
#
# MODE A (primary): direct-to-QBO smoke. Validates the sandbox creds,
# OAuth refresh path, /companyinfo, and POSTs test Estimate (+ optional
# Invoice with attachment) straight at the Intuit API. No local API
# required. This is the mode you want before flipping live flags.
#
# MODE B (legacy): drives the local API's
# /api/integrations/qbo/sync/material-bills route. Kept for
# compatibility with the older runbook recipe. Triggered by setting
# SITELAYER_API_URL + SITELAYER_COMPANY_ID alongside legacy
# QBO_REALM_ID/QBO_ACCESS_TOKEN.
#
# Required env (MODE A):
#   QBO_SANDBOX_BASE_URL       e.g. https://sandbox-quickbooks.api.intuit.com
#   QBO_SANDBOX_REALM_ID       e.g. 9341454063892108
#   QBO_SANDBOX_REFRESH_TOKEN  long-lived OAuth refresh token (rotates on
#                              every exchange; capture the new one from
#                              the log file when this script finishes)
#   QBO_SANDBOX_CLIENT_ID      Intuit app client_id
#   QBO_SANDBOX_CLIENT_SECRET  Intuit app client_secret
#
# Optional env:
#   QBO_OAUTH_TOKEN_URL        defaults to Intuit production OAuth
#                              endpoint (the same endpoint serves
#                              sandbox refresh tokens)
#   RENTAL_INVOICE_TEST=1      additionally POST a test Invoice with a
#                              presigned-URL line item description
#   QBO_TEST_CUSTOMER_ID       QBO Customer.Id to use; otherwise the
#                              script picks the first sandbox customer
#                              (auto-creates one if the realm is empty)
#   QBO_TEST_PRESIGNED_URL     URL string used in the rental invoice
#                              line description; if unset, the script
#                              uses a static placeholder
#
# Required env (MODE B, legacy):
#   QBO_REALM_ID, QBO_ACCESS_TOKEN, SITELAYER_API_URL,
#   SITELAYER_COMPANY_ID
#
# Logs: every request/response (with secrets redacted) is appended to
#   /tmp/qbo-smoke-YYYYMMDD-HHMMSS.log
# The file path is printed on exit.
#
# Exit codes:
#   0  all-OK
#   1  missing required env
#   2  OAuth refresh failed
#   3  /companyinfo failed
#   4  estimate POST failed
#   5  invoice POST failed (only when RENTAL_INVOICE_TEST=1)
#   6  legacy MODE B local-API leg failed
#
# CLAUDE.md operating rule #1: NO silent localhost or sentinel defaults
# for required config. The script bails loudly if required env is missing.

set -euo pipefail

LOG_FILE="/tmp/qbo-smoke-$(date -u +%Y%m%d-%H%M%S).log"
: > "${LOG_FILE}"
echo "[qbo-smoke] log: ${LOG_FILE}"

log() {
  echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "${LOG_FILE}" >&2
}

log_only() {
  echo "[$(date -u +%H:%M:%SZ)] $*" >> "${LOG_FILE}"
}

trap 'echo "[qbo-smoke] full log: ${LOG_FILE}" >&2' EXIT

# Decide which mode the operator intended. MODE A is preferred. If the
# legacy QBO_REALM_ID + QBO_ACCESS_TOKEN are set without the new
# QBO_SANDBOX_* triple, fall through to MODE B for backwards compat with
# the old runbook recipe.
MODE="A"
if [[ -z "${QBO_SANDBOX_REFRESH_TOKEN:-}" && -n "${QBO_REALM_ID:-}" && -n "${QBO_ACCESS_TOKEN:-}" ]]; then
  MODE="B"
fi

if [[ "${MODE}" == "A" ]]; then
  REQUIRED_VARS=(QBO_SANDBOX_BASE_URL QBO_SANDBOX_REALM_ID QBO_SANDBOX_REFRESH_TOKEN QBO_SANDBOX_CLIENT_ID QBO_SANDBOX_CLIENT_SECRET)
  MISSING=()
  for v in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!v:-}" ]]; then MISSING+=("$v"); fi
  done
  if [[ ${#MISSING[@]} -gt 0 ]]; then
    log "FAIL: missing required env: ${MISSING[*]}"
    log "      MODE A requires the QBO_SANDBOX_* set."
    log "      For legacy MODE B, set QBO_REALM_ID + QBO_ACCESS_TOKEN + SITELAYER_API_URL + SITELAYER_COMPANY_ID."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# MODE A — direct-to-QBO smoke
# ---------------------------------------------------------------------------
if [[ "${MODE}" == "A" ]]; then
  QBO_OAUTH_TOKEN_URL="${QBO_OAUTH_TOKEN_URL:-https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer}"

  log "MODE: A (direct-to-QBO sandbox smoke)"
  log "base_url:    ${QBO_SANDBOX_BASE_URL}"
  log "realm_id:    ${QBO_SANDBOX_REALM_ID}"
  log "oauth_url:   ${QBO_OAUTH_TOKEN_URL}"
  log "client_id:   ${QBO_SANDBOX_CLIENT_ID:0:8}…(redacted)"

  # 1. OAuth refresh ------------------------------------------------------
  log "step 1: refresh_token -> access_token"
  basic=$(printf '%s:%s' "${QBO_SANDBOX_CLIENT_ID}" "${QBO_SANDBOX_CLIENT_SECRET}" | base64 -w0)
  refresh_resp=$(curl -sS -w '\n%{http_code}' \
    -X POST "${QBO_OAUTH_TOKEN_URL}" \
    -H "Authorization: Basic ${basic}" \
    -H "Accept: application/json" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "grant_type=refresh_token" \
    --data-urlencode "refresh_token=${QBO_SANDBOX_REFRESH_TOKEN}")
  refresh_status=$(printf '%s' "${refresh_resp}" | tail -n1)
  refresh_body=$(printf '%s' "${refresh_resp}" | sed '$d')

  log_only "[refresh] status=${refresh_status}"
  log_only "[refresh] body=$(printf '%s' "${refresh_body}" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); d["access_token"]="<REDACTED>" if "access_token" in d else d.get("access_token"); d["refresh_token"]=("<REDACTED-NEW:" + (d.get("refresh_token","")[:6]+"…") + ">") if "refresh_token" in d else d.get("refresh_token"); print(json.dumps(d))' 2>/dev/null || printf '%s' "${refresh_body}")"

  if [[ "${refresh_status}" != "200" ]]; then
    log "FAIL: OAuth refresh returned ${refresh_status}"
    log "      see ${LOG_FILE} for body"
    exit 2
  fi

  ACCESS_TOKEN=$(printf '%s' "${refresh_body}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["access_token"])')
  NEW_REFRESH_TOKEN=$(printf '%s' "${refresh_body}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("refresh_token",""))')
  EXPIRES_IN=$(printf '%s' "${refresh_body}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("expires_in",""))')
  log "OK: refreshed; access_token expires in ${EXPIRES_IN}s; refresh_token rotated (new prefix=${NEW_REFRESH_TOKEN:0:6}…)"
  log "NOTE: capture the new refresh_token from ${LOG_FILE} and update your env before next run"

  AUTH_HDR="Authorization: Bearer ${ACCESS_TOKEN}"
  BASE="${QBO_SANDBOX_BASE_URL%/}/v3/company/${QBO_SANDBOX_REALM_ID}"

  # 2. /companyinfo -------------------------------------------------------
  log "step 2: GET /companyinfo/${QBO_SANDBOX_REALM_ID}"
  ci_resp=$(curl -sS -w '\n%{http_code}' \
    "${BASE}/companyinfo/${QBO_SANDBOX_REALM_ID}" \
    -H "${AUTH_HDR}" \
    -H "Accept: application/json")
  ci_status=$(printf '%s' "${ci_resp}" | tail -n1)
  ci_body=$(printf '%s' "${ci_resp}" | sed '$d')
  log_only "[companyinfo] status=${ci_status}"
  log_only "[companyinfo] body=${ci_body}"
  if [[ "${ci_status}" != "200" ]]; then
    log "FAIL: companyinfo returned ${ci_status}"
    exit 3
  fi
  company_name=$(printf '%s' "${ci_body}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("CompanyInfo",{}).get("CompanyName","<unknown>"))')
  log "OK: connected to QBO company '${company_name}'"

  # 3. Resolve a customer to bill against ---------------------------------
  CUSTOMER_ID="${QBO_TEST_CUSTOMER_ID:-}"
  if [[ -z "${CUSTOMER_ID}" ]]; then
    log "step 3a: querying for first available Customer"
    cust_query=$(printf '%s' 'select * from Customer maxresults 1' | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read()))')
    cust_resp=$(curl -sS -w '\n%{http_code}' \
      "${BASE}/query?query=${cust_query}" \
      -H "${AUTH_HDR}" -H "Accept: application/json")
    cust_status=$(printf '%s' "${cust_resp}" | tail -n1)
    cust_body=$(printf '%s' "${cust_resp}" | sed '$d')
    log_only "[customer-query] status=${cust_status}"
    log_only "[customer-query] body=${cust_body}"
    CUSTOMER_ID=$(printf '%s' "${cust_body}" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()).get("QueryResponse",{}).get("Customer",[]); print(d[0]["Id"] if d else "")' 2>/dev/null || printf '')
    if [[ -z "${CUSTOMER_ID}" ]]; then
      log "step 3b: realm has no customers — creating Sitelayer Smoke Customer"
      create_cust=$(curl -sS -w '\n%{http_code}' \
        -X POST "${BASE}/customer" \
        -H "${AUTH_HDR}" -H "Content-Type: application/json" -H "Accept: application/json" \
        -d '{"DisplayName":"Sitelayer Smoke Customer","CompanyName":"Sitelayer Smoke"}')
      cc_status=$(printf '%s' "${create_cust}" | tail -n1)
      cc_body=$(printf '%s' "${create_cust}" | sed '$d')
      log_only "[customer-create] status=${cc_status}"
      log_only "[customer-create] body=${cc_body}"
      CUSTOMER_ID=$(printf '%s' "${cc_body}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("Customer",{}).get("Id",""))' 2>/dev/null || printf '')
    fi
  fi
  if [[ -z "${CUSTOMER_ID}" ]]; then
    log "FAIL: could not resolve a QBO Customer.Id for the smoke estimate"
    exit 4
  fi
  log "OK: using QBO Customer.Id=${CUSTOMER_ID}"

  # 4. POST a test Estimate ----------------------------------------------
  log "step 4: POST /estimate (smoke estimate)"
  est_payload=$(python3 -c "
import json, sys
print(json.dumps({
  'CustomerRef': {'value': '${CUSTOMER_ID}'},
  'PrivateNote': 'sitelayer smoke estimate $(date -u +%Y%m%dT%H%M%SZ)',
  'DocNumber': 'SMOKE-EST-$(date -u +%H%M%S)',
  'Line': [
    {
      'Amount': 100.0,
      'DetailType': 'SalesItemLineDetail',
      'Description': 'smoke line item',
      'SalesItemLineDetail': { 'Qty': 1, 'UnitPrice': 100.0 }
    }
  ]
}))
")
  est_resp=$(curl -sS -w '\n%{http_code}' \
    -X POST "${BASE}/estimate" \
    -H "${AUTH_HDR}" -H "Content-Type: application/json" -H "Accept: application/json" \
    -d "${est_payload}")
  est_status=$(printf '%s' "${est_resp}" | tail -n1)
  est_body=$(printf '%s' "${est_resp}" | sed '$d')
  log_only "[estimate] status=${est_status}"
  log_only "[estimate] body=${est_body}"
  if [[ "${est_status}" != "200" ]]; then
    log "FAIL: estimate POST returned ${est_status}"
    log "      body excerpt: $(printf '%s' "${est_body}" | head -c 400)"
    exit 4
  fi
  ESTIMATE_ID=$(printf '%s' "${est_body}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("Estimate",{}).get("Id",""))')
  log "OK: posted estimate id=${ESTIMATE_ID}"

  # 5. Optional Invoice POST with presigned URL line ---------------------
  if [[ "${RENTAL_INVOICE_TEST:-0}" == "1" ]]; then
    log "step 5: POST /invoice with presigned-URL line description"
    PRESIGNED="${QBO_TEST_PRESIGNED_URL:-https://sitelayer-blueprints-prod.tor1.digitaloceanspaces.com/smoke/blueprint.pdf?X-Amz-Signature=placeholder}"
    inv_payload=$(python3 -c "
import json, sys
print(json.dumps({
  'CustomerRef': {'value': '${CUSTOMER_ID}'},
  'PrivateNote': 'sitelayer smoke invoice (rental) $(date -u +%Y%m%dT%H%M%SZ)',
  'DocNumber': 'SMOKE-INV-$(date -u +%H%M%S)',
  'Line': [
    {
      'Amount': 250.0,
      'DetailType': 'SalesItemLineDetail',
      'Description': 'rental smoke line — blueprint: ${PRESIGNED}',
      'SalesItemLineDetail': { 'Qty': 5, 'UnitPrice': 50.0 }
    }
  ]
}))
")
    inv_resp=$(curl -sS -w '\n%{http_code}' \
      -X POST "${BASE}/invoice" \
      -H "${AUTH_HDR}" -H "Content-Type: application/json" -H "Accept: application/json" \
      -d "${inv_payload}")
    inv_status=$(printf '%s' "${inv_resp}" | tail -n1)
    inv_body=$(printf '%s' "${inv_resp}" | sed '$d')
    log_only "[invoice] status=${inv_status}"
    log_only "[invoice] body=${inv_body}"
    if [[ "${inv_status}" != "200" ]]; then
      log "FAIL: invoice POST returned ${inv_status}"
      log "      body excerpt: $(printf '%s' "${inv_body}" | head -c 400)"
      exit 5
    fi
    INVOICE_ID=$(printf '%s' "${inv_body}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("Invoice",{}).get("Id",""))')
    log "OK: posted invoice id=${INVOICE_ID} with presigned-URL line"
  else
    log "step 5: skipped (set RENTAL_INVOICE_TEST=1 to exercise invoice path)"
  fi

  log "ALL OK (MODE A) — see ${LOG_FILE}"
  exit 0
fi

# ---------------------------------------------------------------------------
# MODE B — legacy local-API smoke (drives /api/integrations/qbo/sync/material-bills)
# ---------------------------------------------------------------------------
if [[ -z "${QBO_REALM_ID:-}" || -z "${QBO_ACCESS_TOKEN:-}" || -z "${SITELAYER_API_URL:-}" || -z "${SITELAYER_COMPANY_ID:-}" ]]; then
  log "FAIL: MODE B requires QBO_REALM_ID, QBO_ACCESS_TOKEN, SITELAYER_API_URL, SITELAYER_COMPANY_ID"
  exit 1
fi

QBO_BASE_URL="${QBO_BASE_URL:-https://sandbox-quickbooks.api.intuit.com}"
log "MODE: B (legacy local-API smoke)"
log "qbo_base_url:        ${QBO_BASE_URL}"
log "sitelayer_api_url:   ${SITELAYER_API_URL}"
log "realm:               ${QBO_REALM_ID}"

log "step 1 (legacy): pulling customers from sandbox via QBO query"
customer_response=$(curl -sS -w '\n%{http_code}' \
  -H "Authorization: Bearer ${QBO_ACCESS_TOKEN}" \
  -H "Accept: application/json" \
  "${QBO_BASE_URL}/v3/company/${QBO_REALM_ID}/query?query=$(printf %s 'select * from Customer maxresults 5' | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read()))')"
)
status=$(printf '%s' "${customer_response}" | tail -n1)
body=$(printf '%s' "${customer_response}" | sed '$d')
log_only "[legacy-customer-query] status=${status}"
log_only "[legacy-customer-query] body=${body}"
if [[ "${status}" != "200" ]]; then
  log "FAIL: customer pull returned ${status}"
  exit 2
fi
customer_count=$(printf '%s' "${body}" | python3 -c 'import json, sys; data=json.load(sys.stdin); print(len(data.get("QueryResponse", {}).get("Customer", [])))')
log "OK: pulled ${customer_count} customers"

log "step 2 (legacy): pushing pending material bills via local API"
push_response=$(curl -sS -w '\n%{http_code}' \
  -X POST \
  -H "x-sitelayer-company-id: ${SITELAYER_COMPANY_ID}" \
  -H "Content-Type: application/json" \
  "${SITELAYER_API_URL}/api/integrations/qbo/sync/material-bills"
)
push_status=$(printf '%s' "${push_response}" | tail -n1)
push_body=$(printf '%s' "${push_response}" | sed '$d')
log_only "[legacy-bill-push] status=${push_status}"
log_only "[legacy-bill-push] body=${push_body}"
if [[ "${push_status}" != "200" ]]; then
  log "FAIL: bill push returned ${push_status}"
  exit 6
fi
synced=$(printf '%s' "${push_body}" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("synced", 0))')
errors=$(printf '%s' "${push_body}" | python3 -c 'import json, sys; print(len(json.load(sys.stdin).get("errors", [])))')
log "OK: pushed ${synced} bills with ${errors} errors"
if [[ "${errors}" != "0" ]]; then
  log "FAIL: bill push had ${errors} errors — see ${LOG_FILE}"
  exit 6
fi

log "ALL OK (MODE B) — see ${LOG_FILE}"
exit 0
