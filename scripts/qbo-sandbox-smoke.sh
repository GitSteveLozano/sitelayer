#!/usr/bin/env bash
#
# QBO sandbox end-to-end smoke harness.
#
# This is the script Taylor runs by hand against a real QBO sandbox before
# turning on the `qbo-live` feature flag in prod. It does NOT run in CI:
# CI uses apps/api/src/qbo-material-bill-sync.test.ts against a localhost
# Express-style mock instead, because the sandbox creds aren't safe to bake
# into a public repo.
#
# Required env:
#   QBO_REALM_ID         e.g. 9341454063892108
#   QBO_ACCESS_TOKEN     short-lived OAuth bearer token
#   QBO_BASE_URL         https://sandbox-quickbooks.api.intuit.com (default)
#   SITELAYER_COMPANY_ID UUID of the local company to push from
#   SITELAYER_API_URL    e.g. http://localhost:3001
#
# Exit codes: 0 OK, 1 missing config, 2 customer pull failed, 3 bill push failed.

set -euo pipefail

if [[ -z "${QBO_REALM_ID:-}" || -z "${QBO_ACCESS_TOKEN:-}" ]]; then
  echo "FAIL: QBO_REALM_ID and QBO_ACCESS_TOKEN must be set" >&2
  exit 1
fi

QBO_BASE_URL="${QBO_BASE_URL:-https://sandbox-quickbooks.api.intuit.com}"
SITELAYER_API_URL="${SITELAYER_API_URL:-http://localhost:3001}"
SITELAYER_COMPANY_ID="${SITELAYER_COMPANY_ID:-}"

echo "[qbo-smoke] sandbox base URL: ${QBO_BASE_URL}"
echo "[qbo-smoke] sitelayer API:    ${SITELAYER_API_URL}"
echo "[qbo-smoke] realm:            ${QBO_REALM_ID}"

# 1. Customer pull — confirms the access token works and the realm is reachable.
echo "[qbo-smoke] pulling customers from sandbox..."
customer_response=$(curl -sS -w '\n%{http_code}' \
  -H "Authorization: Bearer ${QBO_ACCESS_TOKEN}" \
  -H "Accept: application/json" \
  "${QBO_BASE_URL}/v3/company/${QBO_REALM_ID}/query?query=$(printf %s 'select * from Customer maxresults 5' | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read()))')"
)
status=$(echo "${customer_response}" | tail -n1)
body=$(echo "${customer_response}" | sed '$d')
if [[ "${status}" != "200" ]]; then
  echo "FAIL: customer pull returned ${status}" >&2
  echo "${body}" >&2
  exit 2
fi
customer_count=$(echo "${body}" | python3 -c 'import json, sys; data=json.load(sys.stdin); print(len(data.get("QueryResponse", {}).get("Customer", [])))')
echo "OK: pulled ${customer_count} customers"

# 2. Bill push — drives the local /api/integrations/qbo/sync/material-bills
#    endpoint, which in turn talks to the sandbox. Requires the local API
#    to already have a QBO connection + a `qbo_account/materials` mapping.
if [[ -z "${SITELAYER_COMPANY_ID}" ]]; then
  echo "SKIP: SITELAYER_COMPANY_ID not set, skipping bill push leg"
  echo "OK"
  exit 0
fi

echo "[qbo-smoke] pushing pending material bills via local API..."
push_response=$(curl -sS -w '\n%{http_code}' \
  -X POST \
  -H "x-sitelayer-company-id: ${SITELAYER_COMPANY_ID}" \
  -H "Content-Type: application/json" \
  "${SITELAYER_API_URL}/api/integrations/qbo/sync/material-bills"
)
push_status=$(echo "${push_response}" | tail -n1)
push_body=$(echo "${push_response}" | sed '$d')
if [[ "${push_status}" != "200" ]]; then
  echo "FAIL: bill push returned ${push_status}" >&2
  echo "${push_body}" >&2
  exit 3
fi
synced=$(echo "${push_body}" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("synced", 0))')
errors=$(echo "${push_body}" | python3 -c 'import json, sys; print(len(json.load(sys.stdin).get("errors", [])))')
echo "OK: pushed ${synced} bills with ${errors} errors"
if [[ "${errors}" != "0" ]]; then
  echo "${push_body}" | python3 -m json.tool >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# Rental billing invoice push smoke (Phase C — DETERMINISTIC_WORKFLOWS.md)
#
# This block is a placeholder for the rental billing invoice path. The route
# enqueues a mutation_outbox row with mutation_type='post_qbo_invoice' on
# POST_REQUESTED, and the worker drains it and calls the live QBO Invoice
# REST endpoint. Wire the live integration first (replace the worker stub
# `stubRentalBillingInvoicePush` with a real qboPost call), then enable this
# block by setting RENTAL_BILLING_RUN_ID.
#
# Pseudocode:
#   1. Approve the run via POST /api/rental-billing-runs/$RUN_ID/events {APPROVE,sv}
#   2. POST_REQUESTED via the same route
#   3. Wait for the worker to drain (poll GET /api/rental-billing-runs/$RUN_ID
#      until state in ('posted','failed') or timeout)
#   4. On 'posted', verify context.qbo_invoice_id exists and the matching QBO
#      Invoice exists via the QBO REST API.
# ---------------------------------------------------------------------------
if [[ -n "${RENTAL_BILLING_RUN_ID:-}" ]]; then
  echo "[qbo-smoke] rental billing invoice push smoke not yet implemented — see comment block." >&2
fi

echo "OK"
