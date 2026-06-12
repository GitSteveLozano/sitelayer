# QBO Sandbox End-to-End Validation — Gate-1 Blocker

> ## ✅ GATE-1 PASSED — 2026-06-12 ~22:40Z
>
> All three acceptance criteria green the same evening (agent session,
> after the operator's single OAuth sign-in via the new
> `scripts/qbo-oauth-capture.mjs`):
>
> - **MODE A** exit 0 — refresh + companyinfo + Estimate 147/148/150.
> - **MODE A + `RENTAL_INVOICE_TEST=1`** exit 0 — Invoice 149 with the
>   presigned-URL line description.
> - **MODE B** exit 0 — local stack (fresh local DB, la-operations,
>   seeded pending bill), `POST /api/integrations/qbo/sync/material-bills`
>   pushed 1 bill / 0 errors → sandbox **Bill 151** + auto-created
>   **Vendor 58**, `integration_mappings` rows written.
>
> MODE B setup note: the company's `integration_connections` row +
> `qbo_account/materials` mapping (sandbox Account 69) were seeded
> directly — because of the **public-path company-resolution bug** below,
> the in-app `GET /api/integrations/qbo/auth → callback` flow cannot
> complete. Refresh-token custody: `.env.local` holds the latest rotated
> token (self-persisted; the smoke script now writes every rotation to a
> mode-600 `<log>.refresh-token` side file and honors
> `QBO_SMOKE_ENV_FILE`).
>
> ### 🐛 FILED: public-path company resolution breaks the QBO OAuth
>
> ### callback (all tiers)
>
> `server.ts` binds `requestContext.actorUserId = 'qbo-oauth-redirect'`
> for PUBLIC_PATHS **before** company resolution, and
> `getCurrentUserId()` prefers that context value — so `getCompany()`
> looks up a membership for the synthetic marker, finds none, and the
> middleware 404s (`company slug … not found`) before
> `routes/qbo.ts`'s callback handler (which is fully self-sufficient:
> company + membership come from the signed `state`) ever runs. The
> Clerk/QBO webhook public paths flow through the same block. Fix shape:
> exempt PUBLIC_PATHS from the middleware company requirement (null
> company + guarded `company.active.id` derefs); do NOT resolve a default
> company for them. Needs its own test + full suite run — deliberately
> not hot-patched during the Gate-1 session.

**Status (2026-06-12): MODE A PASSED, then refresh token burned — needs one
operator re-provision.** All five env vars were present in `.env.local`
(captured ~2026-06-01; the 2026-05-20 BLOCKED status below is historical).
Run record:

- `2026-06-12 21:57Z` — `qbo-sandbox-smoke.sh` MODE A **exit 0**: OAuth
  refresh OK, companyinfo OK ("Sandbox Company US 71b7", realm
  9341456936505893), Estimate posted (id=146). Log
  `/tmp/qbo-smoke-20260612-215759.log`.
- That run ROTATED the refresh token, and the script's log REDACTED the new
  value while its NOTE said to capture it from the log — the new token was
  unrecoverable and the stored one died (second run failed OAuth 400). The
  script now writes the rotated token to a mode-600
  `<log>.refresh-token` side file and, when `QBO_SMOKE_ENV_FILE` is set,
  updates `QBO_SANDBOX_REFRESH_TOKEN` in place — this trap cannot recur.
- **Remaining for Gate-1:** operator re-captures a refresh token via the
  OAuth Playground (steps below; no live Intuit session existed on any
  fleet browser profile), then run
  `QBO_SMOKE_ENV_FILE=.env.local bash scripts/qbo-sandbox-smoke.sh` and the
  `RENTAL_INVOICE_TEST=1` + MODE B legs.

**Status (2026-05-20, historical):** BLOCKED on missing operator-only credentials. Code
and harness are complete; only the sandbox refresh-token + realm-id need to
be captured from the Intuit OAuth Playground (or in-app OAuth dance) and
exported into the smoke environment.

## Why this exists

`CRITICAL_PATH.md` "Blockers for Pilot" #1 names live QBO sandbox
validation as the last remaining Gate-1 item. The full smoke harness has
been on disk since the QBO live-flip work (see
`scripts/qbo-sandbox-smoke.sh`, `docs/qbo-live-flip-checklist.md`), but
neither this host's project `.env.local` nor `~/.env.local` carries the
per-realm OAuth artifacts needed to exercise it.

The 2026-05-20 attempt failed with exit code 1 at the env-validation gate:

```
FAIL: missing required env: QBO_SANDBOX_REALM_ID QBO_SANDBOX_REFRESH_TOKEN \
                            QBO_SANDBOX_CLIENT_ID  QBO_SANDBOX_CLIENT_SECRET
```

`QBO_SANDBOX_BASE_URL` is set in `.env.local`; the other four are not.

## What the harness validates (when env is present)

`scripts/qbo-sandbox-smoke.sh` MODE A exercises the three Gate-1 success
criteria directly against the Intuit sandbox API:

1. **OAuth refresh** — POST to
   `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` with the
   stored `refresh_token`; expect HTTP 200, capture the rotated
   refresh_token from `/tmp/qbo-smoke-*.log` (Intuit rotates on every
   exchange — failing to capture is a self-inflicted auth outage next
   run). Mirrors `apps/worker/src/qbo-token-refresh.ts:105` exactly.
2. **Pull (companyinfo + customer query)** — GETs
   `/v3/company/{realmId}/companyinfo/{realmId}` and a `Customer` query.
   Same `qboGet`/`qboFetch` plumbing in `apps/api/src/qbo-http.ts:51`
   that the worker drain uses; a 200 here proves the refreshed token is
   usable.
3. **Push (Estimate → Invoice → Bill)** — POSTs a synthetic estimate and
   (with `RENTAL_INVOICE_TEST=1`) an invoice; for the bill leg, MODE B
   drives the local API's `/api/integrations/qbo/sync/material-bills`
   route which transitions `mutation_outbox` rows
   `pending → applied` and writes a `sync_events` row
   (`apps/api/src/qbo-material-bill-sync.ts:324-336`).

## Exactly what the operator needs to provide

All five variables MUST be exported in the same shell that runs the
smoke script. Append to `~/projects/sitelayer/.env.local` (gitignored)
or export inline.

| Variable                    | Where to find it                                                                                                                                                                                                 | Sensitivity |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `QBO_SANDBOX_BASE_URL`      | Already set: `https://sandbox-quickbooks.api.intuit.com`                                                                                                                                                         | low         |
| `QBO_SANDBOX_CLIENT_ID`     | Intuit Developer → My Apps → sitelayer app → Keys & OAuth tab → "Development Settings" Client ID. Same value as `QBO_CLIENT_ID` already in `.env.local`.                                                         | low         |
| `QBO_SANDBOX_CLIENT_SECRET` | Same screen, "Development Settings" Client Secret. Same value as `QBO_CLIENT_SECRET` already in `.env.local`.                                                                                                    | high        |
| `QBO_SANDBOX_REALM_ID`      | Numeric Company ID of the sandbox company. Visible in the sandbox QBO UI (gear icon → Your Company → Account and Settings → Billing & Subscription → Company ID).                                                | low         |
| `QBO_SANDBOX_REFRESH_TOKEN` | Obtained once via OAuth Playground: Intuit Developer → API Docs → OAuth 2.0 Playground → select sandbox app → "Get authorization code" → "Get tokens". Copy the `refresh_token` value. Rotates on every refresh. | high        |

### Fastest path to capture (no in-app OAuth dance needed)

1. Visit <https://developer.intuit.com/app/developer/playground>.
2. Pick the sitelayer app, environment **Development (sandbox)**.
3. Scopes: `com.intuit.quickbooks.accounting`.
4. Click **Get authorization code** → sign in with the sandbox owner →
   approve.
5. Click **Get tokens**. Copy `refresh_token` and the realm/company ID
   shown above the token card.
6. Save both into `.env.local` as `QBO_SANDBOX_REFRESH_TOKEN` and
   `QBO_SANDBOX_REALM_ID`. Also set `QBO_SANDBOX_CLIENT_ID` and
   `QBO_SANDBOX_CLIENT_SECRET` (same values as the non-sandbox ones).

## Run order once env is present

```sh
# 1. Pure-curl smoke (no API process needed). Validates:
#    - OAuth refresh (HTTP 200 + rotated refresh_token)
#    - companyinfo pull
#    - Estimate push
bash scripts/qbo-sandbox-smoke.sh

# 2. With invoice leg (validates presigned-URL line description path).
RENTAL_INVOICE_TEST=1 bash scripts/qbo-sandbox-smoke.sh

# 3. Capture the rotated refresh_token from /tmp/qbo-smoke-*.log and
#    overwrite QBO_SANDBOX_REFRESH_TOKEN in .env.local. The token from
#    step 1 is dead now.

# 4. Bill push end-to-end through the local API+worker
#    (this exercises mutation_outbox -> sync_events drain via the API
#    route, which is what production will use).
#
#    Bring the stack up first:
docker compose up -d db
npm run dev   # api + worker + web
#    Then in a third shell, with QBO_REALM_ID + QBO_ACCESS_TOKEN set
#    from step 1's response, plus SITELAYER_API_URL=http://localhost:3001
#    and SITELAYER_COMPANY_ID=<real company UUID with at least one
#    pending material_bill row>, run:
bash scripts/qbo-sandbox-smoke.sh   # MODE B auto-selected
```

## Acceptance — what "Gate-1 passed" means

- `qbo-sandbox-smoke.sh` exits 0 in both MODE A and MODE A with
  `RENTAL_INVOICE_TEST=1`.
- `qbo-sandbox-smoke.sh` exits 0 in MODE B against a real company row
  that produces at least one `applied` `mutation_outbox` transition
  and one `sync_events` row.
- Rotated refresh_token captured back into `.env.local` so the next
  manual run does not auth-fail.
- `CRITICAL_PATH.md` "In Progress" entry moved to "Completed" with a
  link to the smoke log file path and the rotated-token date.

## Why this is NOT an in-process automated test

The harness is intentionally hand-run, not CI:

- The refresh_token rotates on every exchange; a CI cron would burn
  through tokens unless it commits the rotated value back, which is a
  secrets-handling antipattern.
- CI's pre-existing `apps/api/src/qbo-material-bill-sync.test.ts`
  catches request-shape regressions against a localhost mock; the
  hand-run smoke is the only thing that validates real Intuit auth +
  rate-limit envelope + schema acceptance.

See `docs/qbo-live-flip-checklist.md` for the full pre-flip sequence;
this file documents the credentials-missing blocker that is currently
preventing the first run.
