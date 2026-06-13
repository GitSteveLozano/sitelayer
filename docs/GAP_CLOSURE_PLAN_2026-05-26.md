# Plan: Close all backend→UI gaps using the v3.3.0 design language

> **⚠️ STALE (2026-05-26; the "v3.3.0 / `docs/handoff/v3.3.0/`" design language no
> longer exists).** The design source of truth is `docs/steve-handoff/`; the
> backend→UI gap-closure it describes was largely executed by the data-truth /
> wiring waves + the R1–R6 legacy-kit retirement. Kept for archaeology.

**As of:** 2026-05-26 · Goal: give every built-but-headless backend capability a front-door screen, reusing Steve's v3.3.0 design system as the guide so almost no new design is required.

## Guiding principle

Steve's handoff already establishes **5 reusable UI archetypes**. Every remaining gap maps to one of them — so "bridging UI" = clone the nearest established screen + wire the backend, not new design. All work reuses `components/m/*` primitives, `styles/tokens.css` (accent `#d9904a`, system font), `components/m-states/*` (offline/error/empty/loading/perm), the **headless-workflow pattern** (render `snapshot.state` + `next_events`; XState only for UI state; 409 → reload), and the handoff copy tone (direct, no marketing).

### The 5 archetypes → canonical Steve-designed screen to mirror

| #   | Archetype                                                           | Mirror screen (template)                                                  | Use for                                                                          |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | **Headless workflow** (snapshot → state + next_events → POST event) | `financial/billing-run-detail.tsx`                                        | damage-charge approve/waive, rental lifecycle, shipment, project-closeout action |
| 2   | **Workflow list** (rows + state pills + filter)                     | `financial/billing-run-list.tsx`                                          | notification queue, payroll-export list                                          |
| 3   | **KPI dashboard** (KPI strip + per-item bars)                       | `mobile/rentals-utilization.tsx` (rent-util)                              | inventory availability / forecast                                                |
| 4   | **Mapping / CRUD table**                                            | `integrations/qbo-mappings.tsx`, `settings/catalog-*`                     | qbo-custom-fields editor, project-assignments matrix                             |
| 5   | **Action / import sheet** (bottom sheet + preview + confirm)        | `mobile/project-new.tsx`, `projects/schedule/create-assignment-sheet.tsx` | takeoff CSV import, payroll-export generate                                      |

> Status of prior work (done, not in this plan): all 61 v3.3.0 screens built; mobile fidelity finished; `prj-create-qb` + `fm-map` closed. This plan is the **backend-coverage** gaps only.

---

## Phase 0 — Plumbing (no new screens, hours of work)

| Task | What                                                                                                                                                       | Mirror                            | Backend                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| 0.1  | Add **Financial hub** nav entry (`/financial`) to `components/nav/nav-items.ts` (WORKFLOW group) so billing/estimate-push/payroll screens are discoverable | existing nav rows                 | none                              |
| 0.2  | Add **Dispatch lanes** nav entry (`/more/dispatch-lanes`)                                                                                                  | existing nav rows                 | none                              |
| 0.3  | **Project-closeout action**: confirm/wire the CLOSEOUT dispatch from the project-detail closeout summary (summary already renders)                         | billing-run-detail event dispatch | `POST /api/projects/:id/closeout` |

## Phase 1 — Workflow controls via the headless pattern (clone archetype 1)

Each is the same shape Steve's billing/payroll screens already prove: render `state` + `next_events`, POST the chosen event, 409→reload. Clone `billing-run-detail.tsx`.

| Task | Screen                                                                    | Workflow / events                                                                    | Backend work                                                            |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1.1  | **Damage-charge settlement** detail w/ Approve / Waive                    | `damage-charge-settlement` (open→billed/waived)                                      | add snapshot+events endpoints if missing (route exists for create/list) |
| 1.2  | **Rental lifecycle** controls (return / invoice / close) on rental detail | `rental` (active→returned→invoiced_pending→closed) — events API exists, UI not wired | wire UI to `POST /api/rentals/:id/events` (no new backend)              |
| 1.3  | **Shipment** controls on `projects/shipment-detail.tsx`                   | `shipment` (draft→…→delivered)                                                       | add `GET /api/shipments/:id` snapshot + `…/events` to match the pattern |

## Phase 2 — Net-new operator screens (clone nearest archetype)

| Task | Screen                                                                                            | Archetype / mirror                                                              | Backend (exists)                                    |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| 2.1  | **Payroll export** — list + "Generate export" sheet (bookkeeper)                                  | list (arch 2, `billing-run-list`) + generate sheet (arch 5)                     | `payroll-exports.ts`                                |
| 2.2  | **Takeoff CSV/bulk import** — import sheet (file → preview → confirm) launched from takeoff-list  | sheet (arch 5) + `st-loading`/`st-error` states; mirror rentals CSV import flow | `takeoff-import.ts`                                 |
| 2.3  | **Inventory availability + forecast** dashboard (tabs/sections on the rentals utilization screen) | KPI dashboard (arch 3, `rent-util`)                                             | `inventory-utilization.ts` (availability, forecast) |
| 2.4  | **QBO sync monitor** — sync status + "Run sync now" on the QBO connection screen                  | extend `integrations/qbo-connection.tsx` (already shows queue health)           | `qbo-sync-run` + `sync` routes                      |

## Phase 3 — Lower-priority admin screens (clone archetype, build when convenient)

| Task | Screen                                                               | Archetype / mirror                       | Backend                  |
| ---- | -------------------------------------------------------------------- | ---------------------------------------- | ------------------------ |
| 3.1  | **Notification queue** view (admin: pending/sent/failed + retry)     | list (arch 2, `billing-run-list`)        | `notifications.ts`       |
| 3.2  | **Project-assignments** matrix (projects × workers, who's allocated) | table (arch 4) / mirror `fm-crew` roster | `project-assignments.ts` |
| 3.3  | **QBO custom-fields** editor (read/define field xref)                | mapping table (arch 4, `qbo-mappings`)   | `qbo-custom-fields.ts`   |

---

## Execution model

- **Parallelizable** — tasks touch disjoint files; dispatch one agent per task (or per phase), as we did for the mobile finish. Only the nav-link tasks touch `nav-items.ts` (do those serially / one owner).
- **Each task is "clone pattern X → wire backend Y"**, not greenfield, so they're small. Relative sizing: Phase 0 = trivial; Phase 1 = small each (pattern clone + a couple endpoints for shipment/damage); Phase 2 = small–medium (2.2 import has the most logic); Phase 3 = small.
- **Verify** each on the local stack with seeded `e2e-fixtures` (the project + rental-billing-run + labor-payroll-run + worker-issue + damage/shipment rows already exist), headless-screenshot per persona, `ci:quality` green, then ship via the established `dev` → PR→`main` (gated droplet deploy) flow.
- **Design pass from Steve: optional, not blocking.** Only Payroll export (2.1) and Takeoff import (2.2) are new archetypal layouts; both have close analogs (financial list / rentals CSV), so they can be built to the design language now and refined if Steve wants. Everything else is a faithful clone of a screen Steve already designed.

## Suggested order

1. **Phase 0** (instant value — unhides the financial hub, finishes closeout).
2. **Phase 1** (completes the workflow story — every workflow becomes fully operable).
3. **Phase 2** (the two real "missing tools": payroll export + takeoff import, plus the two dashboards).
4. **Phase 3** (admin niceties).

Net: ~12 tasks, the large majority pattern-clones. After this, every backend capability has an operating, discoverable, design-consistent screen.
