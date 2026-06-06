# Feedback → Issue/Kanban Board — Architecture Decision - 2026-06-04

Status: **DECISION (doc only, no implementation yet).** Anchoring doc for the
"capture feedback feeds a Linear/Kanban-like issue + task board" work, sitelayer-first.

> **✅ RESOLVED (2026-06-05): the board substrate IS on `origin/main` (`952fb835`).**
> The two conflicting 2026-06-04 notes below — one claiming it shipped in `main` via
> `d2767daf`, the EXECUTION_PLAN claiming it was "not in `origin/main`, replayed to
> branches" — are both stale provenance. The whole capture-feedback + work-item board
> slice has since landed on `main`; verified files on `origin/main`:
> `apps/web/src/lib/api/issue-board.ts`, `screens/mobile/issue-board.tsx`,
> `apps/api/src/routes/{work-requests,admin-work-requests}.ts`. **Trust the code on
> `main`, not the "what's missing" / commit-provenance notes in this doc.**

> **⚠️ STATUS CORRECTION (2026-06-04, verified against `main`):** §11's build slice is
> mostly **already shipped** — the `move` endpoint, the column-shaped board read, the
> `request_ref` index, the `IssueBoard` port (`apps/web/src/lib/api/issue-board.ts`),
> and the tenant board UI (`screens/mobile/issue-board.tsx`, `/work/board`) all exist
> in `main` (commit `d2767daf`). The architecture decision (C) below stands; the
> "what's missing" framing does not. The genuinely-remaining frontier (operator
> cross-tenant board, multimodal processing, lost-callback reconciler) and the
> lane-disjoint plan live in **`CAPTURE_BOARD_EXECUTION_PLAN_2026-06-04.md`** — drive
> from there, not from §11.

Scope: How captured signals on sitelayer (in-app issues from tenant users, product
feedback from Steve-the-client, operator triage) become visible, triageable work
items on a kanban board — **without** solving the general cross-project
issue-tracking / agent-coordination problem, and **without** mesh owning the data.

Audience decision (operator, 2026-06-04): v1 scope **includes per-tenant in-app
issues** (company-scoped boards), in addition to operator cross-tenant triage and
Steve-as-collaborator. Not operator-only.

---

## 0. TL;DR

- **Decision: C — a self-contained capability behind an interface, with sitelayer as
  the first concrete implementation.** Not a standalone service (A); not a per-site
  re-implemented pattern (B).
- **It is ~80% built already.** `context_work_items` is a complete kanban entity;
  capture→issue creation is live; only the board _view_, one _move_ mutation, a
  column-shaped _read_, and the per-tenant surfacing are missing.
- **The general problem stays deferred.** projectkit's published `CONTRACT` remains
  emit/dispatch-only. The issue store stays sitelayer-local behind a port. The
  "general pattern" gets _extracted later from the proven specific_, never designed
  up front.
- **The boundary test (this feature's version of the One-Line Boundary Test):** you
  can swap the local `IssueBoard` implementation for a standalone service, and swap
  the mesh dispatch URL for any other adapter, **without changing the board UI or the
  capture/dispatch envelope shapes.**

---

## 1. The decision

| Option                                                                | Verdict         | Why                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Standalone issue/tracker service**                               | ❌ Reject (now) | Premature general solve. Multiplies the auth surface — token exchange to re-prove Clerk identity + company role across a trust boundary, cross-origin CORS, re-implementing/replicating Postgres RLS company isolation outside the DB, a second audit chain. No buyer yet. |
| **B. Per-site re-implemented pattern**                                | ❌ Reject (now) | Duplicates a backend that already exists in sitelayer. Lifting an issue read/mutate surface into projectkit's contract _is_ the deferred general problem.                                                                                                                  |
| **C. Self-contained capability behind an interface, sitelayer first** | ✅ **Adopt**    | Reuses the existing `context_work_items` + RLS + role gates. Ships value to tenant users + Steve + operator now. Hides implementation behind one port so standalone-vs-embedded stays an unforced, reversible decision.                                                    |

This matches the operator's stated constraints: _prove the specific, don't solve the
general, keep behind interfaces, self-contained, hide implementation/workflows._

---

## 2. What already exists — do NOT rebuild

Verified by reading the code (paths are in the main sitelayer checkout):

- **The kanban table is already the issue entity.** `context_work_items`
  (`docker/postgres/init/000_baseline.sql:1262`): `id`, `company_id` (RLS spine),
  `title`, `summary`, `severity` (`low|normal|high|urgent`), `route`,
  `entity_type`/`entity_id`, `assignee_user_id`, `created_by_user_id`, `metadata`,
  timestamps, and **`capture_session_id`** as the link-back to the originating
  capture. Kanban state:
  - `status` (11-state CHECK): `new, triaged, agent_running, human_assigned,
review_ready, review_stale, proposal_expired, resolved, reopened, wont_do,
reversed` (enum mirror in `apps/api/src/context-handoff.ts:8`).
  - `lane`: `triage | human | agent | both | done` (`context-handoff.ts:24`) — the
    natural board columns; `status` is the in-column state.
    The operator's own docs already name this "the common Kanban"
    (`OPT_IN_CAPTURE_LADDER_2026-06-04.md:442`,
    `CONTEXT_HANDOFF_CAPTURE_ARCHITECTURE_2026-06-02.md`).
- **The append-only timeline exists.** `context_handoff_events`
  (`000_baseline.sql:1228`) — status changes, dispatch, runner callbacks; the card
  detail/activity feed.
- **Evidence bundles exist.** `support_debug_packets` (`000_baseline.sql:3082`),
  `capture_sessions`/`capture_artifacts` (`120_capture_sessions.sql`).
- **Capture → issue is live.** `POST /api/capture-sessions/:id/finalize` already
  creates one `support_debug_packet` + one `context_work_item` +
  `context_handoff_event(work_item.created)` per finalized feedback episode. The
  IssueReporter (`apps/web/src/portal/IssueReporter.tsx`),
  `AuthenticatedFeedbackDock.tsx`, and `lib/capture-policy.ts` already capture and
  route input.
- **Lifecycle + RBAC API exists.** `apps/api/src/routes/work-requests.ts` —
  create / triage / dispatch / resolve / reopen / reverse, `nextAction()` (`:391`),
  per-role visibility `canReadWorkItem` (`:327`), `LIST_ROLES` / `TRIAGE_ROLES`.
  Web client lib `apps/web/src/lib/api/work-requests.ts`; status pills
  `apps/web/src/components/work-requests/status.tsx`; detail/timeline
  `WorkRequestTimeline.tsx` / `WorkRequestContextPreview.tsx`.
- **A working drag-drop kanban UI exists — but bound to the WRONG store.** Console
  `BoardTab.tsx` + `boardTabMachine.ts` (console-ui repo) is columns + optimistic
  drag → `POST /orchestrate/tasks/{id}/transition`, but over **mesh `tasks.state`**.
  **Reuse the component/machine _pattern_, never the binding.** Pointing sitelayer's
  board at mesh tasks would invert the seam (mesh is the execution-record subscriber,
  not the issue owner).

**Net genuinely missing:** a board _view_ over `context_work_items`; one generic
_move_ endpoint (status/lane/assignee with optimistic version); a _column-shaped
list_ read (grouped by lane+status); a `request_ref` idempotency index; and the
per-tenant surfacing of the board. That's the whole slice.

---

## 3. In-flight work this MUST coordinate with (not redo)

Two active sitelayer worktrees are building the **emit/dispatch seam** that this
board consumes. Do not rebuild it; depend on it.

- **`sitelayer-worktrees/seam-sl-telemetry`** (`agent/claude/seam-sitelayer-telemetry`)
  — adds the same-origin ingest proxy `apps/api/src/routes/signal.ts`
  (`@operator/projectkit` `HttpSink`, validates every `ProjectEventEnvelope`,
  forwards to a subscriber that is _just a URL_; inert when `SIGNAL_SINK_URL` unset;
  HMAC server-side via `SIGNAL_SINK_SECRET`, mirrors the nhl `/api/signal`). Also
  rewrites the beacon + `mesh-observation-client` + `mesh-trace-forward`.
- **`.worktrees/b-sitelayer`** (`agent/claude/b-sitelayer`) — worker product-trace
  **emit** path adopting the projectkit SDK (`mesh-trace-forward.ts`).
- ⚠️ Both branches edit `apps/worker/src/runners/mesh-trace-forward.ts` — a
  coordination point **between those two**, not with this board work.

**Implication for the board:** the `DispatchAdapter` port below is _already being
built_ by these worktrees (projectkit `HttpSink` + `/api/signal` + the worker
forward). The board work consumes that seam (mesh = one swappable URL) and does
**not** touch `mesh-dispatcher.ts` / `context-work-dispatch.ts` emit internals.

---

## 4. The boundary — the interfaces that hide implementation

Four seams. The first is the one the board UI talks to; the rest already exist or are
in-flight and are named here so the board doesn't re-derive them.

### 4.1 `IssueBoard` port (NEW, sitelayer-local) — the one the board UI imports

The board view talks to this port, never to `fetch`, raw SQL, or table names.

```
IssueBoard  (sitelayer-local, over context_work_items):
  list(filter: {company?, status?, lane?, assignee?, scope: 'company'|'cross-tenant'})
                                                  -> WorkItem[]   // board columns
  get(workItemId)                                 -> WorkItem + timeline + evidence refs
  move(workItemId, {status?, lane?, assignee?, expectedVersion}) -> WorkItem  // optimistic 409
  createFromCapture(captureSessionId, {title, summary, severity, route, entity})
                                                  -> WorkItem      // the finalize path
  appendEvent(workItemId, handoffEvent)           -> void          // timeline
```

`move()` is the only net-new backend operation; everything else wraps existing
`work-requests.ts` routes. First impl is a thin adapter over
`apps/web/src/lib/api/work-requests.ts`. Swapping this impl for a standalone service
later requires **zero** UI changes — that is the boundary test.

### 4.2 `DispatchAdapter` port (IN-FLIGHT, do not rebuild)

Wraps outbound dispatch through `@operator/projectkit` so **mesh is one swappable
`HttpSink`/URL**. Built in the two seam worktrees (§3). Dispatch is a **separate**
port from `IssueBoard` — promoting an issue to mesh execution is an action _on_ an
issue, not a property _of_ the board store.

### 4.3 Actor-resolution + ownership-tag seam (CONSOLIDATE)

One function mapping `{Clerk JWT, platform_admin, portal/invite token, dev act-as}`
→ a normalized capture-time actor (`actor_kind` + opaque ref). Today this is
scattered across `apps/api/src/auth.ts`, `admin-auth.ts`,
`portal-capture-sessions.ts`. One place stamps `company_id` — the RLS key locally,
an **opaque ownership tag** on the wire. Keeps RLS-GUC binding (`withCompanyClient`)
on the local side of the seam.

### 4.4 projectkit `CONTRACT` stays emit/dispatch-only (HARD LINE)

`projectkit/CONTRACT.md` (v1.3.0) defines `ProjectEvent`, `CaptureEnvelope`,
`WorkRequest`, `Concern`/`Callback`, `DispatchAdapter`. **Do NOT add an issue
read/mutate surface to it.** That surface staying sitelayer-local _is_ how the
general problem stays deferred. mesh ingests as a tolerant subscriber
(`control-plane/mesh/core/contracts/projectkit/README.md`, mig 325
`contract_version`); identity, roles, RLS, and raw evidence never leave sitelayer —
mesh authenticates by HMAC and receives an opaque `company_id` ownership tag.

---

## 5. Scope: two audiences, one table, RLS-scoped views

The expanded v1 scope (per the 2026-06-04 audience decision) serves **three actor
classes** off the **same `context_work_items` table**, differentiated only by
identity + RLS scope — no second store, no second model.

| Audience                                             | Surface                                                                                         | Identity                                                                                                                                                                                                   | Scope                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tenant users (in-app issues)**                     | Company board inside the tenant app                                                             | Clerk JWT → `company_memberships` role                                                                                                                                                                     | Company-scoped via RLS (`app_current_company_id()` GUC, `company_isolation` policy `000_baseline.sql:10780`). `canReadWorkItem` already restricts `member` to own/assigned items; admin/foreman/office see company-wide. |
| **Operator triage**                                  | Cross-tenant board in `/admin` console (`apps/web/src/routes/admin.tsx`, mounted `App.tsx:373`) | Clerk `sub` ∈ `platform_admins` / `PLATFORM_SUPERADMIN_CLERK_IDS` via `requirePlatformAdmin`                                                                                                               | Cross-tenant (bypasses single-company RLS through the platform-admin path only).                                                                                                                                         |
| **Steve-the-client (collaborator/product feedback)** | Shared collaborator view; submits via capture                                                   | **Prod:** token-bound feedback-invite guest (`portal_guest:<authority>:<actorRef>`, `portal-capture-sessions.ts:42`). **NOT** the dev-only `x-sitelayer-act-as` (null when `tier==='prod'`, `auth.ts:33`). | Single-company, token-scoped.                                                                                                                                                                                            |

Both board surfaces render the **same `IssueBoard` port** with a different `scope`
filter. The per-tenant company board is the larger of the two additions; it requires
no schema change (RLS already company-scopes the table), only a tenant-app route +
the `move` endpoint gated by `TRIAGE_ROLES` + `canReadWorkItem`.

---

## 6. Identity / authz (reuse, don't reinvent)

- **Create:** tenant users (Clerk), Steve (portal/invite guest), operator
  (platform-admin). Only the visitor/Steve paths can be unauthenticated-at-capture,
  and only via a signed token-bound guest identity — never a real user.
- **View / triage / transition:** ride the existing `work-requests.ts` gates —
  `LIST_ROLES`, `canReadWorkItem` (`:327`), `TRIAGE_ROLES` (`:1066,1177,1251,1337`),
  with 403 on cross-scope. Cross-tenant operator triage rides `requirePlatformAdmin`
  (`admin-auth.ts`), Clerk-source-only, unreachable via header/act-as/internal.
- **Tenant isolation:** Postgres RLS `FORCE ROW LEVEL SECURITY` on every
  `company_id` table; `SET LOCAL app_current_company_id` per tx via
  `withCompanyClient` / `withMutationTx`.
- **On the wire to mesh:** only `project_key`, stable refs (`work_item_id` /
  `capture_session_id` as idempotency), `intent`, `title`/`summary`,
  `source_event_ref`, opaque `company_id` ownership tag, `sensitivity`, callback ref.
  Identity (`sub`, roles, raw evidence) stays sitelayer-local.

---

## 7. Data model (no new table)

`context_work_items` **is** the entity. Minimal additions only:

- A generic `move` mutation endpoint (`status`/`lane`/`assignee`) with optimistic
  version (use existing `updated_at` or a `state_version`), the analogue of the
  console's `move_task_status`. Current `work-requests.ts` has create/dispatch/
  resolve but no generic move-card.
- A **column-shaped read** (items grouped/filterable by `lane`+`status`) for the
  board (current GETs are per-item / flat list).
- An **idempotency index** `(company_id, (metadata->>'request_ref'))` so an inbound
  `WorkRequest`/`CaptureEnvelope` dedupes (producer-stable `request_ref` per
  `CONTRACT.md §WorkRequest`).
- A **card → captured-context deep link** surfaced in the UI (the
  `capture_session_id` join already exists; nothing consumes it yet).

Capture→issue stays a **sitelayer concern**: auto-create one issue per _finalized_
feedback episode (not per inbound event); later events append to the timeline keyed
by `capture_session_id`. mesh never performs this transform — it only receives a
_dispatched_ prepared work item via `mutation_outbox(dispatch_mesh_work_request)`
when an operator/flag promotes it, and returns a `Callback` that lands as
`context_handoff_event(agent.*)`.

Storage stays in sitelayer Postgres (company-scoped RLS), **not mesh, not a
standalone store.** Issues are company-scoped customer data sitelayer authors and
triages; mesh-as-subscriber _precludes_ mesh-as-store (a subscriber that owned the
board would re-acquire ownership of the testbed's data — the exact drift the operator
forbids).

---

## 8. UI

- **Tenant company board:** a board route in the tenant app, company-scoped via RLS,
  visible to the roles `canReadWorkItem` already allows. Reuses the existing
  `/work` data (`apps/web/src/screens/mobile/work-requests.tsx` is a status-filtered
  list today — the board is "render `lane` as columns, `status` as card state" over
  the same data).
- **Operator board:** a new `Feedback`/`Triage` tab in the `/admin` console
  (`apps/web/src/routes/admin.tsx`) — same `useLoad<T>` + tabs pattern as
  Companies/Workflows/Scenarios/Demo; cross-tenant.
- **Minimal kanban (v1):** 4 columns mapping the 11 statuses →
  **New** (`new`) · **Triaged** (`triaged`, `human_assigned`) ·
  **In Progress** (`agent_running`, `review_ready`) ·
  **Done** (`resolved`, `wont_do`, `reversed`). Card = title/summary +
  `WorkRequestStatusPill` + deep link to captured context (reuse
  `WorkRequestContextPreview` / `WorkRequestTimeline`). One mutation (move via the
  new endpoint). No drag library required for v1 — column buttons or a status select
  is enough; adopt the console `BoardTab` drag pattern later.
- Both surfaces consume the `IssueBoard` port (§4.1) — never `fetch`/table names —
  so the store stays swappable.

---

## 9. Explicitly DEFERRED (the general problem — not now)

- A universal cross-project / agent-coordination issue tracker.
- An issue read/mutate surface in projectkit's `CONTRACT`.
- The `@sitelayer/capture-client` package extraction (planned in
  `OPT_IN_CAPTURE_LADDER`, not built).
- Boards for the other testbeds (nhl / chess / winwar / sandolab — none have an
  issue store today). Sitelayer is the reference backend; the **pattern is extracted
  from it later**, by promoting the `IssueBoard` port + capture-client, _not_ by
  designing a shared system up front.

---

## 10. Open questions / risks (for the operator)

1. **Per-tenant board placement** in the tenant app (which nav surface, mobile vs
   desktop shell) — needs a product call before the UI slice.
2. **Prod Steve identity** — confirm the feedback-invite guest token shape (extend
   the existing portal share-token authority) before any prod collaborator path.
3. **Cross-tenant operator read path** — confirm the platform-admin board reads
   across companies through `requirePlatformAdmin` (RLS-bypass on that path only),
   not by relaxing the company RLS policy.
4. **Coordination window** — land/observe the two seam worktrees (§3, both touching
   `mesh-trace-forward.ts`) before wiring dispatch promotion from the board, so the
   `DispatchAdapter` is stable.

---

## 11. Build slice (NOT NOW — for when greenlit)

Ordered, lane-disjoint enough for parallel agents:

1. **Backend:** `move` endpoint (optimistic version) + column-shaped list read +
   `request_ref` dedupe index, behind the `IssueBoard` port. (`work-requests.ts`,
   `context-handoff.ts`)
2. **Tenant board UI:** company-scoped board route, 4-column kanban over the port.
3. **Operator board UI:** `/admin` Feedback tab, cross-tenant via `requirePlatformAdmin`.
4. **Card deep-link:** surface the `capture_session_id` → evidence/timeline join.
5. **(After seam worktrees land)** dispatch-promote action via the `DispatchAdapter`.

---

## Source map (verified paths)

- `docker/postgres/init/000_baseline.sql` — `context_work_items` (:1262),
  `context_handoff_events` (:1228), `support_debug_packets` (:3082),
  `company_isolation` RLS (:10780)
- `apps/api/src/context-handoff.ts` — status (:8) / lane (:24) enums
- `apps/api/src/routes/work-requests.ts` — lifecycle + RBAC (`canReadWorkItem` :327,
  `nextAction` :391, `TRIAGE_ROLES`)
- `apps/api/src/routes/capture-sessions.ts` / `portal-capture-sessions.ts:42` — finalize / portal guest
- `apps/api/src/auth.ts` (:4 Identity, :33 act-as) · `admin-auth.ts` (platform-admin)
- `apps/api/src/routes/signal.ts` — IN-FLIGHT `/api/signal` ingest proxy (seam-sl-telemetry)
- `apps/api/src/mesh-dispatcher.ts` · `apps/worker/src/runners/context-work-dispatch.ts` ·
  `apps/worker/src/runners/mesh-trace-forward.ts` — dispatch/emit (in-flight; do not touch from board)
- `apps/web/src/routes/admin.tsx` (mounted `App.tsx:373`) · `apps/web/src/screens/mobile/work-requests.tsx`
- `apps/web/src/lib/api/work-requests.ts` · `apps/web/src/components/work-requests/{status,WorkRequestTimeline,WorkRequestContextPreview}.tsx`
- `apps/web/src/portal/IssueReporter.tsx` · `AuthenticatedFeedbackDock.tsx` · `lib/capture-policy.ts` · `capture-consent-policy.ts`
- `projectkit/CONTRACT.md` (v1.3.0) · `control-plane/mesh/core/contracts/projectkit/README.md` (subscriber mirror)
- Console pattern reference: `console-ui` `BoardTab.tsx` / `boardTabMachine.ts` (bound to mesh tasks — pattern only)
- In-flight worktrees: `sitelayer-worktrees/seam-sl-telemetry`, `.worktrees/b-sitelayer`
