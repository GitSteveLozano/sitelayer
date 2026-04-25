# Sitelayer Contractor Onboarding Runbook

**Audience:** Sitelayer admin onboarding a new construction-company customer end-to-end.
**Assumes:** Clerk SDK is wired into the SPA and `/sign-up` route is live. Until that ships, customers can't self-onboard — the bulk script at the bottom is the only path.

The product flow is built on three already-shipped backend pieces:
- `POST /api/companies` (creates the company; calls `seedCompanyDefaults` to provision divisions + service items + default pricing profile + default bonus rule).
- `POST /api/companies/:id/memberships` (adds crew with role `admin|foreman|office|member`).
- `GET /api/integrations/qbo/auth` (initiates QBO OAuth).

---

## Pre-onboarding checklist

Before starting:

```bash
# 1. Clerk MAU headroom (Hobby = 50,000 MAU; bump to Pro at 40k).
#    Clerk dashboard → Plan → Usage. Or sanity-check user count:
psql "$DATABASE_URL" -c "select count(distinct clerk_user_id) from company_memberships;"

# 2. DB tier headroom — sitelayer-db is db-s-1vcpu-1gb. Connections cap = 22.
doctl databases get 9948c96b-b6b6-45ad-adf7-d20e4c206c66 --format Connection

# 3. Spaces bucket headroom — sitelayer-blueprints-prod cap = 250 GB included.
#    (Skip until Spaces creds are populated; today blueprints land on the local
#    /app/storage/blueprints volume.)
doctl compute ssh sitelayer --ssh-command='df -h /app/storage'

# 4. QBO creds in place for the right env.
doctl compute ssh sitelayer --ssh-command='grep ^QBO_ /app/sitelayer/.env'
# QBO_ENVIRONMENT=production for live customers; sandbox for pilot/test.
```

If any check fails, stop and fix before bringing the customer in.

---

## 1. Customer creates Clerk account

Send the customer to `https://sitelayer.sandolab.xyz/sign-up` (Clerk-hosted component embedded in the SPA). They receive a verification email; once verified, they land on the SPA's first-run state with no `company_memberships` row → the SPA prompts them to create a company.

If you're admin-creating on their behalf (concierge onboarding), use Clerk dashboard → Users → "Create user" → record the resulting `user_***` ID for the bulk script.

---

## 2. Customer creates company

The SPA's "Create company" form posts to `POST /api/companies` with `{ slug, name, seed_defaults: true }`. The handler:
1. Validates slug against `^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$`.
2. Inserts row into `companies`.
3. Inserts the creator as `role='admin'` in `company_memberships`.
4. Calls `seedCompanyDefaults()` which idempotently inserts the LA Operations template `divisions`, `service_items`, a default `pricing_profiles` row, and a default `Margin Bonus` rule.
5. Writes an audit log row, returns 201.

**Verification:**
```bash
curl -fsS -H "Authorization: Bearer $JWT" \
  https://sitelayer.sandolab.xyz/api/companies | jq
# Expect at least one company with role=admin.
```

---

## 3. Add crew members

The admin invites people from the SPA's "Team" view, which posts:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"clerk_user_id":"user_2ABC...","role":"foreman"}' \
  "https://sitelayer.sandolab.xyz/api/companies/$COMPANY_ID/memberships"
```

Roles:
- `admin` — full company access; can invite, can rotate QBO connection.
- `foreman` — manages crew/labor entries on assigned projects.
- `office` — read-only operational, plus invoice/estimate edit.
- `member` — default; data entry only.

Membership writes are upserts (on conflict update role), so re-inviting an existing member just updates their role.

The invitee must already have a Clerk account in this Clerk instance — Sitelayer doesn't email-invite from scratch. Workflow: admin shares the sign-up URL, invitee creates account, sends their `clerk_user_id` (visible in their account → "Profile" — or admin pulls it from Clerk dashboard).

---

## 4. Connect QBO

From the SPA's Integrations page, the admin clicks "Connect QuickBooks". Browser navigates to `GET /api/integrations/qbo/auth` which redirects to Intuit's OAuth consent screen (signed by `QBO_STATE_SECRET`). Intuit redirects back to `QBO_REDIRECT_URI` → `/api/integrations/qbo/callback` → tokens land in `integration_connections`, `realmId` recorded, status = `connected`.

**Verification:**
```bash
psql "$DATABASE_URL" -c \
  "select company_id, status, last_synced_at from integration_connections where provider='qbo';"
```

First sync runs automatically; trigger a manual one with `POST /api/integrations/qbo/sync`. Watch worker logs:
```bash
doctl compute ssh sitelayer --ssh-command='
  docker compose -f /app/sitelayer/docker-compose.prod.yml logs --tail 100 worker | grep qbo
'
```

---

## 5. First blueprint upload

Admin or foreman opens a project, clicks "Upload blueprint", drops a PDF. SPA POSTs to `/api/projects/:id/blueprints`. With Spaces creds populated, the file lands at `s3://sitelayer-blueprints-prod/<companyId>/<blueprintId>/<filename>`. Without them, it lands on the local `blueprint_storage` Docker volume.

**Verification:**
```bash
psql "$DATABASE_URL" -c \
  "select id, project_id, storage_path, created_at from blueprint_documents order by created_at desc limit 1;"
curl -fsS -H "Authorization: Bearer $JWT" \
  https://sitelayer.sandolab.xyz/api/blueprints/<id>/file -o /tmp/check.pdf
file /tmp/check.pdf   # should report "PDF document"
```

---

## 6. Verify labor entry → QBO sync end-to-end

1. Foreman adds a `labor_entries` row from the Time view.
2. API writes to `mutation_outbox` with the labor entry as payload.
3. Worker leases the row (`FOR UPDATE SKIP LOCKED`), pushes to QBO via the connector, marks `applied`.
4. Verify QBO Time Activity in QBO sandbox/prod.

**Spot-check:**
```bash
psql "$DATABASE_URL" -c "
  select id, status, attempt_count, error
  from mutation_outbox
  where company_id='$COMPANY_ID'
  order by created_at desc limit 5;
"
```

All `applied`, zero `error` populated → green.

---

## 7. Hand-off checklist

- [ ] Admin Clerk user ID recorded in `mesh` (project=sitelayer, planning_note `customer_<slug>_admin`).
- [ ] Admin knows how to invite more people (Team view + share `/sign-up` URL).
- [ ] Admin knows audit log lives at `audit_log` table (no UI yet — query by API/SQL on request).
- [ ] Support contact set: `taylor@releaserent.com`. Response SLA: 24h business days during pilot.
- [ ] Backup/DR is invisible to customer but documented in `docs/DR_RESTORE.md`.

---

## Bulk-onboard script

For concierge onboarding when you already have the company name + crew list. Run from local machine with `JWT` set to a Sitelayer admin token (issued out-of-band from Clerk dashboard's "Impersonate" or a service-token Clerk JWT).

```bash
#!/usr/bin/env bash
# scripts/onboard-company.sh — bulk-onboard a construction company.
# Usage: SITELAYER_JWT=... ./scripts/onboard-company.sh examples/acme.json

set -euo pipefail

API="${SITELAYER_API:-https://sitelayer.sandolab.xyz}"
JWT="${SITELAYER_JWT:?set SITELAYER_JWT to an admin Clerk token}"
SPEC="${1:?usage: onboard-company.sh path/to/spec.json}"

# Spec format:
# {
#   "slug": "acme-construction",
#   "name": "Acme Construction Ltd",
#   "members": [
#     { "clerk_user_id": "user_2A...", "role": "admin"   },
#     { "clerk_user_id": "user_2B...", "role": "foreman" },
#     { "clerk_user_id": "user_2C...", "role": "office"  }
#   ]
# }

slug=$(jq -r .slug "$SPEC")
name=$(jq -r .name "$SPEC")

echo "[1/3] Creating company $slug ..."
created=$(curl -fsS -X POST "$API/api/companies" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "$(jq '{slug, name, seed_defaults: true}' "$SPEC")")
company_id=$(echo "$created" | jq -r .company.id)
echo "    company_id=$company_id"

echo "[2/3] Adding members ..."
jq -c '.members[]' "$SPEC" | while read -r m; do
  curl -fsS -X POST "$API/api/companies/$company_id/memberships" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d "$m" | jq -c '.membership | {clerk_user_id, role}'
done

echo "[3/3] Verifying ..."
curl -fsS "$API/api/companies/$company_id/memberships" \
  -H "Authorization: Bearer $JWT" | jq '.memberships | length'
echo "Done. QBO + blueprints must be done by the admin from the SPA."
```

`seedCompanyDefaults` handles divisions + service items + pricing profile + bonus rule automatically — no extra calls needed for those. QBO connection and first blueprint upload still require the admin to act in the browser (OAuth + file picker).
