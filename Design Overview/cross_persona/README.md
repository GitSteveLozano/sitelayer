# Cross-persona flows

How the three personas interact through shared data. Read the per-persona READMEs first; this doc focuses on the **seams** between them.

## The three apps share one backend

There is one Project record, one Time-entry record, one Field-event record, one Daily-log record. Each persona's UI is a different *view* into the same data. No duplication, no separate databases.

```
                    ┌─────────────────────────────┐
                    │      Backend (one source)    │
                    │  projects, time-entries,     │
                    │  field-events, daily-logs,   │
                    │  briefs, estimates, ...      │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────┼─────────────────────┐
              │                    │                     │
        ┌─────▼─────┐        ┌─────▼─────┐        ┌─────▼─────┐
        │ Estimator │        │  Foreman  │        │  Worker   │
        │ (desktop) │        │ (mobile)  │        │ (mobile)  │
        └───────────┘        └───────────┘        └───────────┘
```

Different personas see different fields, get different actions, and have different write permissions on the same record.

---

## Loop 1 — Morning brief (estimator → foreman → worker)

The classic top-down flow. Scope of record flows from sales to floor in 12 hours.

```
   T = previous afternoon
   ────────────────────────────
   ESTIMATOR commits an estimate of record to a project
       (prj-detail Estimate tab → Commit)
              │
              │ writes: Estimate{id, scope[], lines[], target_margin}
              │ → project.state = in-progress
              ▼
   T = next morning, 6:30 AM
   ────────────────────────────
   FOREMAN opens fm-today
       │ reads: today's projects + the estimate of record + any overnight changes
       │ AI assembles a draft brief from the estimate + yesterday's leftover scope
       │ foreman opens fm-brief, edits, sends
       │
       │ writes: Brief{id, project_id, goal, steps[], crew[], materials[]}
       │ → push notification to assigned workers
       ▼
   T = 6:35 AM
   ────────────────────────────
   WORKER opens wk-today
       │ reads: brief.goal → today's job card
       │ reads: brief.steps[] → scope detail (wk-scope)
       │ reads: brief.crew[] → crew on site avatars
       ▼
   Worker drives to site, geofence triggers wk-clockin → time-entry created
```

### Key constraints

- A worker never sees an estimate (dollars). They see scope only.
- A foreman sees scope + budget summary (% used, hours allowed) but not line-item dollars unless they're also the project manager.
- The estimator can override a foreman's brief but rarely does — typically only when scope changes mid-day (CO arrives).

---

## Loop 2 — Field event escalation (worker → foreman → estimator)

Bottom-up flow when something goes wrong on site.

```
   WORKER hits a problem (material short, drawing unclear, hazard)
       │ taps Flag an issue on wk-today
       │ wk-issue: picks category + severity + voice/photo + send
       │
       │ writes: FieldEvent{kind: blocker, severity, project_id, scope_step_id, payload}
       │ → push to foreman
       ▼
   FOREMAN sees a red-stripe row in fm-field
       │ taps row → fm-blocker-detail with full context
       │ picks resolution: Order more / Bring from another site / Use what's on hand / Park
       │
       │ writes: FieldEvent.resolution{by_user, action, message_to_worker, child_event_ids?}
       │ → if action triggers a rental dispatch or material order, those get child events
       │
       ├── (most cases stop here)
       │
       │ if blocker is large enough to affect budget or schedule:
       ▼
   ESTIMATOR sees an entry on prj-detail Log/Activity stream
       │ AI flags significant blockers with cost or time impact
       │ estimator decides: absorb / change order / scope cut
       ▼
   If change order: estimator drafts CO, sends to client portal for sign
       │ on accept, brief regenerates next morning
       │ foreman sees scope update in fm-today
       │ worker sees new scope in wk-today
```

### Severity routing

| Severity | Reaches foreman | Auto-escalates to estimator? |
|---|---|---|
| Question | Yes | No |
| Slowing down | Yes | Only if open >2 hours |
| Stopped (crew idle) | Yes | Yes — immediate banner on `home-dashboard` |

---

## Loop 3 — Time → payroll (worker → foreman → estimator → payroll)

Three-stop pipeline. Each stop adds a different value.

```
   WORKER drives into geofence
       │ wk-clockin: auto-detected entry; worker confirms or overrides
       │
       │ writes: TimeEntry{worker_id, project_id, started_at, source: 'auto-geofence'}
       ▼
   WORKER drives out (or taps Clock out)
       │ writes: TimeEntry.ended_at
       ▼
   T = end of day
   ────────────────────────────
   FOREMAN reviews fm-time-review
       │ AI flags anomalies (overlap, missing meal break, geofence inconsistencies)
       │ foreman approves / adjusts / rejects each entry
       │
       │ writes: TimeEntry.approval{by, status, adjusted_in?, adjusted_out?, notes}
       ▼
   T = next morning
   ────────────────────────────
   ESTIMATOR sees approved hours roll into:
       │ - prj-detail Budget tab (live labor cost vs budget)
       │ - time-queue (final confirm + send to payroll)
       │ - home-dashboard This-week labor-cost KPI
       │
       │ writes: PayrollBatch{...} → QuickBooks Payroll integration
```

### Edit permissions

| Persona | Can create | Can edit | Can approve | Can void |
|---|---|---|---|---|
| Worker | Self only (manual fallback) | Within 5 min of clock-in (override window) | No | No |
| Foreman | Anyone on their crew | Same day, until approval | Yes | Yes (with reason) |
| Estimator | No | Read-only after foreman approval | (already approved) | Yes (admin) |

---

## Loop 4 — Daily log (worker + foreman → estimator)

The end-of-day report that closes the loop.

```
   THROUGHOUT THE DAY
   ────────────────────────────
   WORKER posts photos/notes via wk-log → tagged auto by geofence + active scope
       │ writes: FieldEvent{kind: photo|note, ...}
       │
   FIELD EVENTS pile up: blockers (resolved or not), photos, notes
   TIME ENTRIES pile up: who clocked in/out where
   MATERIAL CHECKOUTS happen: from the rental yard
       ▼
   T = 4:00 PM
   ────────────────────────────
   FOREMAN opens fm-log (daily-log builder)
       │ AI assembles a draft from the day's events
       │ foreman edits the prose, confirms material usage, signs off
       │
       │ writes: DailyLog{project_id, date, summary, photos[], events[], hours_summary, materials[]}
       ▼
   ESTIMATOR sees the log on prj-detail Log tab next morning
       │ if AI flags drift or a notable issue, also surfaces on home-dashboard
       │ estimator may drill in to write a CO or schedule adjustment
```

---

## Loop 5 — Sales loop (estimator ↔ client)

Outside the three personas above; included here because it triggers Loop 1.

```
   ESTIMATOR builds estimate
       │ → sends via signed portal link
       ▼
   CLIENT opens link (mobile-first, no auth — token in URL)
       │ reviews; approves; signs (drawn signature)
       │ → triggers project state change to accepted
       ▼
   ESTIMATOR gets accept notification
       │ assigns foreman + start date
       │ → triggers Loop 1
```

The client never has an account. They live entirely on signed links. Their UI is in `Portal.html` and is intentionally distinct from the operator app — lighter, more retail-feeling, no system chrome.

---

## State propagation summary

Quick reference: which write affects which persona's view.

| Write | Estimator | Foreman | Worker | Client |
|---|---|---|---|---|
| Estimate committed | `prj-detail` updates | `fm-today` shows new project | — | — |
| Brief sent | — | `fm-today` updates | `wk-today` + `wk-scope` update | — |
| Worker clock-in | `home-dashboard` KPI tick | `fm-crew` shows clocked-in | `wk-today` running clock starts | — |
| Issue flagged | (only if escalated) | `fm-field` row appears | (own optimistic banner) | — |
| Blocker resolved | (logged) | `fm-field` row marks resolved | `wk-today` banner | — |
| Hours approved | `time-queue` row appears | (already done) | `wk-hours` row turns green | — |
| Daily log submitted | `prj-detail` Log tab updates | (already done) | — | — |
| CO sent | `prj-detail` updates | (will see in tomorrow's brief if signed) | — | Email + portal link |
| Invoice sent | `prj-detail` updates | — | — | Email + portal link |

---

## Notification rules

Push notifications are minimized — over-notification is the #1 reason field workers turn apps off. The full list:

**Worker pushes** (only):
- Auto clock-in confirmation (one tap to override)
- New brief from foreman (only if it changed since last open)
- Foreman replied to your issue
- Hours approved end-of-day (single batched push, not per entry)
- Hours disputed (immediate)

**Foreman pushes:**
- Stopped-severity field event (immediate)
- Slowing field event open >2 hours
- New project assigned to me
- Worker submitted manual hours correction request
- Daily log auto-prep ready at 3:30 PM

**Estimator pushes:**
- Estimate viewed by client
- Estimate accepted
- Stopped-severity field event with cost/time impact
- Invoice paid
- QuickBooks reconciliation needed
- Anomaly detected by AI on bid accuracy or budget drift

Everything else is in-app only — surfaced on next open, not pushed.

---

## Auth + identity

One user account; persona is determined by **role assignment per-company**, not separate logins. A single person can be a worker on Company A and a foreman on Company B, switching with the company switcher in the user chip. Estimators in small shops are commonly also foremen on smaller jobs — the app supports role-switching without logout.

When acting in a role, the UI is the role's UI. There is no "all roles in one screen" option — that's how owner-operator apps end up bloated.
