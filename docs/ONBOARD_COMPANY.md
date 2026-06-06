# Onboarding a New Construction Company (Operator Runbook)

How a **platform admin** stands up a brand-new construction company (tenant
#2..#N) on a running sitelayer deployment, end to end: company row → first
admin → company-scoped data. This is the clean, generic, multi-tenant path —
it does **not** seed L&A Operations' stucco/EIFS reference data into the new
tenant.

For developer environment setup see
[`ONBOARDING_DEVELOPER.md`](./ONBOARDING_DEVELOPER.md). For the original L&A
pilot bootstrap see [`ONBOARDING_CONTRACTOR.md`](./ONBOARDING_CONTRACTOR.md)
and `scripts/provision-pilot-company.sh` (LA-defaulted).

---

## TL;DR

```bash
export SITELAYER_API_URL=https://sitelayer.sandolab.xyz   # or http://localhost:3001
export SITELAYER_CLERK_TOKEN="<platform-admin bearer JWT>"

scripts/provision-company.sh \
  --slug "northstar-builders" \
  --name "Northstar Builders" \
  --admin-email "owner@northstar.example"
```

That single call creates the company, makes the caller the bootstrap admin,
seeds **generic construction defaults**, and emails the real owner an invite
they accept by signing in with Clerk.

---

## 1. Prerequisites

- **A deployed, healthy API.** `GET ${SITELAYER_API_URL}/health` returns 200.
- **A platform-admin Clerk identity.** `POST /api/companies` is gated to
  platform admins by default (`PLATFORM_SUPERADMIN_CLERK_IDS` ∪ the
  `platform_admins` table). Capture the bearer JWT from the operator's Clerk
  session (DevTools → Application → session token). The dev `x-sitelayer-act-as`
  header can **never** satisfy the gate — provisioning is always a verified
  Clerk session. (Escape hatch for a closed pilot only:
  `ALLOW_OPEN_COMPANY_SIGNUP=1` re-opens self-serve creation — leave it OFF in
  prod.)
- **Tier env is correct** for the target deployment. The API refuses to boot if
  `APP_TIER` disagrees with `DATABASE_URL` / `DO_SPACES_BUCKET`. New rows are
  tagged `tier_origin` automatically by the write path; you do not set it
  per-company.

## 2. Create the company + seed generic defaults

```bash
scripts/provision-company.sh \
  --slug "<slug>" \           # lowercase letters/digits/dashes, 2-64 chars
  --name "<Display Name>" \
  --admin-email "<owner@example.com>"
```

What it does, in one transaction on the server:

1. `POST /api/companies { slug, name, template: "generic-construction" }`
   inserts the `companies` row, makes the **caller** the bootstrap `admin`
   membership, and runs `seedCompanyDefaults` with the **generic** template.
2. The 201 response includes `seed_template: "generic-construction"` so you can
   confirm which template stamped the tenant.

### What "generic construction" seeds

Trade-neutral starter data the new owner keeps or prunes — defined in
`@sitelayer/domain` (`GENERIC_SEED_TEMPLATE`):

- **Divisions:** General Requirements, Site Work, Concrete, Framing, Exterior,
  Interior, Mechanical/Electrical/Plumbing, Overhead.
- **Service items:** General Labor, Site Preparation, Concrete Flatwork, Wall
  Framing, Exterior Finish, Drywall + the accounting line items (Change Order,
  Deposit, Holdback) — each pre-linked to a division so takeoff catalog
  enforcement works out of the box.
- **A default pricing profile** tagged `{"template":"generic-construction"}`,
  a default margin bonus rule, and a default `Yard` inventory location.
- **No trade assemblies.** Unlike LA, the generic template ships zero
  exterior-cladding assemblies — a roofer or GC is not seeded with stucco/EIFS
  cladding it does not sell.

### Choosing a different template

```bash
# Clone L&A's stucco/EIFS reference set for a similar subcontractor:
scripts/provision-company.sh --slug "westside-stucco" --name "Westside Stucco" \
  --template la-operations --admin-email "owner@westside.example"

# Create with NO seed data at all (the owner builds their catalog from scratch):
scripts/provision-company.sh --slug "blank-co" --name "Blank Co" --no-seed \
  --admin-email "owner@blank.example"
```

Registered template slugs live in `SEED_TEMPLATES` (`@sitelayer/domain`):
`generic-construction` (default) and `la-operations`. An unknown slug falls
back to generic — provisioning never fails on a typo'd template.

## 3. Make the first admin a real person

The bootstrap admin from step 2 is **you** (the platform admin). Hand the
company to its real owner one of two ways:

- **By email (recommended).** `--admin-email <owner@example>` emails an accept
  link. The owner clicks it, signs in with Clerk, and `POST /api/invites/:token/accept`
  binds their authenticated Clerk user id to the `admin` role.
- **By Clerk id (no email round-trip).** `--admin-clerk-id user_2b...` grants
  admin directly to a known Clerk user id via `POST /api/companies/:id/memberships`.

Add crew at the same time with repeatable `--invite <clerk_user_id>:<role>`
(`admin|foreman|office|member|bookkeeper`).

Once the real owner has admin, you can remove your bootstrap membership if you
do not want a standing seat in the tenant (the `company_memberships` row).

## 4. Admin signs in → company-scoped data

After the owner accepts and signs in with Clerk:

- Every API request resolves their company from `company_memberships`
  (`x-sitelayer-company-slug` / multi-company switcher), and the RLS GUC
  `app.company_id` scopes all reads/writes to that tenant. In prod the API
  connects as a non-owner `NOBYPASSRLS` role, so `FORCE ROW LEVEL SECURITY`
  applies — a misrouted query can never read another tenant's rows.
- `GET /api/bootstrap` returns the new company's seeded divisions, service
  items, pricing profile, and (empty) project list. The owner can immediately
  create projects, upload blueprints, run takeoffs, and invite crew.

## 5. Per-company integrations (optional, owner-driven)

These are configured **per tenant** after sign-in — nothing here is shared
across companies:

- **QuickBooks Online.** The owner connects their own QBO realm via
  `GET /api/integrations/qbo/auth` → Intuit consent → `callback`. Tokens land
  in `integration_connections` scoped to the company. Live push is gated
  per-company by `integration_connections.qbo_live_enabled` (migration 144) in
  addition to the global `QBO_LIVE_*` env flags — flip the per-company flag on
  only after a sandbox smoke (`scripts/qbo-sandbox-smoke.sh`).
- **Blueprint storage.** Uploads stream into the shared DO Spaces bucket
  (`sitelayer-blueprints-prod`) under a per-company key prefix
  (`<companyId>/<blueprintId>/<filename>`); access is company-scoped, so the
  same bucket safely holds every tenant. No per-company bucket provisioning.

## 6. Verify the tenant is isolated

```bash
# As the new owner (or via the platform-admin act-as in non-prod), confirm
# the new company sees ONLY its own seeded data:
curl -H "Authorization: Bearer <owner-jwt>" \
     -H "x-sitelayer-company-slug: <slug>" \
     "${SITELAYER_API_URL}/api/bootstrap" | jq '.divisions[].name'
# → General Requirements, Site Work, Concrete, Framing, ...  (NOT Stucco/EIFS)
```

The automated proof of isolation is `apps/api/src/onboarding.test.ts` (the
"two companies seeded back-to-back are fully tenant-isolated" case), run by the
integration stage of `scripts/verify-local.sh` against a real Postgres with RLS
forced.

## 7. Idempotency / retries

Re-running `provision-company.sh` with the same `--slug` is safe:

- A slug collision on step 1 surfaces the API's `409` (with a suggested
  alternative slug) — the company is **not** silently re-created, so a typo
  never attaches the wrong tenant.
- Invite and membership endpoints **upsert**, so re-running to finish a partial
  run just re-applies the same grants.

---

### Reference

- Seed templates: `packages/domain/src/index.ts`
  (`SEED_TEMPLATES`, `GENERIC_SEED_TEMPLATE`, `LA_SEED_TEMPLATE`,
  `resolveSeedTemplate`).
- Seed logic: `apps/api/src/onboarding.ts` (`seedCompanyDefaults`).
- Create / membership routes: `apps/api/src/routes/companies.ts`.
- Invite routes: `apps/api/src/routes/invites.ts` (migration
  `134_company_invites.sql`).
- Tenancy / RLS: migrations `066`, `085`, `101`, `145`; `apps/api/src/auth.ts`.
