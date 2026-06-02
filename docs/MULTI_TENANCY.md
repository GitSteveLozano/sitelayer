# Multi-Tenancy: Invariants + Audit

Sitelayer is a **multi-tenant** platform: one deployment serves many construction
companies. The operator is onboarding multiple companies, so every code path must
treat a 2nd/Nth company as first-class. This doc states the RULES future code must
follow and records the audit (`feat/tenant-hazard-sweep`) that swept the codebase
for remaining single-tenant assumptions after the worker went multi-company
(`d3d870e1`).

## Tenancy model (verified)

- `companies` + `company_memberships` (Clerk user → role) define tenants and access.
- **RLS** isolates child rows: the `app.company_id` GUC (`app_current_company_id()`)
  is set via `SET LOCAL` inside `withMutationTx` / `withCompanyClient`
  (`apps/api/src/mutation-tx.ts`). Prod connects as a **non-owner `NOBYPASSRLS`**
  role so `FORCE ROW LEVEL SECURITY` applies. The RLS FORCE audit
  (`apps/api/src/routes/rls-force-audit.ts`) is a **blocking gate** with an
  allowlist ratchet over every table that has a `company_id` column.
- `companies` is the tenant **registry** (its `id` IS the `company_id`); it has no
  `company_id` column, is not in the RLS-FORCE set, and access to a company row is
  gated in the app layer by a `company_memberships` lookup (`getCompany()`).
  Per-company config columns therefore live on `companies` without a new RLS policy.
- Per-tenant integration config lives on the per-company row, NOT in process env:
  `integration_connections` (per `company_id` + `provider`) carries QBO/CompanyCam
  tokens + flags; `companies` carries profile/feature columns (`modules`,
  `portal_settings`, `labor_payroll_auto_post_*`, and — new in migration 150 —
  `notification_from_*`).

---

## RULES (the invariants future code MUST follow)

1. **Always scope DB access via the company seam.** Multi-statement reads go
   through `withCompanyClient(companyId, …)`; writes go through
   `withMutationTx(companyId, …)`. Both `SET LOCAL app.company_id` so RLS does the
   isolation. A single `pool.query` is only acceptable when it ALSO carries an
   explicit `where company_id = $1` (app-layer scoping), and even then RLS-FORCE
   is the backstop. Never run a bare `pool.query` against a `company_id` table
   without one of: (a) the GUC bound, or (b) an explicit `company_id =` predicate.

2. **Never hardcode a company.** No `'la-operations'`, no default-company UUID, no
   `ACTIVE_COMPANY_SLUG`/`ACTIVE_USER_ID` constant in a runtime decision. Resolve
   the company from the request (`x-sitelayer-company-id` / `x-sitelayer-company-slug`
   → membership) or, in the worker, from `listActiveCompanies()`. The env defaults
   exist ONLY as a dev/auth-bypass fallback for a single-tenant local stack and
   must never reach a real multi-tenant decision (see Finding 1).

3. **Per-tenant config goes in the DB, not env.** If a setting can differ between
   two companies (feature flag, integration toggle, live/dry-run, sender identity,
   rate cap, model key, bucket prefix), it belongs on a per-company row
   (`companies.*` column / jsonb, or `integration_connections.*`), NOT a global
   `process.env`. The ONLY legitimate env role for such a setting is a
   **cluster-wide kill switch** that can force ALL companies off (the
   `QBO_LIVE_* = '1'` pattern): `effective = clusterKillSwitchOn AND perCompanyFlag`.

4. **The worker drains EVERY company.** New per-company runners take a `companyId`
   and are called from the per-company loop in `apps/worker/src/worker.ts`
   (`for (const company of companies)`). Company-agnostic maintenance (global
   tables, cross-tenant notification drain) runs ONCE per heartbeat — never assume
   "the one company."

5. **In-memory caches/singletons must be keyed by `company_id`** when they hold
   per-tenant data. A module-level `Map`/`Set` that memoizes tenant rows without a
   `company_id` in the key is a cross-tenant leak. (Global-by-design caches — e.g.
   the `dispatch_lanes` kill-switch cache keyed by lane name, the Clerk-user-email
   cache keyed by the globally-unique Clerk id — are fine; document WHY.)

6. **External resources are per-company.** Blueprint/photo storage keys are
   `companyId`-prefixed and validated by `assertKeyInCompany`. Each company OAuths
   its OWN QBO/CompanyCam (`integration_connections` per `company_id`; the OAuth
   state token carries `companyId`). Email senders resolve per company with an env
   fallback (migration 150 + `resolveCompanyNotificationSender`).

7. **Cross-company endpoints are platform-admin gated.** Any route that
   intentionally reads across tenants (`/api/admin/*`) MUST go through
   `authorizePlatformAdmin` first. Regular entity routes resolve exactly one
   company and never widen.

8. **Schema changes are expand → backfill → contract** and forward-only. Add a new
   numbered migration in `docker/postgres/init/` (never edit an applied one — the
   `schema_migrations` sha256 ledger rejects a checksum change). New code tolerates
   the old schema during rollout (catch `42703` undefined_column → safe default).

---

## AUDIT FINDINGS (this slice)

Each runtime hazard was classified **REAL** (a multi-tenant bug, fixed here) or
**BENIGN** (a legit dev/test default or a correctly global concern).

### Finding 1 — auto-onboard inserted into the WRONG tenant — **REAL (fixed)**

`apps/api/src/server.ts` first-user self-onboard used the process-wide
`activeCompanySlug` (`ACTIVE_COMPANY_SLUG ?? 'la-operations'`) for the
`company_memberships` insert and for the 404 message, instead of the slug the
REQUEST resolved to. With multiple companies, a request for company B that hadn't
onboarded would (a) grant the user `admin` on **la-operations** (the wrong tenant)
and (b) still 404 on company B with a misleading "company slug la-operations not
found". Fixed: the onboard now uses `getCurrentCompanySlug(req)` (the same resolver
`getCompany()` uses), extracted into the pure, tested `autoOnboardFirstAdmin`
(`apps/api/src/auto-onboard.ts`). Single-tenant dev behavior is unchanged (the
resolver still falls back to the env default when no header is present).
Tests: `apps/api/src/auto-onboard.test.ts`.

### Finding 2 — email `from` lives in a global env — **REAL (expand shipped + flagged)**

Every outbound email (invites, estimate shares, sync-failure alerts, welcome
emails) is sent from a single `EMAIL_FROM` env
(`apps/{api,worker}/src/email.ts:loadEmailConfig`). That is the SAME
config-in-global-env class migration 144 moved for QBO-live: a setting that
legitimately differs per company. **Expand step shipped:** migration 150 adds
`companies.notification_from_email` / `notification_from_name` (nullable, default
NULL → env fallback), and `resolveCompanyNotificationSender`
(`apps/worker/src/company-notification-sender.ts`) reads them with the env as the
fallback, so behavior is byte-for-byte unchanged for every existing company.
Tests: `apps/worker/src/company-notification-sender.test.ts`. **Flagged** — see
"Flagged follow-ups" below for the verification/send-path/contract work that is
larger than this slice.

### BENIGN (verified correct, no change)

- **`server.ts` `activeCompanySlug` / `activeUserId` env defaults** — dev/auth-bypass
  fallbacks only. The web client always sends `x-sitelayer-company-slug`; the
  defaults never reach a multi-tenant decision once the header is present. After
  Finding 1, the remaining use is purely the no-header local-dev fallback.
- **Worker multi-tenant drain** (`worker.ts`, `companies.ts`) — `listActiveCompanies`
  iterates ALL companies; `ACTIVE_COMPANY_SLUG` is an OPTIONAL single-company
  override. Per-company runners are all `companyId`-scoped. Correct.
- **QBO live gating** (`qbo-live.ts` + runners) — per-company flag
  (`integration_connections.qbo_live_enabled`) AND the env kill switch. The
  legacy `selectLaborPayrollPush` helper has zero callers (dead). Correct.
- **CompanyCam poll** (`companycam-poll.ts`) — API key read from
  `integration_connections.access_token` per `company_id`; `LIVE_COMPANYCAM` is the
  cluster kill switch. Every query company-scoped. Gold-standard pattern.
- **Rate limiter** (`rate-limit.ts`) — composite `scope:key` buckets, with a
  dedicated per-COMPANY bucket; user key is the globally-unique Clerk id. Already
  multi-tenant-aware.
- **`dispatch_lanes` cache** (`dispatch-lanes.ts`) — keyed by lane name; the table
  is intentionally global (fleet-wide kill switch, no `company_id` — migration 094).
  Benign.
- **Clerk-hydrate / clerk-email caches** — keyed by the globally-unique Clerk user
  id, not per tenant. Benign.
- **`company_bootstrap_state`** read — `where company_id = $1`. Scoped.
- **Storage keys** (`storage.ts`) — `companyId`-prefixed + `assertKeyInCompany`
  blocks path-traversal cross-tenant access. Correct.
- **`takeoff_drafts`, `rental_rate_tiers`, pricing-overrides** (RLS allowlisted
  "known gaps", not yet FORCE'd) — every app-layer query carries an explicit
  `where company_id = $1`, so app-layer scoping is correct today; the sibling RLS
  slice forces them at the DB layer as the backstop.
- **`/api/admin/*`** — `authorizePlatformAdmin` gate runs before any cross-company
  query; intentionally cross-tenant by design.

---

## Flagged follow-ups (larger than this slice)

- **Per-company email send-path (Finding 2 contract step).** Before the worker may
  actually send FROM a per-company address, each company needs domain/sender
  **verification** (SPF/DKIM/DMARC via SES/Resend), an operator UI to set + verify
  it, and a `notification_from_verified` state column gating use. Only after a
  company is verified should `resolveCompanyNotificationSender` feed the send path;
  then the env `EMAIL_FROM` becomes the unverified-fallback. Until then the resolver
  is read-only/fallback-safe and not wired into `sendEmail`.
- **RLS FORCE the remaining allowlisted `company_id` tables** (pricing overrides,
  `rental_rate_tiers`, `takeoff_drafts`, `takeoff_capture_artifacts`,
  `qbo_sync_runs`) — owned by the sibling RLS slice; app-layer scoping is correct in
  the meantime.
- **`dispatch_lanes` per-company kill switches** — global today (acceptable for the
  current cohort, documented in migration 094). Revisit if a tenant needs an
  isolated lane pause.
- **In-memory rate-limit + idempotency caches are per-replica.** Single API replica
  today; moving to N replicas needs a shared store (the composite keys are already
  tenant-correct, so it is a storage swap, not a keying change).

## Migrations introduced by this slice

- `docker/postgres/init/150_company_notification_sender.sql` — adds
  `companies.notification_from_email` + `notification_from_name` (additive,
  nullable, env-fallback; no backfill, no new RLS policy — `companies` is the
  membership-gated registry, not an RLS-FORCE'd child table). **RENUMBER FLAG:**
  numbered 150 to leave 146–149 for the sibling RLS
  slice; if both land, renumber whichever lands second (pure rename — additive
  content).
