# Backend → Screen Coverage — what you built vs. what has a front door

**As of:** 2026-05-26 · Purpose: for everything built in the backend, does a UI screen operate it? Where there's no screen (or no nav link), that's the work-through list.

## Headline

**Almost everything you built has a screen, and most are routed.** The admin/financial/integration/catalog UI is extensive. The real gaps are a **short, specific list** below — split into (A) backend with no screen at all, (B) workflows that are headless/partial, (C) screens that exist but aren't linked in the nav (discoverability), and (D) infra that needs no screen.

> Correction to an earlier auto-analysis: Material Bills and Inventory admin were flagged as "no screen" — that's **wrong**. Material bills render in the project-detail **Materials tab**; inventory admin (items/locations/movements/branches/scaffold/damage) is routed under **`/more/inventory/*`**. Catalog CRUD, QBO connection/mappings, bonus-sim, audit, and the financial workflow screens all exist and are routed.

---

## A. Backend routes with NO screen — build a screen (the core list)

Verified: 0 web files consume these endpoints.

| Backend capability                    | Route                                               | Why it matters                                                                                           | Priority |
| ------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| **Payroll export**                    | `payroll-exports.ts`                                | Bookkeeper can't self-serve generating the payroll file (ADP/Gusto/etc.)                                 | High     |
| **Takeoff CSV/bulk import**           | `takeoff-import.ts`                                 | Estimators must hand-enter large takeoffs; no upload/preview UI                                          | High     |
| **Inventory availability / forecast** | `inventory-utilization.ts` (availability, forecast) | Rental utilization screen exists (`rent-util`), but no availability snapshot / demand forecast dashboard | Medium   |
| **Project assignments**               | `project-assignments.ts`                            | Write-only (driven by scheduling); no matrix/audit view of who's allocated where                         | Low      |
| **QBO custom fields**                 | `qbo-custom-fields.ts`                              | No operator editor; mappings are implicit                                                                | Low      |

## B. Workflows that are headless or partial — need fuller UI

(Full workflow→screen table at bottom.)

| Workflow                     | State today                     | Gap                                                                                                                 |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **qbo-sync-run**             | worker-only                     | No manual trigger / sync-monitor screen (queue health is partially shown in QBO connection)                         |
| **notification**             | delivery engine                 | No admin view of the notification queue/failures (per-user _preferences_ UI does exist)                             |
| **rental** (lifecycle)       | read-only                       | Screens show rental state but transition via legacy CRUD, not the workflow's `…/events` reducer                     |
| **shipment**                 | detail screen exists            | No snapshot/`next_events` pattern — `shipment-detail.tsx` reads state but can't drive transitions w/ version safety |
| **damage-charge-settlement** | create + list                   | No approve/waive UI (`open → billed/waived` not operable from the screen)                                           |
| **project-closeout**         | summary shown in project detail | Closeout _summary_ renders (budget/overview tabs); confirm the CLOSEOUT **action** is dispatchable from UI          |

Workflows that are fully screen-operated (no gap): rental-billing, estimate-push, crew-schedule, time-review, labor-payroll, project-lifecycle, field-event, daily-log, rental-request-approval, scaffold-ops-approval.

## C. Discoverability — screen exists + routed, but no nav link

These work if you reach them, but the nav menu (`nav-items.ts`) doesn't surface them:

| Screen                                                                | Routed at                | Issue                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Financial hub** (billing-runs, estimate-pushes, labor-payroll-runs) | `/financial/*` (App.tsx) | **Not in the nav registry.** The hub links its own children, but nothing links to `/financial`. One-line fix: add a "Financial" entry to `WORKFLOW_NAV`/`WORKSPACE_NAV`. |
| **Dispatch lanes**                                                    | `/more/dispatch-lanes`   | Routed in `more.tsx` but not in the nav registry.                                                                                                                        |

The nav menu currently surfaces: Today, Projects, Schedule, Rentals, Crew, Time · Work queue, Measurements, Estimates, Live crew · Catalog, Integrations, Inventory admin, Bonus simulator, Audit log · Notifications, Settings.

## D. Infra / intentionally headless — no screen needed

RLS + tier isolation, rate limiting, optimistic version guard, service-item↔division catalog enforcement, mutation-outbox + sync-events internals, Clerk + QBO webhooks, control-plane probe / mesh dispatch plumbing, Sentry/observability + debug-trace endpoint, backups + restore-drill, blueprint-vision dispatcher. (Some have _status_ surfacing — e.g. QBO connection shows sync queue health — but they need no operator CRUD screen.)

---

## Full workflow → operating-screen table

| Workflow                 | API route                 | Operating screen                                                  | In handoff?      | Status               |
| ------------------------ | ------------------------- | ----------------------------------------------------------------- | ---------------- | -------------------- |
| rental-billing           | `rental-billing-state.ts` | `financial/billing-run-detail.tsx`                                | no               | ✅                   |
| estimate-push            | `estimate-pushes.ts`      | `financial/estimate-push-detail.tsx` + `mobile/estimate-push.tsx` | no               | ✅                   |
| crew-schedule            | `crew-schedule-events.ts` | `projects/schedule.tsx`                                           | yes (sch-\*)     | ✅                   |
| time-review              | `time-review-runs.ts`     | `mobile/time-review.tsx`                                          | yes (t-foreman)  | ✅                   |
| labor-payroll            | `labor-payroll-runs.ts`   | `financial/labor-payroll-run-detail.tsx`                          | no               | ✅                   |
| project-lifecycle        | `project-lifecycle.ts`    | `mobile/project-detail.tsx`                                       | no               | ✅                   |
| field-event              | `worker-issues.ts`        | `mobile/foreman-blocker-detail.tsx`                               | yes (fm-blocker) | ✅                   |
| daily-log                | `daily-logs.ts`           | `mobile/foreman-log.tsx` / `worker-log.tsx`                       | yes (fm-log)     | ✅                   |
| rental-request-approval  | `rental-requests.ts`      | `rentals/rental-requests-queue.tsx`                               | no               | ✅                   |
| scaffold-ops-approval    | scaffold routes           | `foreman/approval-queue.tsx`                                      | no               | ✅                   |
| project-closeout         | `projects.ts` (closeout)  | project-detail (summary)                                          | no               | 🟡 action wiring     |
| rental                   | `rental-events.ts`        | rentals screens (read-only)                                       | partial          | 🟡 read-only         |
| shipment                 | `shipments.ts`            | `projects/shipment-detail.tsx`                                    | no               | 🟡 no events pattern |
| damage-charge-settlement | `damage-charges`          | `inventory-admin/damage-charges.tsx`                              | no               | 🟡 no approve/waive  |
| notification             | `notifications.ts`        | preferences only                                                  | no               | 🔴 no queue UI       |
| qbo-sync-run             | (worker)                  | —                                                                 | no               | 🔴 headless          |

---

## What to hand Steve

The screens that don't exist / need design are a short list, not a redesign:

1. **Payroll export** trigger screen, **takeoff CSV import** dialog (high value, no UI today).
2. **Approve/waive** UI for damage charges; **rental lifecycle** + **shipment** event controls; **qbo-sync** monitor/trigger; **notification** queue view.
3. **Inventory availability/forecast** dashboards.
4. Nav links for the **Financial hub** + **dispatch lanes** (a code fix, not design).

Everything else built in the backend already has an operating screen.
