# Scenario Harness, Site Admin & Impersonation — Design + Living Plan

> **STATUS (keep this banner current — it's the handoff):**
>
> - **v0.9 — 2026-06-01. ALL PHASES P0–P5 SHIPPED + impersonation banner.** P3 completed: scenario console read endpoints (`/api/admin/workflows`, `/api/admin/scenarios[/:slug/plan]` on the P0 engine) + a lazy, bundle-safe Site Admin UI at `/admin` (Companies / Workflows / Scenarios with live plan preview), and the persistent "viewing as X" impersonation banner (`/api/session` now returns `mode` + `impersonated_by`; `ImpersonationBanner` mounted in `AppShell`). Whole initiative green: `apps/api` + `apps/web` + `packages/scenario` typecheck clean, web build passes, 110 unit tests + 3 ephemeral-PG golden tests. Commits `3001216` (P3 backend) `b0e4608` (P3 UI) `7355e8f` (banner). **Follow-ons (not blockers):** scenario-apply/spin-up-demo mutations + the read_write-impersonation safety elevation, and the pre-existing `desktop-workspace` chunk is over the lazy bundle budget (prior agent's uncommitted edit — unrelated to this work).
> - **v0.8 — 2026-06-01. P0–P2 + P4–P5 DONE (backend); tip green.** Net state on `dev-np`: P0 scenario engine, P1 fragment library + golden snapshots, P2 platform-admin trust boundary + read-only `/api/admin/companies[/:id]`, P4 impersonation backend (act-claim Identity, `impersonated_by` audit tagging, `POST /api/admin/impersonate` + actor-token minter + ledger), P5 prod mutation gate. `apps/api` + `packages/scenario` typecheck clean; ~120 unit tests + 3 ephemeral-PG golden tests. **P3 (the Site Admin builder UI) is the ONLY remaining phase and is NOT started** — there is no `/admin` SPA route or page yet (a frontend session is needed: lazy + bundle-budget-safe route in `App.tsx`, guided timeline editor over `nextEvents`, and the "viewing as X" impersonation banner reading `Identity.mode`). The P2/P4 read endpoints it will consume exist; a `/api/admin/workflows` + `/api/admin/scenarios[/:slug/plan]` read layer (trivial over `listWorkflows()` + `@sitelayer/scenario`) is a quick follow-on when the UI lands.
> - **v0.7 — 2026-06-01. P4 (impersonation backend) + P5 (prod gate) SHIPPED.** Clerk `act`-claim `Identity` contract; `impersonated_by` audit tagging (mig 132, auto via request context); `POST /api/admin/impersonate` mints Clerk actor tokens (reason + TTL, read-only-view default, `impersonation_sessions` ledger mig 133); prod mutation gate (`PLATFORM_ADMIN_PROD_ENABLED`). Commits `905d5a3` (P4a) `be00d49` (P4b) `4794ff5` (P4c) + P5. **Remaining: P3 builder UI + the SPA impersonation banner.**
> - **v0.6 — 2026-06-01. P2 SHIPPED (read-only).** Platform-admin trust boundary: `platform_admins` migration (130) + `admin-auth.ts` gate (`requirePlatformAdmin`/`isSuperadmin`, env allowlist ∪ table, Clerk-session-only) + read-only `/api/admin/companies[/:id]` wired in `dispatch.ts`. 23 admin unit tests. /admin requires a real Clerk session (demo/prod). **P3–P5 pending.**
> - **v0.5 — 2026-06-01. P1 SHIPPED.** Fragment library (`packages/scenario/src/library.ts` — composable parameterized factories + `composeScenario`) + plan golden snapshots over every `scenarios/*.yaml` (`golden.test.ts` + committed `__snapshots__/`). 49 unit tests green. Registry property tests already live in `packages/workflows`. **P2–P5 pending.**
> - **v0.3 — 2026-05-31.** Grounded against live code + **operator decision recorded**: superadmin = a Clerk identity with FULL access, no graduated roles (§5, OQ1 closed). Author near 100% weekly usage; may stop mid-stream.
> - **v0.2 — 2026-05-31.** Skeleton + core thesis + grounded against live code (registry, auth, companies route, scenario format all confirmed — see ✅ marks).
> - **Why this doc exists:** single source of truth for the design so a fresh agent can resume. **Read the "HANDOFF / NEXT STEPS" section (§10) first.**
> - **Not yet implemented** — design + phased plan. Nothing is built unless a section says "DONE" with a commit SHA.
> - **Biggest confirmation:** the scenario-as-composable-event-sequence model is NOT aspirational — `scenarios/*.yaml` already encodes each entity's timeline as a `*_event_log` array replayed through `applyEventSequence`. We're adding a Zod schema, a guided UI to author those arrays, a platform admin, and impersonation around an existing core.

---

## 0. TL;DR — the thesis

Sitelayer already has the hard part: **every business process is a pure, deterministic state machine** (`packages/workflows/` reducers `(snapshot, event) → snapshot` + `nextEvents(state)` + an append-only `workflow_event_log`). That foundation lets us treat **a test/demo scenario as a declarative list of workflow events**, replayed through the same reducers production uses. From that one primitive we get, with very little new machinery:

1. **Deterministic tests** — a scenario is reproducible bit-for-bit (pure reducers + idempotent, ref-hashed seeds).
2. **Composable scenarios** — the end-state of one fragment is the start-state of the next, so scenarios _chain_.
3. **A scenario-builder UI** — because `nextEvents(state)` enumerates the legal next events, the builder can guide a human to construct an always-valid scenario, preview the resulting snapshots, and export YAML or apply it straight to a dev/demo DB.
4. **A site admin** (cross-tenant superadmin) that drives all of the above and can spin up demos on the dev UI.
5. **A production admin** (same shell, prod-safe: read-mostly, gated, audited).
6. **Impersonation** — "view as user X": a cheap dev/demo path (the existing act-as header) and a real, audited prod path.

The big idea: **the scenario engine, the seed system, the demo tier, and impersonation are all the same machine viewed from different angles.** A seeded scenario is _indistinguishable from real usage history_ because it's produced by the exact reducers + event-log writes that real requests produce.

---

## 1. Foundations we already have (the assets to build on)

> _(verify each against live code — see NEXT STEPS; file paths from CLAUDE.md + the 2026-05-31 session.)_

| Asset                                       | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Why it matters here                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pure workflow reducers + a registry** ✅  | `packages/workflows/src/registry.ts` — `WorkflowDefinition` carries `{name, schemaVersion, initialState, terminalStates, allStates, allEventTypes, reduce, nextEvents, isHumanEvent, sideEffectTypes}`; `getWorkflow(name[, version])` (versioned, so old event-logs replay through the reducer that wrote them). Workflows: rental_billing_run, estimate_push, crew_schedule, project_closeout, time_review_run, labor_payroll_run, project_lifecycle, field_event, rental, daily_log, notification, shipment, damage_charge_settlement, rental_request_approval, qbo_sync_run, scaffold_ops_approval, change_order. | **One stable surface for everything here.** A scenario step = one event applied to a snapshot. `allStates`/`allEventTypes`/`terminalStates` drive exhaustive property tests; `nextEvents`/`isHumanEvent` drive the guided builder.                           |
| **`nextEvents(state)` + `isHumanEvent`** ✅ | each definition; surfaced as `WorkflowSnapshot.next_events`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Powers a **guided** builder — only legal, human-dispatchable events are offered at each step.                                                                                                                                                                |
| **`applyEventSequence`**                    | `packages/workflows/src/test-replay.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Walks an event list through the reducer AND writes `workflow_event_log` rows identical to production. Already used by seed fixtures to author "stuck mid-flight" states. **This is the scenario-execution primitive.**                                       |
| **Append-only event log**                   | `workflow_event_log` (unique `(entity_id, workflow_name, state_version)` after mig 106) + `scripts/replay-workflow.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Lets a scenario reproduce a full audit trail; replay audits prod.                                                                                                                                                                                            |
| **Declarative seeds**                       | `scripts/seed-scenario.ts` + `scenarios/*.yaml` (e.g. `steve-demo.yaml`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Already the "scenario as data" format. Deterministic (ref-hashed UUIDs), idempotent (ON CONFLICT DO NOTHING). **The builder's export target.**                                                                                                               |
| **Frontend XState**                         | `apps/web/src/machines/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | UI orchestration only (loading/submitting/error/outOfSync) — never mirrors business state. Headless renders `state+context+next_events`. The builder UI is itself an XState machine.                                                                         |
| **Dev/preview impersonation**               | `x-sitelayer-act-as: e2e-<role>` header + `RoleSwitcher` (`apps/web/src/components/dev/RoleSwitcher.tsx`) + `resolveActAsOverride` (`apps/api/src/auth.ts`, `tier !== 'prod'` only)                                                                                                                                                                                                                                                                                                                                                                                                                                   | The cheap "view as role" primitive. Canonical ids: `e2e-{admin,foreman,office,member,bookkeeper}`.                                                                                                                                                           |
| **Tier system**                             | `APP_TIER` guard (`packages/config`), tiers local/dev/preview/demo/prod                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Lets the same admin shell behave differently per tier (full power on dev, gated on prod).                                                                                                                                                                    |
| **Demo tier**                               | `demo.preview.sitelayer.sandolab.xyz`, Clerk-ON magic-link sign-in tokens, `/api/demo/sign-in-link`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Already a "spin up a populated, role-switchable demo" path — generalize it.                                                                                                                                                                                  |
| **Company RBAC + company CRUD** ✅          | `company_memberships` (admin/foreman/office/member/bookkeeper; `packages/domain/src/roles.ts`); routes in `apps/api/src/routes/companies.ts` (`handleCompanyRoutes`, `getMemberships(pool, userId)`, slug validation) + an `estimate-shares-admin.ts` precedent for an admin-namespaced route                                                                                                                                                                                                                                                                                                                         | Tenant-scoped only. **There is NO platform-level admin today** (confirmed: no `platform_admin`/`superadmin`/`impersonat*` route exists). Reuse `companies.ts`+`getMemberships` as building blocks; we add a **platform-scoped** role _above_ company RBAC.   |
| **Identity resolution** ✅                  | `apps/api/src/auth.ts` — `resolveIdentity(req, config) → Identity = {userId, source:'clerk'\|'internal'\|'header'\|'default'}`; `verifyClerkJwt` (RS256, reads `sub`); an **`internal` bearer path** (`INTERNAL_AUTH_TOKEN` → `{userId: x-sitelayer-user-id ?? 'service', source:'internal'}`)                                                                                                                                                                                                                                                                                                                        | The single hook for impersonation: extend `Identity` with `actorUserId` + `mode`; `verifyClerkJwt` is where a Clerk `act` claim would surface; the `internal` path is the server-trust precedent the `/admin` backend can use to act on behalf of a subject. |

---

## 2. Core idea — scenarios as composable event sequences

A **scenario** is a declarative document that resolves to:

```
scenario := {
  fixtures:  [ company, customers, projects, workers, service_items, ... ]   // static rows
  timelines: [ { entity, workflow, initial_snapshot, events: [...] }, ... ]  // driven through reducers
  time:      relative offsets (today's schedule, clocked-in-now), resolved at apply time
}
```

- **Static fixtures** are upserted by stable ref-hashed UUID (today's `seed-scenario.ts` behavior).
- **Timelines** are executed via `applyEventSequence` → produces the entity row at its final snapshot **and** the matching `workflow_event_log` corpus. The result is byte-identical to what a real user clicking through the app would have produced.

**Composition / chaining.** Because a timeline is `(initial_snapshot, events[])` and reducers are pure:

- A **fragment** = a named, parameterized partial scenario ("a rental mid-billing-dispute", "a project at `estimating` with one AI-takeoff draft pending review", "a payroll run stuck at `failed`").
- A **scenario** = an ordered composition of fragments over a shared company; the resolved end-state of fragment N is the start-state context fragment N+1 builds on.
- **Branching for tests**: from any saved snapshot, fork by applying a different event → new scenario. The "scenario tree" is just the event-log DAG.

This is the same model as deep test-replay: a scenario IS a replay script.

**✅ This is already the format.** `scripts/seed-scenario.ts` parses a `ScenarioYaml` interface where each timeline-bearing entity carries its event list inline: `projects[].lifecycle_event_log`, `rentals[].billing_event_log`, `estimates[].push_event_log`, `worker_issues[].issue_event_log`, `damage_charges[].settlement_event_log`, `rental_requests[].approval_event_log`, `qbo_sync_runs[].sync_event_log`, `boms[].approval_event_log`. Static fixtures (`company`, `members`, `customers`, `workers`, `inventory`, `projects`, …) upsert by `ref`-hashed UUID; time-relative rows use `*_offset_minutes`/`*_offset_days`. So the new work is: (a) lift this from a hand-written TS interface into a **shared Zod-validated schema** + engine (`packages/scenario/`), (b) a **UI that generates those `*_event_log` arrays** via `nextEvents`, (c) admin + impersonation around it. The replay/apply path (`applyEventSequence`) already exists and is proven (the `steve-demo` seed, build `ad8a733`, produced 6 `workflow_event_log` rows this way).

---

## 3. Deterministic testing strategy

Layers, cheapest → richest:

1. **Reducer unit tests** (exist). Pure `(snapshot, event)` table tests per workflow. Add **property tests** with `fast-check` (already a devDep in `packages/workflows`): generate random _legal_ event sequences (guided by `nextEvents`) and assert invariants (no illegal transition, monotonic `state_version`, terminal states absorbing, replay determinism).
2. **Scenario replay tests**: load a `scenarios/*.yaml`, run it through `applyEventSequence` against an ephemeral PG (the migrate-in-CI Postgres 18), assert the resulting rows + event-log match a golden snapshot. Catches reducer/schema drift.
3. **API contract tests** (exist, vitest): `GET …/:id` returns `{state, state_version, context, next_events}`; `POST …/events` applies + 409s on stale version. Drive these from scenario fragments.
4. **Web headless tests** (exist): components render `state+context+next_events`; XState wraps only UI state.
5. **E2E** (Playwright, `seed:e2e`): seed a scenario, impersonate a role (act-as on dev), walk the UI. **Scenario + impersonation = full role-based E2E without standing up Clerk.**

Determinism guarantees: pure reducers, ref-hashed UUIDs, idempotent upserts, time via explicit offsets resolved once at apply. The only nondeterminism to police is `now()`/random — already handled by offset fields + stable id derivation.

**Chaining for new scenarios in tests**: a test helper `runFragments([frag1, frag2, ...], {company})` that threads the shared company + resolved context across fragments. Each fragment returns the entity ids it created so later fragments can reference them.

---

## 4. Scenario builder (UI + engine)

### Engine (headless, reusable in tests + UI)

- `packages/scenario/` (new): a pure library that takes a scenario doc, validates it (Zod), resolves fixtures + timelines, and emits an **apply plan** (ordered SQL/event ops). Reuses `@sitelayer/workflows` reducers + `applyEventSequence`. No DB driver — returns ops the caller executes in one tx (mirrors the workflow event-route pattern).
- Round-trips: **doc ↔ apply-plan ↔ YAML**. The current `seed-scenario.ts` becomes a thin CLI over this engine.

### Builder UI (lives in Site Admin, dev/demo only by default)

- **Guided timeline editor**: pick a workflow + entity, see the current snapshot and the `next_events` chips, click one to advance; the panel shows the resulting snapshot diff. Always-legal by construction.
- **Fixture forms**: company template (LA-ops default via `seedCompanyDefaults`), customers, projects, crew, service items.
- **Live preview**: apply to a scratch schema and render the actual app screens (reuse impersonation to "view as" each role).
- **Export / apply**: save as `scenarios/<name>.yaml` (PR-able) **or** "Apply to dev" / "Apply to demo" / "Spin up a fresh demo company" buttons.
- Itself an XState machine (`scenario-builder.ts`): states `editing → previewing → applying → applied | error`. UI-only state; the scenario doc is the business data.

### "Spin up a demo for testing" flow

1. Pick or compose a scenario (or clone `steve-demo`).
2. Choose target: new company in `sitelayer_dev`, or a fresh per-demo company in `sitelayer_demo`, or an ephemeral PR-preview schema.
3. Engine applies it; admin gets magic-links per role (reuse `/api/demo/sign-in-link` generalized to any seeded company) or act-as links on dev.

---

## 5. Site admin (cross-tenant superadmin)

**The privilege gap.** Today roles are _company-scoped_ (`company_memberships`). There is **no platform-level admin**. We need one.

**DECIDED (operator, 2026-05-31): superadmin = a specific Clerk identity with FULL access to everything.** No graduated roles for v1 — a superadmin can see and do anything across all tenants. (`support`/`read_only` sub-roles can be added later if ever needed.)

Model:

- **Identity:** keyed by the Clerk user id (`sub` from the verified Clerk JWT — `verifyClerkJwt` in `auth.ts`). A request is superadmin iff its `sub` is in the superadmin set.
- **Storage:** a small `platform_admins(clerk_user_id, created_at, note)` table (new numbered migration) so the set is auditable + editable without a redeploy; an **env allowlist** (`PLATFORM_SUPERADMIN_CLERK_IDS`) bootstraps the first admin (and is the source of truth on prod until the table is populated). `isSuperadmin(sub) = sub ∈ (env allowlist ∪ platform_admins)`.
- **Gate:** `requirePlatformAdmin` middleware on a new `apps/api/src/routes/admin/*` namespace — verifies a real Clerk JWT, then `isSuperadmin(sub)`. Never reachable via the company-JWT path, the act-as header, or the header-fallback identity. Superadmin grants cross-tenant access (no `company_id` scoping for these routes), so the check must be airtight + every call audited.
- **UI:** a `/admin` shell in `apps/web` (full-screen route mounted in `App.tsx`, behind the gate), distinct from the tenant `MobileShell`.
- **Capabilities (full):** list/search all companies & users, create/seed/reset scenario companies, run the scenario builder, view any tenant's audit/event-log, manage memberships, and **impersonate any user** (§7).

Why separate from the company `admin` role: a company admin must never see other tenants; superadmin is a different trust boundary entirely and is audited harder. The two are unrelated grants (a superadmin need not be a member of any company).

---

## 6. Production admin system

Same `/admin` shell + `platform_admins`, but **prod policy is restrictive by default**:

- **Read-mostly**: inspection (companies, users, sync queue, audit, workflow snapshots/replay) is fine; **mutations are gated** (explicit confirm + reason, recorded to `audit_events`).
- **No scenario seeding into prod** (the seeder already refuses `APP_TIER=prod`; keep that — scenarios are a dev/demo concept). Prod admin is for support/ops, not fixture authoring.
- **Impersonation is the sensitive capability** — see §7; in prod it is audited, time-boxed, reason-required, and visibly flagged.
- Everything behind `requirePlatformAdmin` + a prod-specific second gate (e.g. `PLATFORM_ADMIN_PROD_ENABLED` + per-action allowlist).

---

## 7. Impersonation — two tiers, one mental model

"View as user X." Two implementations sharing one audit contract:

### A. Dev/demo "act-as" (exists, cheap, no real auth)

- The `x-sitelayer-act-as: e2e-<role>` header → `resolveActAsOverride` overrides identity when `tier !== 'prod'`. `RoleSwitcher` writes `localStorage['sitelayer.act-as']`.
- Generalize from fixed `e2e-<role>` ids to **any seeded user id** in the scenario company, so the builder/admin can "view as Steve's foreman" exactly.
- This is the testing workhorse — fast, no Clerk round-trip.

### B. Prod "audited impersonation" (new, support use case)

- A site admin requests an impersonation session for user X **with a reason**. The system mints a **scoped, time-boxed session** that carries BOTH the subject (user X) and the **actor** (the real admin) — never drops the admin's identity.
- Two viable mechanisms (decide in OPEN QUESTIONS):
  1. **Clerk actor tokens / sign-in tokens** (Clerk supports an `actor` claim for impersonation) → cleanest, the app already verifies Clerk JWTs.
  2. **Internal impersonation JWT**: `{ sub: userX, act: adminId, exp: short }`, verified alongside Clerk; `auth.ts` resolves `sub` for data scoping but stamps `act` on every `audit_events` row.
- **Hard requirements (prod):** explicit reason, short TTL, every mutation tagged `impersonated_by = adminId` in `audit_events`, a persistent UI banner ("You are viewing as X — impersonated by you"), and an impersonation-session ledger. Optionally read-only-by-default with explicit elevation.

The unifying contract: **extend the existing `Identity` (`{userId, source}`) to `{ userId /*=subject/effective*/, actorUserId?, source, mode?: 'self'|'act_as'|'impersonate' }`** in `apps/api/src/auth.ts`, and have the audit layer always record `actorUserId` when present. `resolveActAsOverride` populates it on dev/demo; `verifyClerkJwt` reads a Clerk `act` claim (or an internal impersonation JWT is verified) on prod. Every consumer that scopes data uses `userId`; every consumer that writes `audit_events` stamps `actorUserId`. One contract, two gates, two audit strictness levels.

---

## 8. Implementation phases (proposed)

- **P0 — Scenario engine extraction** (`packages/scenario/`): factor the doc→plan logic out of `seed-scenario.ts`; Zod schema for the scenario doc; `runFragments` test helper. _Unblocks everything; pure, low risk._
- **P1 — Scenario replay tests + fragment library**: ✅ **DONE (2026-06-01).** `packages/scenario/src/library.ts` — parameterized fragment factories (`projectInProgress`/`projectAtEstimating`, `rentalStuckPosting`/`rentalPostedInvoice`/`rentalBillingFailed`, `estimatePushPendingReview`/`estimatePushFailed`, `damageChargeOpen`/`damageChargeInvoiced`, `qboSyncRunFailed`, `bomApproved`, `rentalRequestApproved`, `starterFixtures`) + `composeScenario()` merge, all mirroring the proven `scenarios/*.yaml` event shapes. Plan golden snapshots over every fixture (`golden.test.ts` + committed `__snapshots__/`). 49 unit tests total. Registry-level `fast-check` property tests already exist per-workflow in `packages/workflows/src/*.property.test.ts`, so not duplicated here.
- **P2 — `platform_admins` + `requirePlatformAdmin` + `/admin` API skeleton** (read-only): ✅ **DONE (2026-06-01).** Migration `130_platform_admins.sql`; `apps/api/src/admin-auth.ts` (`parseSuperadminEnvIds`, `isSuperadmin` = env allowlist ∪ `platform_admins` table, `requirePlatformAdmin`/`authorizePlatformAdmin` — requires `source==='clerk'`, unreachable via act-as/header/internal/default); `apps/api/src/routes/admin.ts` read-only `GET /api/admin/companies` (cross-tenant list + member counts) + `GET /api/admin/companies/:id` (company + memberships), wired first in `dispatch.ts`. 23 unit tests. **NOTE:** /admin needs a real Clerk session, so it's reachable on demo/prod (Clerk on), not local/dev header-fallback — bootstrap the first admin via `PLATFORM_SUPERADMIN_CLERK_IDS`.
- **P3 — `/admin` UI shell + scenario builder**: ✅ **DONE (2026-06-01).** Read endpoints `/api/admin/workflows` + `/api/admin/scenarios[/:slug/plan]` (on the P0 engine + registry); a lazy, bundle-safe Site Admin console at `/admin` (Companies / Workflows / Scenarios with a live apply-plan preview). _Follow-on: the guided `nextEvents` timeline EDITOR + apply / spin-up-demo mutations — read views shipped, authoring is the next slice._
- **P4 — Impersonation**: ✅ **DONE (backend, 2026-06-01).** P4a: `Identity` gains `actorUserId`/`mode`; `verifyClerkJwt` reads the Clerk `act` claim. P4b: `audit_events.impersonated_by` (mig 132) auto-stamped on every audited mutation via the request context (set once in `server.ts` — zero per-route changes). P4c: `POST /api/admin/impersonate` mints Clerk actor tokens (`clerk-actor-token.ts`), reason-required, TTL-bounded, **read-only-view by default (OQ6)**, recorded in the `impersonation_sessions` ledger (mig 133); `GET /api/admin/impersonation-sessions` reads it. _Remaining: the SPA "viewing as X" banner ships with P3._
- **P5 — Prod admin hardening**: ✅ **partial (2026-06-01).** Prod-specific second gate — admin mutations (impersonate) are blocked in prod unless `PLATFORM_ADMIN_PROD_ENABLED=1`; reason mandatory + audited; impersonation ledger live. _Remaining: broader prod-policy review; future admin mutations reuse the gate+reason+audit pattern._

Each phase is independently shippable to `dev` first (scratch lane), promoted to `main` deliberately.

---

## 9. Open questions / decisions needed

1. ~~**Platform role storage**~~ ✅ **DECIDED (2026-05-31):** superadmin = a Clerk identity (`sub`) with FULL access; no graduated roles for v1. Storage = `platform_admins` table + `PLATFORM_SUPERADMIN_CLERK_IDS` env bootstrap. See §5.
2. ~~**Prod impersonation mechanism**~~ ✅ **DECIDED (operator, 2026-05-31): use Clerk.** Concrete mechanism: Clerk **actor tokens** — `POST https://api.clerk.com/v1/actor_tokens` with `{ user_id: <subject>, actor: { sub: <impersonator_clerk_id> }, expires_in_seconds }`, authed by `CLERK_SECRET_KEY`, redirect via `?__clerk_ticket=`. This is the **exact sibling** of the demo's existing minter (`apps/api/src/routes/demo.ts` → `POST /v1/sign_in_tokens`), so reuse that code path. The resulting Clerk session JWT carries an **`act` claim**; extend `verifyClerkJwt` (`auth.ts`, currently reads only `sub`) to also read `act` → `Identity.actorUserId`. No internal-JWT fallback needed.
3. **Where do scenario YAMLs live** — in-repo (`scenarios/`, PR-able, versioned) is the default; does the builder also persist user-built scenarios to a DB table for non-engineers? (Lean: export to repo YAML for durable ones; a `scenario_drafts` table for WIP.)
4. **Demo company multiplicity** — one curated `steve-demo` vs many per-prospect demo companies in `sitelayer_demo`? (Affects builder "spin up demo" target.)
5. ~~**Prod admin scope**~~ → implied by §5 "full access": superadmin CAN mutate in prod. Keep mutations behind an explicit confirm + reason and always audit; not a hard read-only wall.
6. **Impersonation in prod posture** — given superadmin = full access, capability is read-write. Still REQUIRED regardless: a persistent "viewing as X (impersonated by <admin>)" banner, short TTL, reason captured, and every write tagged `impersonated_by`. Optional read-only _view mode_ as a safety toggle (not a restriction). _Operator hasn't explicitly chosen the default toggle; lean read-only-view-by-default with one-click elevation._
7. **Bundle budget / chunking** for the `/admin` UI (the prettier+bundle gate is sensitive — see `sitelayer-prettier-quality-gate` memory).

---

## 10. HANDOFF / CURRENT STATUS / NEXT STEPS ← read this first if resuming

**Current state (v0.3):** Design grounded against live code. **OQ1 DECIDED**: superadmin = Clerk identity, full access (§5). Nothing implemented yet.

**Decisions made:** OQ1 (superadmin = Clerk identity, full access) ✅; OQ2 (prod impersonation = Clerk **actor tokens** via `POST /v1/actor_tokens`, reuse the demo minter, read `act` claim in `verifyClerkJwt`) ✅.

**Decision still open (does NOT block P0–P3):**

- **OQ6 — prod impersonation toggle default** (read-only-view vs read-write). Capability is full either way (superadmin); just the default posture + safety toggle. Confirm with operator before shipping P4's prod path.

**Immediate next steps (in order):**

1. **P0 — extract `packages/scenario/`**: lift the `ScenarioYaml` interface (`scripts/seed-scenario.ts:241`) into a Zod schema + a pure doc→apply-plan engine; make `seed-scenario.ts` a thin CLI over it; add a `runFragments([...], {company})` test helper. Pure, low risk, unblocks all. **← suggested first code task.**
2. **P1 — scenario replay tests + a small fragment library** (golden snapshots over an ephemeral PG); add `fast-check` property tests over the registry's `allStates`/`allEventTypes`/`terminalStates`.
3. **P2 — `platform_admins` migration + `PLATFORM_SUPERADMIN_CLERK_IDS` env + `requirePlatformAdmin` + read-only `/admin` API** (reuse `companies.ts`/`getMemberships`). Resolve OQ2 (verify Clerk actor tokens) in parallel.
4. **P3 — `/admin` UI + guided scenario builder** (generates `*_event_log` arrays via `nextEvents`).
5. **P4 — impersonation** (generalize act-as → any seeded user on dev/demo; then prod audited via the extended `Identity` `{userId, actorUserId, mode}` contract + audit/banner); **P5 — prod hardening**.

**Constraints/gotchas to respect:**

- Prettier + bundle gates are load-bearing (silent prod-deploy skip). Run `npm run format`; chunk the `/admin` bundle.
- `@sitelayer/*` packages resolve to `src` via tsconfig paths in dev (tsx) but `dist` for some test/prod paths — rebuild dist when editing a package consumed via `@sitelayer/...` in non-aliased contexts.
- Migrations are immutable + forward-only (`docker/postgres/init/NNN_*.sql`); `platform_admins` etc. are new numbered migrations.
- Seeder refuses `APP_TIER=prod` — keep it. Scenarios are dev/demo only.
- The demo tier (`demo.preview…`, build `ad8a733`) is live + working — reuse `/api/demo/sign-in-link` as the impersonation/magic-link precedent.

**Related docs:** `docs/DETERMINISTIC_WORKFLOWS.md` (reducer rules), `CLAUDE.md` (architecture, routing topology, local/preview role testing), `docs/DEMO_ENVIRONMENT.md`, memory `sitelayer-demo-tier`.

---

## 11. Appendix — P0 turnkey artifacts

### 11a. Scenario-doc contract (Zod sketch — the P0 deliverable)

Lift `scripts/seed-scenario.ts:241 interface ScenarioYaml` into this. Keep field names identical so existing `scenarios/*.yaml` validate unchanged.

```ts
// packages/scenario/src/schema.ts  (sketch)
import { z } from 'zod'
const Ref = z.string().min(1) // stable handle → ref-hashed UUID at apply time
const EventLog = z.array(z.record(z.unknown())) // ordered events → applyEventSequence

const Timeline = <T extends z.ZodTypeAny>(extra: T) => extra
export const ScenarioDoc = z.object({
  company: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,64}$/), name: z.string() }),
  members: z.array(z.object({ clerk_user_id: z.string(), role: z.string() })).optional(),
  customers: z.array(z.object({ ref: Ref, name: z.string() })).optional(),
  workers: z
    .array(z.object({ ref: Ref, name: z.string(), role: z.string().optional(), clerk_user_id: z.string().optional() }))
    .optional(),
  inventory: z.array(z.object({ ref: Ref, code: z.string() /* …rates… */ })).optional(),
  projects: z
    .array(
      z.object({
        ref: Ref,
        name: z.string(),
        customer_ref: Ref.optional(),
        lifecycle_state: z.string().optional(),
        lifecycle_state_version: z.number().int().optional(),
        lifecycle_event_log: EventLog.optional(),
      }),
    )
    .optional(),
  rentals: z
    .array(
      z.object({
        ref: Ref,
        project_ref: Ref,
        inventory_ref: Ref,
        quantity: z.number(),
        billing_event_log: EventLog.optional() /* … */,
      }),
    )
    .optional(),
  estimates: z.array(z.object({ ref: Ref, project_ref: Ref, push_event_log: EventLog.optional() })).optional(),
  // …worker_issues(issue_event_log), damage_charges(settlement_event_log),
  //   rental_requests(approval_event_log), qbo_sync_runs(sync_event_log), boms(approval_event_log),
  //   clock_events(*_offset_minutes), takeoff_measurements, + steve-demo demo sections…
})
export type ScenarioDoc = z.infer<typeof ScenarioDoc>
```

Engine surface: `parseScenario(yaml) → ScenarioDoc`; `planScenario(doc) → ApplyOp[]` (pure, reuses `@sitelayer/workflows` `getWorkflow` + `applyEventSequence` for each `*_event_log`); `applyScenario(client, plan)` (one tx). `seed-scenario.ts` becomes `applyScenario(pool, planScenario(parseScenario(read(file))))`.

### 11b. Each `*_event_log` is a guided walk — what the builder generates

For a rental stuck mid-billing-dispute, the builder offers `nextEvents('generated')` → `[APPROVE]`, click → `nextEvents('approved')` → `[POST_REQUESTED, VOID]`, etc., emitting:

```yaml
rentals:
  - ref: r-dispute
    billing_event_log:
      - { type: APPROVE } # generated → approved
      - { type: POST_REQUESTED } # approved → posting
      - { type: POST_FAILED, error: 'QBO 402' } # posting → failed  (worker-only event, builder flags it)
```

`applyEventSequence` walks these through the **real** reducer, writes the `workflow_event_log` rows, and stamps the entity row at its final snapshot. The builder never offers an illegal event because it reads `nextEvents(currentState)` + `isHumanEvent`.

### 11c. Chaining (the `runFragments` test helper, P0/P1)

```ts
// A fragment is (company-scoped) partial ScenarioDoc producing refs later fragments consume.
const out = await runFragments(
  [
    companyAtEstimating, // → returns { projectRef }
    ({ projectRef }) => rentalMidDispute(projectRef), // builds on the project
    ({ rentalRef }) => damageChargeOpen(rentalRef),
  ],
  { slug: 'test-co' },
)
// Deterministic: pure reducers + ref-hashed ids + offset-based time. Re-run = identical DB state.
```

This is also how the **builder "spin up a demo"** works: compose fragments → `planScenario` → apply to dev/demo → hand back per-role magic-links (`/api/demo/sign-in-link`, generalized to the seeded company) or act-as links on dev.

### 11d. Impersonation contract change (P4)

`apps/api/src/auth.ts`: `Identity` → `{ userId, actorUserId?: string, source, mode?: 'self'|'act_as'|'impersonate' }`.

- Dev/demo `act_as`: `resolveActAsOverride` sets `userId=target, actorUserId=caller, mode='act_as'` (generalize the target from `e2e-<role>` to any seeded user id).
- Prod `impersonate`: `verifyClerkJwt` reads a Clerk `act` claim (OQ2) → `userId=sub, actorUserId=act, mode='impersonate'`. Data scopes by `userId`; **every `audit_events` write stamps `actorUserId`**; the SPA shows a persistent banner whenever `mode!=='self'`.
