# Sitelayer Ultimate Plan Status - 2026-05-31

Branch reviewed: `dev-np`
HEAD reviewed: `0303a7b` (`dev-np`)
Mode: implementation status after Claude UI/headless sweep plus capture backend pass

## Executive read

Sitelayer has moved from feature-by-feature patching into the actual substrate
the broader plan needs: deterministic workflows, replayable state transitions,
and UI screens increasingly driven by workflow snapshots instead of loose local
component state. The current tree is not pilot-ready, but it is
directionally aligned with the "system that builds and understands the system"
plan.

The important distinction is this:

- The statechart/headless-workflow layer is now becoming real code.
- The end-user capture/session layer is now partially coded, including
  finalization and artifact upload plumbing, but it is not yet verified as an
  end-to-end learning loop.
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

## Current tree shape

The earlier May 30 audit saw a large uncommitted implementation sweep. That
sweep has now landed through `0303a7b`; the remaining local tracked changes in
this file's current pass are scoped to the capture/session backend and docs:

- capture session finalization route and idempotency index;
- storage-backed capture artifact upload/download parser and routes;
- immediate discard/redaction cleanup for stored capture artifact objects;
- scheduled retention-expiry cleanup for stored capture artifact objects;
- deterministic text/json capture artifact analysis that attaches derived review
  events to the finalized context work item;
- local-whisper transcript artifacts that are stored as first-class
  `capture_artifacts` rows with inherited retention/access policy;
- analyzer readiness metadata on finalized context work items, so future
  routing can wait for artifact analysis instead of racing finalization;
- signed public estimate/rental portal capture finalization into triage work
  items, plus public portal upload/finalize client helpers;
- a dependency-injected rrweb replay helper for future recorder UI wiring;
- a backend-injected feedback capture controller that composes session start,
  mic/replay artifact upload, finalization, and discard without touching screens;
- an invite-gated audio-only `Record feedback` control on signed estimate/rental
  portal links;
- token-bound public portal discard routes that mark sessions discarded,
  tombstone artifact rows, and best-effort delete stored artifact objects;
- desktop command-center routes now mount the same `ControlPlaneProbe` context
  bridge as the canonical workspace route, so browser-bridge capture can label
  `/desktop/*` sessions with company/route/project context;
- low-PII `capture_session_events` forwarding into Mesh product trace;
- a sanitized takeoff canvas geometry artifact helper;
- scenario seeding for deterministic capture episodes:
  `scripts/seed-scenario.ts` can now seed `capture_sessions`,
  `capture_session_events`, `capture_artifacts`, `support_debug_packets`,
  `context_work_items`, and `context_handoff_events`; `steve-demo` includes one
  captured AI-takeoff feedback episode that lands as a context-rich work item;
- focused API tests for capture sessions, support packets, and artifact upload;
- `docs/steve-handoff` remains an untracked design/audit corpus.

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

End-user capture is no longer pre-R0/C0 in the current dirty tree. The following
pieces now exist and should be treated as implementation work that needs review,
not as aspirational docs:

- `docker/postgres/init/120_capture_sessions.sql` creates `capture_sessions`,
  `capture_session_events`, `capture_artifacts`, and adds
  `capture_session_id` to support packets, context work items, worker issues,
  workflow events, outbox rows, and sync events.
- `apps/web/src/lib/capture-session.ts` creates the local session id and
  applies `x-sitelayer-capture-session-id` to API calls.
- `apps/web/src/lib/product-trace-beacon.ts` adds `capture_session_id` to
  browser product-trace payloads when a local session is active.
- `apps/api/src/server.ts` reads and validates the capture-session header into
  request context.
- `packages/workflows/src/event-log-insert.ts`,
  `apps/api/src/mutation-tx.ts`, `packages/queue/src/index.ts`, and the
  dedicated estimate/rental pushers carry `capture_session_id` into
  `workflow_event_log`.
- `apps/api/src/routes/support-packets.ts`, `apps/api/src/context-handoff.ts`,
  and `apps/api/src/routes/work-requests.ts` now propagate the session id into
  support/context work.
- `apps/api/src/routes/capture-sessions.ts` now exposes
  `POST /api/capture-sessions/:id/finalize`, which turns one stopped/open
  capture session into one support packet, one context work item, and one
  handoff event. The path is idempotent through
  `docker/postgres/init/129_capture_session_finalize_idempotency.sql`.
- `apps/api/src/routes/capture-sessions.ts` also exposes
  `POST /api/capture-sessions/:id/artifacts/upload`, backed by
  `apps/api/src/capture-artifact-upload.ts` and
  `apps/api/src/storage.ts:buildCaptureArtifactStorageKey`, for audio/video/text
  artifacts stored under the capture-session path with content hash metadata.
  Uploaded artifacts now default their `retention_expires_at` to the parent
  capture session, so raw audio/video uploads enter the retention-GC path.
- Capture artifacts are also reviewable through
  `GET /api/capture-sessions/:id/artifacts/:artifactId/file`, which checks the
  artifact row, guards the storage key by company, and streams bytes or redirects
  to a presigned URL depending on storage config.
- Discard/redaction now tombstones artifact rows and deletes stored artifact
  objects best-effort during the status transition.
- `apps/worker/src/runners/capture-artifact-retention-gc.ts` now sweeps expired
  `capture_artifacts.retention_expires_at` rows, deletes stored objects through
  the shared GC storage client, and tombstones rows.
- `apps/worker/src/runners/capture-artifact-analysis.ts` now reads text/json
  capture artifacts from storage and appends `agent.artifact_attached` events to
  the finalized context work item with a deterministic summary, stats, excerpt,
  and scoped artifact download path. It does not expose raw storage keys.
- `apps/worker/src/runners/capture-artifact-analysis.ts` also has an
  off-by-default local-whisper path for raw audio artifacts
  (`CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=local-whisper`). When enabled, it writes
  the transcript as a normal derived `capture_artifacts(kind='transcript')` row
  with inherited source retention/access policy and links that artifact from the
  analysis event without leaking storage keys. Video analysis remains gated;
  `frames-only` currently records an explicit skipped analysis event rather than
  making model claims.
- The analyzer also refreshes `metadata.capture_artifact_analysis` on the
  finalized work item with eligible/processed/pending counts and mode flags.
  That is the deterministic gate later auto-dispatch should read.
- Public estimate/rental portal links now have token-bound capture start/event,
  artifact upload, and finalize endpoints. They resolve the signed share token
  before writing `capture_sessions`, `capture_artifacts`, or context work, use
  `consent_actor_kind='portal_guest'`, and do not depend on Clerk auth or a
  company header. Public finalization always lands in `triage`.
- The public portal fetch layer now attaches request id, trace headers, and the
  active capture session id while intentionally omitting authenticated company
  and bearer headers. It also has token-bound upload/finalize helpers for
  estimate and rental capture sessions.
- The web capture API helper now has upload/finalize/detail calls, and a
  reusable `AudioCaptureRecorder` centralizes the browser mic lifecycle.
- `apps/web/src/lib/capture-replay-recorder.ts` now provides a small rrweb-
  compatible recorder helper that buffers replay events and uploads `rrweb` JSON
  artifacts. It still needs a real rrweb dependency/call site in product UI.
- `apps/web/src/lib/feedback-capture-controller.ts` now provides the non-UI
  orchestration for `Record feedback`: start session, start mic and optional
  replay, upload audio/replay artifacts, finalize, or discard. Its backend is
  injected, so authenticated, estimate portal, and rental portal flows can share
  it.
- `apps/web/src/portal/IssueReporter.tsx` now wires that controller into signed
  public estimate/rental portals as an invite-gated audio-only recorder. It
  starts a token-bound session, appends start/stop events, uploads one audio
  artifact, can discard the token-bound session server-side, and finalizes one
  triage work item without Clerk auth. It does not capture DOM/rrweb/canvas data
  yet.
- `apps/worker/src/runners/mesh-trace-forward.ts` selects
  `workflow_event_log.capture_session_id`, emits a stable producer `event_ref`,
  and forwards both to Mesh product trace. It now also forwards low-PII
  `capture_session_events` as product trace events, so browser/mobile/public-link
  behavior can feed the learning loop even when no workflow reducer fired.
- `apps/web/src/lib/takeoff/canvas-geometry-artifact.ts` now builds and uploads a
  sanitized takeoff `canvas_geometry` artifact payload that strips storage paths,
  file URLs, data URLs, and photo thumbnails. It is a helper only; no recorder UI
  calls it yet.

What is still missing is the closed user-facing capture loop beyond the first
public-portal audio slice:

- no authenticated desktop/mobile `Record feedback` surface yet;
- no rrweb DOM replay UI wiring yet;
- no browser screen that calls the feedback controller with a real rrweb
  recorder, consent sheet, recording bar, upload retry, and finalize/discard
  states yet;
- no takeoff-canvas geometry/snapshot capture joined to the session by UI yet
  (the sanitized helper exists, but is not wired);
- no video frame manifest or multimodal video analyzer yet;
- no derived-artifact retention policy yet for future video/frame-analysis
  artifact rows (raw artifacts and local-whisper transcripts now use normal
  artifact rows);
- no native Capacitor path with ReplayKit/MediaProjection yet;
- no aggregate smoke proving one real phone/tablet session creates a session
  row, event rows, artifact rows, finalized support packet/context work item,
  Mesh trace event, and reviewable task/evidence.
- the `steve-demo` captured-feedback row is a deterministic fixture with a
  scenario transcript URI and analyzer-style handoff event. It is useful for
  demoing and querying the model, but it does not replace a live recording,
  storage-backed transcript, worker-run analysis, or Mesh ingest smoke.

Domain 1 is also not fully closed. Sitelayer can emit workflow traces and Mesh
can ingest `product_trace_events`. The current Control Plane dirty tree adds the
first `product_trace -> belief_evidence` review route, but it still needs
aggregate validation, migration review, and a live trace-to-review smoke.

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
5. Finish and prove C0/R0 usage capture: session start/stop/finalize API,
   artifact upload, nav/session events, support-packet join, stable Mesh trace
   ingest, and one verified `capture_session_id` manifest.
6. Then finish R1 user feedback capture: real-device smoke for the public portal
   audio slice, authenticated `Record feedback`, rrweb, transcript, support
   packet, and one context work item.

## Where this sits in the ultimate plan

The current repo is strong on representation and weak on closure.

- Representation: increasingly real. Workflows, statecharts, design conformance,
  and replayable transitions exist and are being connected.
- Capture: the user-session object, artifact route, finalization path, and a
  first public-portal audio recorder now exist in code, but authenticated
  surfaces, rrweb/canvas capture, and the end-to-end smoke are missing.
- Learning: partially wired in dirty Control Plane code; not yet proven live.
- Pilot: close enough to justify a stabilization push, not safe enough to treat
  as ready.

The next proof artifact should not be another synthesis doc. It should be one
real vertical slice: a user action creates a workflow event, the event joins a
capture/session id, the trace lands in Mesh, and a resulting context-rich task
or belief evidence row is created.
