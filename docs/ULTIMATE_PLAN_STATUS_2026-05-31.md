# Sitelayer Ultimate Plan Status - 2026-05-31

Branch reviewed: `dev-np`
HEAD reviewed: `6f623f1` (`origin/dev`)
Mode: read-only audit notes over the current dirty worktree

## Executive read

Sitelayer has moved from feature-by-feature patching into the actual substrate
the broader plan needs: deterministic workflows, replayable state transitions,
and UI screens increasingly driven by workflow snapshots instead of loose local
component state. The current dirty tree is not pilot-ready, but it is
directionally aligned with the "system that builds and understands the system"
plan.

The important distinction is this:

- The statechart/headless-workflow layer is now becoming real code.
- The end-user capture/session layer is still mostly documented, not implemented.
- The Mesh/product-trace/belief loop is prepared, but not live end to end.

So the repo is in a useful middle state: strong substrate, weak integration
confidence, and no closed learning loop yet.

## What the Steve handoff corpus is

`docs/steve-handoff` is not just a design dump. It is a generated design and
modeling corpus:

- `steve-desktop.html` and `steve-mobile.html` are the Stitch/design handoff
  surfaces.
- `audit/CONFORMANCE-REPORT.md` audits the live app against the design corpus:
  30 feature groups, 229 screens, 265 findings.
- `audit/STATECHART-ATLAS.md` is the headless pass: 14 domains, pure reducers,
  `state_version`, outbox effects, and UI orchestration via XState/snapshots.
- `audit/BUILD-PLAN.md` turns the atlas into implementation order: foundation,
  low-risk wire-throughs, reducer extensions, new machines, then tests.
- `audit/impl/*.md` are per-domain implementation dossiers for the 14 domains.

This is exactly the kind of artifact the ultimate plan calls for: designed
state, observed/live state, machine model, gaps, and build order in one place.

## Current dirty-tree shape

At the time of this audit, the repo was on `dev-np` at `6f623f1`, matching
`origin/dev`, with a large uncommitted implementation sweep:

- 136 tracked files changed.
- Roughly 8.7k insertions and 2.8k deletions.
- 409 untracked files.
- `docs/steve-handoff` is about 20 MB and includes 234 screenshots.

This should be treated as an integration stack, not a small patch.

## What is genuinely moving forward

The strongest architectural addition is
`apps/api/src/workflow-dispatch.ts`, which codifies the deterministic workflow
route pipeline:

1. load the current row/snapshot;
2. check `state_version`;
3. apply the pure reducer;
4. persist the next state;
5. append `workflow_event_log`;
6. enqueue side effects.

That primitive is the executable version of what the deterministic-workflow docs
previously described in prose. It also provides `toWorkflowSnapshot`, so screens
can render `state`, `state_version`, `context`, and reducer-derived
`next_events`.

The dirty sweep also expands reducer and schema coverage across crew schedule,
daily log, change order, project lifecycle, project closeout, rental billing,
asset deployment, tenant provision, estimate share, and labor payroll. The UI
work is directionally aligned: screens are moving toward rendering workflow
snapshots and `next_events` rather than inventing allowed actions locally.

## What is still not real

End-user capture is still pre-R0/C0. The docs describe the desired capture
spine, but the code does not yet have:

- `capture_sessions`;
- `capture_artifacts`;
- `capture_session_id` threaded through nav/workflow/support events;
- rrweb replay;
- an invite-gated `Record feedback` control;
- native Capacitor capture with ReplayKit/MediaProjection.

The existing repo pieces are reusable: mobile mic recording, camera access,
support packets, context work dispatch, PWA shell, `workflow_event_log`, and the
Mesh trace forwarder. They are not yet joined into a user-session object.

Domain 1 is also not closed. Sitelayer can emit workflow traces and Mesh can
ingest `product_trace_events`, but the live pipe still needs activation and the
return path `product_trace -> belief_evidence` is still missing.

## Pilot-readiness blockers that remain

The current worktree improves many screens, but the founder walkthrough still
has real pilot walls:

- teammate invite is not fully solved unless the backend becomes a real
  email/phone invite and acceptance flow, not just a membership upsert;
- new assignment visibility likely still has the `draft` vs active/confirmed
  mismatch;
- AI auto-takeoff 404 still needs live deployed repro with the exact failing
  URL and build SHA;
- QBO pull/backfill has moved toward partial inline sync, but it is not a
  sandbox-smoked, worker-backed loop;
- roles/custom roles remain larger schema/API work;
- takeoff/canvas affordances and mobile shell issues still need a focused pass.

## Integration risks called out by the audit

Do not merge the dirty tree as one blob without stabilizing these first:

- Worker event-log inserts may still target `ON CONFLICT (entity_id,
  state_version)` even though migration 106 widens the unique key to
  `(entity_id, workflow_name, state_version)`.
- Dedicated crew outbox mutation types can be consumed by the generic queue
  drain unless they are excluded from the generic path.
- Field-event auto-escalation appears to append an event payload without the
  reducer event `type`, which can break replay.
- Some docs claim green tests for narrower slices; those claims should be
  treated as stale until the aggregate dirty tree is validated.

## Recommended stabilization order

1. Freeze the dirty tree and split it into reviewable stacks. Do not keep adding
   broad UI work until the workflow substrate is stabilized.
2. Land the headless foundation first: `workflow-dispatch`, shared event-log
   insert shape, replay tests, and migration compatibility.
3. Prove one vertical workflow end to end. A good slice is daily log, crew
   schedule, or time review: reducer, migration, snapshot/events route, UI
   `next_events`, event log, replay, and one smoke test.
4. Burn down pilot blockers separately: real invite/accept, assignment active
   visibility, QBO sandbox smoke, AI takeoff live repro.
5. Then build C0/R0 usage capture: `capture_sessions`, `capture_session_id`,
   nav events, support-packet join, and one `Record feedback` path.

## Where this sits in the ultimate plan

The current repo is strong on representation and weak on closure.

- Representation: increasingly real. Workflows, statecharts, design conformance,
  and replayable transitions exist and are being connected.
- Capture: partially reusable pieces exist, but the user-session capture object
  does not.
- Learning: not closed. Product traces do not yet move beliefs.
- Pilot: close enough to justify a stabilization push, not safe enough to treat
  as ready.

The next proof artifact should not be another synthesis doc. It should be one
real vertical slice: a user action creates a workflow event, the event joins a
capture/session id, the trace lands in Mesh, and a resulting context-rich task
or belief evidence row is created.
