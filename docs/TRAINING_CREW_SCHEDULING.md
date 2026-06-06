# Pilot Training: Crew Scheduling + Labor Entry

Day-1 walkthrough for the first pilot company. Hand this to the customer
admin before their first scheduled call; it's also the reference for the
agent helping them.

The flow has three roles and one happy path:

```
admin/office → builds week schedule
foreman      → confirms crew + assigns workers on site
worker       → clocks in via geofence; foreman approves time
```

Each role has its own mobile screen. The `<RoleSwitcher />` in dev mode
lets you preview all three with a single Clerk session — see
[`CLAUDE.md` → Local/preview role testing](../CLAUDE.md) for the
header-override mechanics.

## Setup before training

1. The pilot company exists (run `scripts/onboard-company.ts`; smoke-test
   GET `/api/bootstrap` returns the company's seeded
   divisions/service-items/workers).
2. At least one project exists with a customer assigned.
3. At least three workers are seeded in `workers` with current `division_id`.

## 1. Admin/Office — build the week schedule

**Screen:** [`apps/web/src/screens/mobile/schedule.tsx`](../apps/web/src/screens/mobile/schedule.tsx) (mobile) or [`apps/web/src/screens/projects/schedule.tsx`](../apps/web/src/screens/projects/schedule.tsx) (desktop project view).

**Day-1 demo, ~5 min:**

1. From the home dashboard, tap **Schedule** in the bottom tab bar. The
   default mode is **Week** — shows the next 7 days grouped by date,
   with site cards listing crew dot counts.
2. Tap **+** in the top bar → create a new `crew_schedule` row:
   - **Project** (dropdown from `bootstrap.projects`)
   - **Date** (defaults to tomorrow)
   - **Crew lead** (from `bootstrap.workers`, filtered to foreman role)
   - **Start time + duration**
3. After save, the schedule row is `draft`. Tap it again and pick
   **Confirm** to dispatch the `crew_schedule` workflow's `CONFIRM`
   event — state moves `draft → confirmed`. Reducer lives at
   [`packages/workflows/src/crew-schedule.ts`](../packages/workflows/src/crew-schedule.ts);
   API route is [`apps/api/src/routes/schedules.ts`](../apps/api/src/routes/schedules.ts).

**Common questions:**

- _"How do I move a schedule to a different day?"_ — Tap the schedule
  card, edit the date field. No special action; underlying row updates
  in place. Offline LWW: see [Decision 4 in CLAUDE.md](../CLAUDE.md#4-offline-sync-conflict-resolution--last-write-wins--diagnostic-toast-2026-04-24).
- _"What if the foreman is sick?"_ — Reassign `crew_lead_worker_id`
  from the same edit sheet. Reassignment fires
  `notify_foreman_assignment` if the project_lifecycle workflow is
  past `accepted` (see [`apps/api/src/routes/schedules.ts`](../apps/api/src/routes/schedules.ts)).

## 2. Foreman — confirm crew + assign workers

**Screen:** [`apps/web/src/screens/mobile/foreman-crew.tsx`](../apps/web/src/screens/mobile/foreman-crew.tsx)
(also [`apps/web/src/screens/foreman/live-crew.tsx`](../apps/web/src/screens/foreman/live-crew.tsx)
for the desktop live view).

**Day-1 demo, ~3 min:**

1. Login as the foreman (`e2e-foreman` in dev mode). Home dashboard
   shows today's schedule cards.
2. Tap a card → opens the crew composition sheet. Add or remove
   workers from the assigned list. Each assignment writes a
   `crew_schedule_assignments` row.
3. Tap **Confirm crew** at the bottom — locks the assignment.
   Foreman is now visible to workers' clock-in screens as the
   approver for the day.

**Common questions:**

- _"A worker didn't show up — can I swap mid-day?"_ — Yes; remove
  them from the crew sheet. Their open `clock_events` row stays in
  the timeline (no retroactive edit); foreman handles in time review.
- _"How do I flag a site problem?"_ — **Flag a problem** button → opens
  the `field_event` workflow (`open → resolved | escalated | dismissed`).
  Reducer in [`packages/workflows/src/field-event.ts`](../packages/workflows/src/field-event.ts).
  Escalation pages the estimator; dismissal closes silently.

## 3. Worker — geofence clock-in / clock-out

**Screen:** [`apps/web/src/screens/mobile/worker-clockin.tsx`](../apps/web/src/screens/mobile/worker-clockin.tsx)
(confirmation) + [`apps/web/src/screens/worker/clockin-success.tsx`](../apps/web/src/screens/worker/clockin-success.tsx).

**Day-1 demo, ~5 min:**

1. Login as the worker (`e2e-member`). Home screen shows today's
   assigned site card.
2. Walk into the geofence radius (or in dev mode, tap the **Simulate
   on-site** dev affordance). The SPA fires `POST /api/clock/in` with
   the site's project_id; server creates a `clock_events` row with
   `kind='in'` and `lat/lng` for audit.
3. Confirmation screen shows the punched-in time. A 2-minute
   override window lets the worker tap **Wrong site** to undo without
   foreman approval — after that, the foreman has to fix in time review.
4. At end of day, tap **Clock out** on the persistent banner. Fires
   `POST /api/clock/out` and the timeline at
   `GET /api/clock/timeline` reflects total hours.

**Common questions:**

- _"My phone's GPS is off / I'm in a basement"_ — Worker can tap
  **Manual clock-in** which posts the same endpoint without a geofence
  fix. The row is flagged with `manual=true` for foreman review.
- _"I forgot to clock out last night"_ — Foreman edits in time review
  the next day. There's no auto-cap; the row sits open until edited.

## 4. End-of-week — time review + payroll

**Screens:**

- Time review: [`apps/web/src/screens/financial/labor-payroll-run-list.tsx`](../apps/web/src/screens/financial/labor-payroll-run-list.tsx)
  → detail at [`labor-payroll-run-detail.tsx`](../apps/web/src/screens/financial/labor-payroll-run-detail.tsx).
- Labor burden: [`apps/web/src/screens/owner/labor-burden.tsx`](../apps/web/src/screens/owner/labor-burden.tsx).

**Day-1 demo, ~5 min:**

1. Login as office/admin. Tap **Time review** in the financial hub.
   Shows pending `time_review_run` rows — one per week-ending Friday
   that has un-approved `labor_entries`.
2. Tap into the run → reviewable list of `labor_entries` joined to
   their `clock_events`. Edit hours if a worker forgot to clock out.
3. Tap **Approve** → fires `time_review_run` reducer's `APPROVE` event.
   Worker emits `lock_labor_entries` mutation; rows go read-only.
4. Worker then materializes a `labor_payroll_run` (generated → approved
   → posting → posted), driving the QBO TimeActivity push when
   `QBO_LIVE_LABOR_PAYROLL=1`. Until that flag flips, the push is a
   stub — but state transitions land identically so review training
   covers the live behavior.

## What to verify after the customer's first week

- `mutation_outbox` and `sync_events` both drain to zero overnight
  (check via `GET /api/sync/status`).
- No 409s in Sentry for `PATCH /api/takeoff/measurements/:id` (LWW
  conflicts mean two crew leads edited the same site offline; rate
  should stay <1% of total writes).
- `labor_entries` count for the week matches the expected
  worker-count × shift-count.
- Foreman crew composition feels stable — if they're swapping
  workers in/out every hour, the geofence is misaligned, not a UX
  bug. See [`docs/RUNBOOK_NOTIFICATION_BACKLOG.md`](./RUNBOOK_NOTIFICATION_BACKLOG.md)
  for the foreman-reassignment notification rate.

## What this training does NOT cover

- Estimate push to QBO (separate `estimate_push` workflow; pilot can
  use dry-run until QBO sandbox validation is complete — see
  [`CRITICAL_PATH.md`](../CRITICAL_PATH.md)).
- Rental billing and material-bill push (own workflows; not on the
  pilot's day-1 path).
- Blueprint takeoff (sales/estimating role, not field crew).

Those are own training sessions once the crew flow is steady.
