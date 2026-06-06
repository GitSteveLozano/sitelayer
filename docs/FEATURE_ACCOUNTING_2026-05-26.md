# SiteLayer — Feature & Git-History Accounting

**As of:** 2026-05-26 · Purpose: account for everything built vs. what Steve actually designed (v3.3.0 handoff).

## Verdict

**Your hypothesis is correct.** Steve designed a **UI handoff for 3 personas (61 screens, v3.3.0)** plus a product roadmap. The shipped system is **much larger than that design** — roughly **2–3× the UI surface** plus an **entire backend/integration platform that has no design at all**. Most of the "beyond-design" work was built by you + Claude/Codex agents in a phased push, not by Steve.

---

## 1. Git history at a glance

- **646 commits**, 2026-04-23 → 2026-05-26 (~1 month).
- **Authorship:**
  | Author | Commits | Share |
  |---|---|---|
  | Taylor (taylorSando / Taylor Sando) | 434 | ~67% |
  | Claude agents | ~108 | ~17% |
  | **Steve9000 (the designer)** | **85** | **~13%** |
  | Codex agents | 6 | ~1% |
  | dependabot | 13 | ~2% |
- **PR namespaces:** `claude/*` (65 merged PRs) + `agent/claude_work/*` (10) dominate — i.e. agent-driven implementation.
- **Commit mix:** 169 `feat`, 62 `fix`, 43 `docs`, 31 `phase`, 28 `followup`, 19 `test`, 18 `ops`.
- **Top feature areas (by commit scope):** web (60), api (25), takeoff (14), deploy/ci (22), rls (4), rentals (4), workflows (3), work-requests (3), qbo (2), observability (2).
- **Build intensity by week:** W18 (Apr 28–May 4) = **243 commits** (the big build), W21 = 149, W19 = 128, W17 = 76.

## 2. The build timeline (what got delivered, in order)

- **Apr 23–27** — Deployment/preview infra; first workflow groundwork.
- **Apr 28** — Deterministic **rental-billing workflow + QBO invoice push**, `@sitelayer/workflows` package, headless billing-review. "Full Steve roadmap UX (closes README gaps)" (#108).
- **~May 1 (243-commit day, all `claude/phase-*` branches)** — the bulk of the product, in phases:
  - **phase-0** web-v2 substrate (tokens, AI primitives, PWA shell)
  - **phase-1** worker + foreman screens; notifications (Web Push / Twilio SMS / email); offline queue + replay; labor burden; daily-log photo upload to Spaces
  - **phase-2** owner calm dashboard, projects list/detail, estimate flow + share sheet, schedule (day/week/create), project setup (geofence editor, auto-clock policy)
  - **phase-3** takeoff overhaul (backend + data + Takeoff hub UI)
  - **phase-4** rentals rebuild (scan dispatch + utilization)
  - **phase-5** **AI Layer** — bid accuracy, takeoff-to-bid agent, voice-to-log, anomalies, "why this"
  - **phase-6** **back-office admin** — catalog admin (customers/workers/service-items/pricing/bonus-rules), financial workflow admin (estimate pushes + billing runs), **QBO connection + entity mapping editor**, inventory admin + rental contracts, bonus simulator, audit log, onboarding wizard
- **May 2–4** — v2 design alignment (token/button spec), parallel-frontend removed (ADR 0003).
- **May 5–25** — backend/infra surge: work-requests/mesh dispatch, control-plane probe, operator-trace telemetry, QBO sync hardening, RLS phases, reversibility/audit-escrow "wedges", uptime/runbooks.
- **May 26** — mobile screens finished to v3.3.0 + the 2 final gaps closed (this session).

---

## 3. What Steve designed vs. what was added beyond

### A. Designed by Steve (v3.3.0 handoff)

The **61-screen, 3-persona UI**: worker (6), foreman (10), estimator/owner mobile + the dashboard/nav/projects/pwa/rentals/schedule/settings/time screens, + 5 system states. This is a **UI surface for the field + core office workflow**. (Fully accounted for in `HANDOFF_SCREEN_ACCOUNTING_2026-05-26.md`.)

### B. Added beyond the design — **UI** (no handoff screen exists)

~80+ screen/component files with no design. Largest clusters:

| Cluster                           | Examples (files)                                                                                                                               | Designed?                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Financial hub**                 | `financial/` — billing-run list/detail, labor-payroll-run list/detail, estimate-push list/detail, hub                                          | 🔴 none                                         |
| **Inventory admin**               | `inventory-admin/` — items, locations, movements, rental-contract, damage-charges, scaffold-catalog, branches, hub                             | 🔴 none                                         |
| **Settings / catalog CRUD**       | `settings/` — catalog hub + customers/divisions/workers/service-items/bonus-rules/pricing, audit-log, dispatch-lanes, bonus-sim, notifications | 🔴 none (only set-home/pricing/team designed)   |
| **Integrations**                  | `integrations/` — hub, qbo-connection, qbo-mappings                                                                                            | 🔴 none                                         |
| **Takeoff tooling**               | `projects/` — 3D scene, page-calibration overlay, revision-compare, preview variants, photo-measure, tag-sheet, site-map, setup                | 🔴 only the canvas (prj-blueprint) was designed |
| **Estimation depth**              | `projects/` — estimate-builder, line-assembly, markup-breakdown, bid-accuracy-card, pricing-profile-picker                                     | 🔴 only the share sheet designed                |
| **Owner analytics**               | `owner/` — bid-accuracy, PM-dashboard subcomponents                                                                                            | 🟡 partial (t-burden/t-vs/t-cross designed)     |
| **Work requests / operator chat** | `mobile/work-requests`, `work-request-detail`                                                                                                  | 🔴 none                                         |
| **Onboarding wizard**             | `onboarding/wizard.tsx` (company/user setup)                                                                                                   | 🔴 none (only the 5 PWA primes designed)        |

> Caveat on counts: the raw file count (~140 tsx) includes tab subcomponents, route wrappers, and a few likely-legacy variants, so "84 undesigned screens" overstates distinct screens — but the **clusters above are real, substantial, and undesigned**.

### C. Added beyond the design — **Backend / platform** (the handoff is UI-only; ~0% of this is designed)

| Area                                                   | What it is                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **15 deterministic workflows** (`packages/workflows/`) | rental-billing, estimate-push, project-closeout, crew-schedule, time-review, labor-payroll, project-lifecycle, field-event, rental, daily-log, notification, shipment, damage-charge-settlement, rental-request-approval, qbo-sync-run, scaffold-ops-approval — pure state machines w/ event logs + optimistic concurrency |
| **~75 API routes** (`apps/api/src/routes/`)            | projects/takeoff/estimate, labor/time/payroll, scheduling, rentals/inventory/billing, QBO, companies/auth, analytics, notifications/push, work-requests, scaffold-ops, audit, sync/outbox, portal                                                                                                                          |
| **Deep QBO integration** (~3k LOC)                     | OAuth + token rotation, entity mappings, custom-fields, Intuit-signed webhooks, sync-run orchestration, circuit breaker, mutation-outbox idempotency, sync-events ledger, `QBO_LIVE_*` flag gating                                                                                                                         |
| **Clerk webhooks**                                     | Svix-signed user/org events → company_memberships                                                                                                                                                                                                                                                                          |
| **Mesh / control-plane**                               | work-request handoff packets, context dispatch to mesh, operator chat widget, control-plane probe + pub/sub                                                                                                                                                                                                                |
| **Observability**                                      | Sentry trace propagation across api/worker/web, request-scoped logging, debug-trace endpoint, operator-trace telemetry                                                                                                                                                                                                     |
| **Blueprint vision (Anthropic)**                       | Claude-Opus PDF→measurement extraction (flag-gated)                                                                                                                                                                                                                                                                        |
| **Data/safety platform**                               | offline-first IndexedDB queue + last-writer-wins, rate limiting, optimistic version guard, service-item↔division catalog enforcement, **RLS multi-tenant isolation + tier-origin tagging**, feature flags, logical backups + off-host copy + monthly restore drills                                                        |

---

## 4. Bottom line

- **Steve's contribution:** the v3.3.0 **design system + 3-persona UI handoff** (61 screens) and a product roadmap. ~13% of commits.
- **Added beyond Steve's design (you + agents, ~87% of commits):**
  - The **back-office / admin / financial / integration UI** (financial hub, inventory admin, catalog CRUD, QBO mapping UI, bonus sim, audit, work-requests) — none designed.
  - The **entire backend platform** — 15 workflows, ~75 routes, QBO connector, mesh dispatch, observability, multi-tenant RLS, offline sync, backups — the handoff has no design for any of it (it's UI-only).
- **So the design represents the field/office _screens_, not the system.** When Steve says it's "not to the designs," that's about UI fidelity on the designed screens — it says nothing about the large designed-elsewhere or never-designed functionality, which is most of what makes SiteLayer a platform.
  </content>
