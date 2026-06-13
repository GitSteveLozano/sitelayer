# Mobile Design Roadmap

> **⚠️ STALE (references a deleted `Design Overview/` source).** The mobile design
> is now realized: Steve's v2 brutalist system in `apps/web/src/.../tokens.css`,
> the legacy `components/mobile` kit retired (R1–R6, deleted), one responsive SPA.
> Design source of truth = `docs/steve-handoff/`. Kept for archaeology.

Implementation plan for the mobile-first design handoff in `Design Overview/`.

**Last updated:** 2026-05-06

This doc is the sequencing source of truth for shipping the design. It assumes the design handoff is fixed and the backend is mostly in place. The bulk of the work is web-side: a new mobile design system, role-aware shell, and screen implementations.

---

## What this is (and isn't)

**Is:** the order I'll build screens in, what each phase reuses vs creates, where the seams sit.

**Isn't:** a re-architecture. The Three-Layer architecture, deterministic workflows, queue model, deploy pipeline, and tier isolation in `CLAUDE.md` all stand. This is a frontend rebuild on top of existing API surfaces.

---

## Current state — what's already done

The design handoff was reviewed against the live repo. Most of the backend is built; the gap is the mobile UI and a small amount of role/assignment plumbing.

### Backend — present

- Resources with full CRUD + workflow handlers in `apps/api/src/routes/`:
  - `daily-logs`, `worker-issues`, `time-review-runs`, `schedules`, `clock`, `labor-entries`, `labor-burden`, `push-subscriptions`, `notification-preferences`, `assemblies`, `bid-accuracy`, `inventory-utilization`, `takeoff-import`, `takeoff-tags`, `takeoff-write`, `dispatch`, `rental-billing-state`, `rental-contracts-crud`, `rental-inventory-crud`, `rental-inventory-csv`, `estimate-pushes`, `qbo-custom-fields`, `qbo-mappings`, `support-packets`
- Schema (45 migrations) covering geofence policy (`029`), clock-event void (`031`), multi-condition takeoff (`033`), blueprint pages + revisions (`034`, `037`), AI insights (`040`–`041`), worker issues (`044`), crew schedule + time scope (`045`)
- Deterministic workflows: rental billing, crew schedule, time review, project closeout (`packages/workflows/`)
- Queue + outbox + sync events (`packages/queue/`)
- Trace propagation, audit log, support debug packets

### Web — present

- React 19 SPA in `apps/web/src/` with React Router and an existing `MobileNav` collapse-on-phone behavior
- shadcn-style primitives in `components/ui/` (`button`, `card`, `dialog`, `input`, `select`, `textarea`, `toast`, `checkbox`, `search-input`)
- XState machines for offline replay, billing review, day confirmed, estimate push, project selection, run-action
- Existing views: `projects`, `project-detail`, `takeoffs`, `schedule`, `clock`, `billing-review`, `inventory`, `rentals`, `estimates`, `integrations`
- Tailwind + HSL CSS variables, but the **palette is currently cool blue/teal** — needs swap to warm sand/orange per `mobile-tokens.css`

### Backend — net-new for this design

- `project_assignments` table — per-project role join (a user can be foreman on one project, worker on another)
- A small endpoint adjustment: scope `worker-issues` and `daily-logs` reads to assignment-aware filters
- Realtime channel for foreman field-event push (currently DB-only — see Cross-cutting § Realtime)

### Web — net-new for this design

- Mobile primitive set: `MTopBar`, `MLargeHead`, `MSectionH`, `MRow`, `MKpi`, `MPill`, `MBanner`, `MBottomTabs`, `MQA`, `MAvatarGroup`, plus AI atoms (`Spark`, `AiStripe`, `AiAgent`, `AiEyebrow`)
- Warm sand palette + dark theme variant (mostly worker, plus capture viewfinders)
- Role-aware app shell (contextual navigation — see Phase 2)
- All persona screens — admin/estimator (~40), foreman (7), worker (6)

---

## Role model (decided)

- **One role per user per company** in `company_memberships.role`. Values: `admin`, `foreman`, `member`, plus legacy `office` aliased to `admin` in code (no enum migration — text column allows it).
- **Per-project assignments** in a new `project_assignments` table. A user can be assigned `foreman` on Hillcrest and `worker` on Aspen Ridge simultaneously.
- **Admin = superset.** Admin always retains the calm dashboard / projects / schedule / time / rentals / settings surfaces.
- **Permission-adaptive shell, admin-first.** The app derives available modes from company role + project assignments. Admins land in the owner/estimator surfaces by default and can enter Foreman or Worker mode when their permissions/assignments allow it.
- **Defaults for new companies:** one admin who does everything. Foreman/worker assignments are additive — a company never _needs_ them.
- **`wk-issue` recipient picker is removed.** Issues route to the project's foreman, falling through to admin(s) when no foreman is assigned.

---

## Phase 0 — Schema + role plumbing

**Goal:** support per-project role assignments and normalize the role enum.

**Schema (new migration `046_project_assignments.sql`):**

```sql
create table if not exists project_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  clerk_user_id text not null,
  role text not null check (role in ('foreman', 'worker')),
  assigned_by text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (project_id, clerk_user_id, role)
);
create index project_assignments_user_active
  on project_assignments(clerk_user_id) where removed_at is null;
create index project_assignments_project_active
  on project_assignments(project_id) where removed_at is null;
```

**API:**

- `GET/POST/DELETE /api/projects/:id/assignments` — admin-only writes
- Extend `/api/bootstrap` to include the caller's active project assignments (drives the contextual shell)
- Helper in `apps/api/src/auth.ts`: `getProjectRole(clerkUserId, projectId)` returning `'admin' | 'foreman' | 'worker' | null`. Admin always wins.

**Code:** alias `office` → `admin` in `auth.ts` role normalization. Existing rows keep their text value; no backfill required.

**Done when:** an admin can assign a foreman to a project via API and `/api/bootstrap` reflects it.

**Size:** ~1 day.

---

## Phase 1 — Design system foundation

**Goal:** the warm-sand palette, the ~12 mobile primitives, and the 5 system states. Everything else builds on this.

**Files:**

- `apps/web/src/styles.css` — replace HSL palette with the tokens from `Design Overview/design_system/source/mobile-tokens.css`. Light = `:root`, dark = `[data-theme="dark"]` on the shell root.
- `apps/web/tailwind.config.ts` — extend colors per the design-system README's Tailwind translation block (sand/card/line/ink/accent + success/danger/warning/info)
- New: `apps/web/src/components/mobile/` directory with one file per primitive:
  - `top-bar.tsx`, `large-head.tsx`, `section-header.tsx`, `row.tsx`, `kpi.tsx`, `pill.tsx`, `banner.tsx`, `bottom-tabs.tsx`, `quick-action.tsx`, `avatar-group.tsx`, `icon-set.tsx`
- New: `apps/web/src/components/ai/` for `spark.tsx`, `ai-stripe.tsx`, `ai-agent.tsx`, `ai-eyebrow.tsx`, `attribution.tsx`
- New: `apps/web/src/components/states/` for the 5 system states (offline, error, empty, loading, perm). Each is a React component that renders the design — see `Design Overview/design_system/screenshots/st-*.png`.

**Reuses:** the existing shadcn `button`, `dialog`, `toast`, `input`, `textarea` — wrapped or restyled to match.

**Done when:** a `/dev/components` route renders every primitive in light + dark, and the 5 system states render full-screen.

**Size:** ~3 days. This unlocks every later phase, so it's worth landing properly.

---

## Phase 2 — Role-aware shell

**Goal:** the app reshapes per role context while keeping admin-first navigation for users who can administer the company.

**Heuristic for `activeContext`:**

1. Company `admin` / legacy `office` users default to `admin` context: Today, Projects, Schedule, Rentals, More.
2. Users with foreman assignments can enter `foreman` mode: Today, Crew, Field, Log, Time.
3. Users with worker assignments can enter `worker` mode: Today, Scope, Hours, Log.
4. Route intent also adapts the mode. Opening Projects/Schedule/Rentals returns to admin; Crew/Field/Brief enters foreman; Scope/Hours/Clock-in/Issue enters worker.
5. The explicit mode switcher appears only when more than one mode is allowed and persists for the current browser session.

**Files:**

- New: `apps/web/src/lib/active-context.ts` — pure function from `(memberships, assignments, geofenceState, recentActivity)` to a context object
- Modify: `apps/web/src/screens/mobile-shell.tsx` — route the three persona tab sets through one mobile shell so admin, foreman, and worker modes do not become parallel app tracks.
- Modify: `apps/web/src/api.ts` — bootstrap response now includes `assignments[]` and `geofenceState`
- New: `apps/web/src/lib/geofence.ts` — wraps `navigator.geolocation` and the existing `029_geofence_policy` server data; emits enter/exit events used by the active-context selector

**Reuses:** `MobileNav`, `BrowserRouter`, the existing `company-switcher.tsx`. Existing routes survive intact under the admin shell.

**Done when:**

- An admin with no assignments stays in the admin shell.
- An admin with a foreman assignment sees the admin shell by default and can enter Foreman mode.
- Navigating to admin-owned sections returns the user to admin mode without exposing worker/foreman tabs there.

**Size:** ~3 days.

---

## Phase 3 — Calm dashboard + projects list (admin)

**Goal:** the first screen an admin sees, plus the projects index.

**Screens:**

- `db-calm-default` — "You're caught up." hero + segmented control (Today / What needs me? / This week / All sites) + stacked site cards (Hillcrest, Aspen Ridge, Greenwillow with hours)
- `db-pm` — variant when something _is_ on fire (AI stripe with "Open project" CTA)
- `prj-list` — search + state-filter pills (Active / Awaiting client / Closeout) + stacked project cards with state pill, address, "Day X of Y", crew count

**Files:**

- New: `apps/web/src/screens/mobile/home.tsx`, `screens/mobile/projects-list.tsx`
- Modify: `apps/web/src/api.ts` — add `getMobileHome()` (aggregates from existing `/api/bootstrap` + today's labor cost rollup)

**Reuses:** existing `/api/projects`, `/api/analytics`, `/api/clock/timeline`. The admin sidebar from the desktop view is kept untouched for desktop; mobile uses the new home.

**Done when:** an admin opening the app on a phone lands on the calm dashboard, can swipe through the segmented filters, and tap a project card to drill in.

**Size:** ~3 days.

---

## Phase 4 — Project detail (the multi-tab workhorse)

**Goal:** `prj-progress` and its sibling state variants (`prj-drafting`, `prj-sent`, `prj-accepted`, `prj-done`, `prj-archive`).

**Screens:** Single mobile project detail with sub-nav: Overview · Estimate · Schedule · Crew · Materials · Budget · Log · Files. Each tab renders a different React component sharing a project context.

**Files:**

- New: `apps/web/src/screens/mobile/project-detail.tsx` (router) + one component per tab in `screens/mobile/project-tabs/`
- Reuses: existing `views/project-detail.tsx` desktop logic — extract shared data hooks into `apps/web/src/hooks/use-project.ts`

**Reuses:**

- All existing project endpoints (`/api/projects/:id`, `/api/projects/:id/summary`, `/api/projects/:id/closeout`)
- `daily-logs` route → Log tab
- `labor-entries` + `labor-burden` → Crew tab
- `material-bills` + `dispatch` → Materials tab
- `estimate-lines` + `bid-accuracy` → Estimate tab
- `audit-events` → activity stream on Overview

**Done when:** an admin can open Hillcrest, see the "Day 8 of 32 / 35% / on track / materials trending +$1.2k" hero, and tap into Crew & hours, Materials & costs, etc.

**Size:** ~4 days (lots of tabs, but all data already exists).

---

## Phase 5 — Takeoff + estimate (mobile)

**Goal:** mobile-friendly takeoff and estimate review.

**Screens:** `prj-blueprint` (canvas + measurement chips on dark), `mb-takeoff`, `mb-estimate` (line items + send).

**Files:**

- New: `apps/web/src/screens/mobile/takeoff.tsx` — wraps the existing canvas logic with mobile gesture handling (pinch zoom, single-finger pan, long-press to drop a polygon vertex)
- Reuses: `apps/web/src/components/takeoff-pan-overlay.tsx`, the existing `views/takeoffs.tsx` rendering pipeline, `packages/domain` polygon math (`normalizePolygonGeometry`, `calculateTakeoffQuantity`)
- Reuses: `/api/projects/:id/takeoff/measurement(s)`, `/api/blueprints/*`

**Done when:** an admin can open a blueprint on a phone, draft a polygon, see live SF in the chip, and save back to the same `takeoff_measurements` table the desktop uses.

**Size:** ~4 days. Mobile gestures on a PDF canvas are the risk.

---

## Phase 6 — Schedule + time review

**Goal:** week schedule + foreman's time approval loop.

**Screens:** `sch-week`, `sch-day`, `sch-create`, `fm-time-review` (foreman approve hours), `t-vs` (live vs budget chart).

**Files:**

- New: `apps/web/src/screens/mobile/schedule.tsx`, `views/foreman/time-review.tsx`, `views/admin/live-vs-budget.tsx`
- Reuses: `time-review-runs` workflow + machine, `crew_schedule_workflow`, `labor-burden` rollup, `labor-reports` for the burndown chart data

**Done when:** a foreman ending their day can approve all their crew's hours via the existing `time_review_runs` deterministic workflow, surfaced through the mobile UI; an admin can see the burndown chart on phone.

**Size:** ~3 days.

---

## Phase 7 — Worker surfaces

**Goal:** the smallest persona, validates the dark theme + glove-friendly density.

**Screens:** `wk-today`, `wk-clockin`, `wk-scope`, `wk-issue`, `wk-hours`, `wk-log`.

**Files:**

- New: `apps/web/src/screens/worker/*.tsx` — one per screen
- New: `apps/web/src/lib/auto-clockin.ts` — geofence-triggered auto clock-in, with a 2-minute "Wrong project? Tap to fix" override window (per the screenshot, not the README)
- Reuses: `clock` route (already supports `/api/clock/in`, `/api/clock/out`), `worker-issues` route, geofence policy, push subscriptions
- Reuses: `daily-log-photo-upload.ts` for `wk-log`

**Visual notes captured from screenshots (not in design-system README):**

- Time format: running uses `4:24` (colon); aggregated/settled uses `8.2h` (decimal). Add a `formatTime(seconds, mode)` helper to `packages/domain`.
- `wk-issue` is a 6-tile grid (Out of materials / Equipment broken / Safety concern / Weather hold / Scope question / Other), not the 4-chip version in the README. Visuals are the source of truth.
- `wk-clockin` shows the worker's own `$28/hr` rate — confirm this is the worker's _self-rate only_ (never any other worker's). Server-side enforcement: worker tier sees `workers.rate` only when `workers.id = self`.

**Done when:** a worker drives into a geofence, gets the "You're clocked in · auto-clocked" screen with map preview, then can flag an issue, log a photo, and check this week's hours.

**Size:** ~4 days. Geofence + auto clock-in is the hardest piece — needs a stable enter/exit signal, and the existing PWA pattern matters.

---

## Phase 8 — Foreman surfaces

**Goal:** the triage layer between worker and admin.

**Screens:** `fm-today` (stacked sites), `fm-brief` (morning brief composer), `fm-crew` (live roster), `fm-field` (event inbox), `fm-blocker-detail`, `fm-log` (daily log builder), `fm-map`, `fm-sched`.

**Files:**

- New: `apps/web/src/screens/foreman/*.tsx`
- Reuses: `worker-issues` (= field events) + `daily-logs` + `time-review-runs` routes; `notifications` for the "From the field · 2 need you" stripe
- Reuses: AI stripe pattern from Phase 1

**New small server work:**

- `POST /api/projects/:id/briefs` — store the morning brief (a row attached to the project); workers' `wk-today` reads from it. Schema-wise this is one new table or it can be modelled as a special kind of `daily_log` (a "plan" instead of "log"). Decision deferred — see open questions.
- `worker-issues` resolution endpoint — if not present, add `PATCH /api/worker-issues/:id` for foreman resolution. Verify before writing.

**Done when:** the foreman can run the full 6:30 AM → 4:00 PM → end-of-day flow on a phone, with workers seeing brief + resolutions push back to their devices.

**Size:** ~5 days.

---

## Phase 9 — Rentals + invoicing (mobile pass)

**Goal:** mobile-ize the existing desktop rental + invoice flows.

**Screens:** `rent-cat`, `rent-dispatch`, `rent-return`, `rent-scan`, `rent-util`, `mb-invoice-quick`.

**Files:**

- New: `apps/web/src/screens/mobileobile/rentals/*.tsx`
- Reuses: existing rental routes (already extensive — `rental-billing-state`, `rental-contracts-crud`, `rental-inventory-crud`, `dispatch`), the deterministic billing workflow

**Done when:** a yard manager on a phone can scan a tag, dispatch equipment to a project, and run the billing workflow for a returned rental, all using the existing workflow plumbing.

**Size:** ~3 days.

---

## Cross-cutting concerns

### Realtime push for field events

Currently `worker_issues` writes are DB-only and the foreman would have to poll. The design (`fm-field` "5 incoming · 2 need you") implies near-realtime arrival. Two options:

- **A:** Server-Sent Events on `/api/projects/:id/events?stream=1` — long-lived GET, foreman keeps it open while on the Field tab. Simple, no new infra.
- **B:** Web push via existing `push_subscriptions` — works when the app is backgrounded.

Recommend **both, layered**: SSE while the app is foregrounded; push notification while backgrounded. Push subs already exist; SSE is ~1 day to add.

Lands during **Phase 8** (when foreman field surfaces ship). Not a blocker for earlier phases.

### Offline replay

The existing `OfflineMutation` queue and LWW conflict resolution (`apps/api/src/lww.ts`, `apps/web/src/machines/offline-replay.ts`) covers the worker's clock-in / issue / log flows. **No new work** — just wire the new mobile screens through the same `replayOfflineMutations` pipeline.

Confirm that `worker_issues` and `daily_logs` writes go through the offline queue before `wk-issue` / `wk-log` ship.

### Time format convention

Add to `packages/domain`:

```ts
export function formatDuration(seconds: number, mode: 'running' | 'settled'): string
// running: 4:24, 4:24:18 if seconds matter
// settled: 8.2h, 32.8 (no unit when in column header)
```

Use throughout. Document in `packages/domain/src/index.ts` so it doesn't drift.

### Theme switching

Worker shell is dark by default. Foreman + admin shells are light by default. Capture viewfinders (`wk-log`) and splash are dark regardless. No user-facing toggle — theme follows the active shell. Implement via `data-theme="dark"` on the shell root, CSS variables driven from `:root` vs `[data-theme="dark"]`.

### Copy register

Direct, no exclamation, no emoji. `tabular-nums` everywhere there's a number. No "Welcome back!" / "Awesome!" / marketing voice. Per design system doc; enforce via PR review, not lint.

### AI surface rules

Already documented in `Design Overview/design_system/README.md`. Reproduce in `apps/web/src/components/ai/README.md` so the rules sit next to the code.

---

## Open questions

1. **Briefs storage shape.** New `briefs` table, or specialized `daily_logs` rows with a `kind = 'plan'` discriminator? Slight lean toward a separate table since briefs have different lifecycle (single source-of-record per project per day, immutable once sent) — but I'll defer to whoever lands Phase 8.
2. **`wk-clockin` rate display.** Confirmed visually that `$28/hr` shows. Confirm the server-side rule: worker tier sees `workers.rate` only for `workers.id = self`. If yes, add an explicit access-control test.
3. **`wk-clockin` 2-min override window.** Visual shows 2 min, README says 60s. Going with 2 min unless told otherwise.
4. **`wk-issue` 6 tiles vs README's 4 chips.** Going with the 6 tiles from the screenshot.
5. **Desktop screens.** Out of scope for this roadmap. When they land, Phase 3 (admin home) and Phase 4 (project detail) will pick up additional desktop layouts; the underlying data hooks are reusable.

---

## Sequencing summary

```
P0 schema/role plumbing              ────░ 1d
P1 design system foundation          ─────░░░ 3d        (unblocks everything)
P2 role-aware shell                  ─────░░░ 3d
P3 calm dashboard + projects list    ─────░░░ 3d
P4 project detail multi-tab          ─────░░░░ 4d
P5 takeoff + estimate (mobile)       ─────░░░░ 4d
P6 schedule + time review            ─────░░░ 3d
P7 worker surfaces                   ─────░░░░ 4d
P8 foreman surfaces                  ─────░░░░░ 5d
P9 rentals + invoicing (mobile)      ─────░░░ 3d
```

Roughly **30 working days end-to-end**, single-engineer pace. P1+P2 land first because every later phase depends on them. P3 is the smallest demoable slice (admin opens app, sees calm dashboard, drills into a project). Worker / foreman / cross-persona land late because they depend on the shell being right.

Stop-and-redirect points: after P1 (does the system feel right?), after P3 (is the calm dashboard the right reduction?), after P7 (is auto-clock-in reliable enough to ship?).
