# Context Handoff Capture Architecture - 2026-06-02

Status: architecture and ontology pass.

Scope: Sitelayer context handoff, especially the path from a user noticing a
problem in the product to a local work item, evidence bundle, and optional Mesh
runner dispatch. This document intentionally separates the interface language
from the implementation details so future UI, code, and agent briefs do not call
every step "capture."

Related implementation notes:

- `docs/USAGE_CAPTURE_IMPLEMENTATION.md`
- `docs/RUNBOOK_CONTEXT_HANDOFF.md`
- `docs/SUPPORT_DEBUG_PACKETS.md`
- `docs/RUNBOOK_CHAT_DISPATCH.md`
- `control-plane-suite/docs/page-context-dispatch-design.md`
- `control-plane-suite/docs/cross-project-capture-context-handoff-ontology-2026-06-02.md`

## Executive Model

Sitelayer currently has four related but different loops:

1. Work intake loop: a user creates a Sitelayer `context_work_item` from `/work`
   or a contextual action.
2. Feedback episode loop: a user records an opt-in feedback session with audio,
   DOM replay/events, typed app events, optional artifacts, and a finalization
   action. Finalization creates a support packet and work item.
3. Observation trace loop: low-PII product and capture-session events are joined
   by `capture_session_id` and may forward to Mesh product trace for learning or
   conformance. This loop is not itself a task queue.
4. Operator/control-plane loop: browser-bridge, operator page capture, and chat
   dispatch can create or promote Mesh tasks directly. This is a sibling path,
   not the Sitelayer local work-item queue unless it routes back through
   Sitelayer context handoff.

The most specific handoff event in Sitelayer is:

```text
feedback episode finalized
  -> support_debug_packet created
  -> context_work_item created
  -> context_handoff_event(work_item.created) appended
  -> optional artifact analysis
  -> optional mutation_outbox(dispatch_mesh_work_request)
  -> Mesh task
  -> scoped runner callback
  -> context_handoff_event(agent.*) appended
```

The durable join key is `capture_session_id`. It should move with the evidence,
work item, outbox row, Mesh task properties, runner callback, and product trace
events. It is not the user-facing concept; it is the correlation spine.

## Interface Ontology

These are the names to use in product copy, architecture docs, and task briefs
before dropping to implementation tables.

| Term              | Meaning                                                                                                                                                                 | Boundary                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Feedback episode  | A bounded, opt-in user attempt to report a live problem while using Sitelayer. It can include narration, events, replay, screen/state artifacts, and final user intent. | Do not use this for general telemetry or takeoff capture pipelines.                         |
| Observation trace | A low-PII timeline of typed product or session events used to reconstruct what happened.                                                                                | It is evidence and learning input, not a work item by itself.                               |
| Evidence artifact | A file, URI, transcript, replay, canvas geometry snapshot, video frame manifest, or derived analysis attached to a feedback episode.                                    | It is not the queue item and should not own status/lane.                                    |
| Support packet    | A redacted investigation bundle that combines client context and server context for one reported problem.                                                               | It is the diagnostic packet, not the Kanban object.                                         |
| Work item         | The local Sitelayer intake/Kanban unit that owns status, severity, lane, assignment posture, and timeline.                                                              | Reserve "task" for Mesh execution records.                                                  |
| Handoff timeline  | The append-only event stream for a work item: created, status changes, messages, dispatch requests, runner callbacks, proposals, artifacts, and resolution.             | This is local state history, not product telemetry.                                         |
| Dispatch          | The act of routing a prepared work item to an external runner through Mesh.                                                                                             | Dispatch is not the same as creating evidence, appending an event, or forwarding telemetry. |
| Runner            | The concrete external executor that receives the Mesh task and calls back.                                                                                              | Use "agent" only for UI labels or existing event names.                                     |
| Callback          | A scoped, token-protected route for a runner to report proposal/completed/blocked/error state back into Sitelayer.                                                      | It is not a general API token.                                                              |
| Product trace     | Mesh-side telemetry/conformance history for app-emitted events.                                                                                                         | It supports learning and replay, not direct queue ownership.                                |

Recommended naming rule:

- User-facing phrase: "Record feedback" or "Report a problem."
- Interface object: feedback episode.
- Local queue object: work item.
- Execution object: Mesh task.
- Executor: runner.
- Evidence stream: observation trace plus evidence artifacts.
- Correlation id: `capture_session_id`.

## Implementation Ontology

The current implementation maps the interface terms to these concrete pieces.

| Interface term    | Sitelayer implementation                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feedback episode  | `capture_sessions` plus `capture_session_events` and `capture_artifacts`; created by authenticated or portal capture APIs.                                                                 |
| Observation trace | `workflow_event_log`, `capture_session_events`, client `product-trace-beacon`, and the worker `mesh-trace-forward` runner.                                                                 |
| Evidence artifact | `capture_artifacts`; uploaded files, URI-only references, derived transcripts, deterministic analysis events, and video frame manifests.                                                   |
| Support packet    | `support_debug_packets` with redacted `client_context` and enriched server context.                                                                                                        |
| Work item         | `context_work_items`; status/lane/severity/source/metadata plus `capture_session_id`.                                                                                                      |
| Handoff timeline  | `context_handoff_events`; payload version `sitelayer.context_work_dispatch.v1` for dispatch handoffs.                                                                                      |
| Dispatch outbox   | `mutation_outbox` rows with type `dispatch_mesh_work_request` on lane `context_work_dispatch`.                                                                                             |
| Mesh task         | Request built by `apps/worker/src/runners/context-work-dispatch.ts`; properties carry `work_item_id`, `support_packet_id`, `capture_session_id`, callback metadata, and execution context. |
| Runner callback   | `POST /api/work-requests/:id/agent-callback` with a scoped bearer token and schema-validated payload.                                                                                      |
| Artifact analysis | `apps/worker/src/runners/capture-artifact-analysis.ts`; deterministic analysis plus optional local-whisper and frames-only video packaging.                                                |

The Kanban system should be understood as the Sitelayer `context_work_items`
queue. Mesh is the execution tracker for dispatched work, not the first place
Sitelayer should store user-submitted problems.

## Current Capture And Handoff Surfaces

### 1. Manual Work Item Creation

Primary interface:

- `/work` and contextual `WorkRequestAction` controls.
- User writes a title/summary and the browser supplies bounded context.

Implementation path:

```text
WorkRequestAction
  -> POST /api/work-requests
  -> support_debug_packet
  -> context_work_item
  -> context_handoff_event(work_item.created)
```

Dispatch path:

```text
operator clicks Dispatch agent
  -> POST /api/work-requests/:id/dispatch
  -> mutation_outbox(dispatch_mesh_work_request)
  -> context-work-dispatch worker
  -> Mesh task
  -> runner callback
  -> context_handoff_event(agent.*)
```

This is the cleanest context-handoff path when the user already knows the
problem and does not need audio/replay/media evidence.

### 2. Authenticated Feedback Episode

Primary interface:

- Authenticated `Record feedback` dock, currently opt-in by URL/env/localStorage
  switches.
- Records mic audio by default when allowed.
- Optional rrweb DOM replay.
- Registered artifact providers can attach canvas geometry, screen state, or
  other page-specific evidence.

Implementation path:

```text
AuthenticatedFeedbackDock
  -> feedback-capture-controller
  -> POST /api/capture-sessions
  -> append capture_session_events
  -> upload capture_artifacts
  -> POST /api/capture-sessions/:id/finalize
  -> support_debug_packet
  -> context_work_item
  -> context_handoff_event(work_item.created)
```

Dispatch rules:

- Default lane is triage.
- Trusted authenticated users can finalize to `lane='both'` only behind
  `CAPTURE_AUTH_AUTO_DISPATCH=1`.
- The analysis runner can enqueue dispatch only after evidence readiness when
  `CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH=1` and the work item is eligible.

This is the main "someone browsing the project can submit a problem" path.

### 3. Public Portal Feedback Episode

Primary interface:

- Signed estimate/rental portal links with invite-gated `Record feedback`.
- No Clerk user is required; the token-bound portal context supplies identity
  and scope.

Implementation path:

```text
portal IssueReporter
  -> POST /api/portal/.../capture-sessions
  -> append low-PII portal capture_session_events
  -> upload token-bound capture_artifacts
  -> finalize portal capture session
  -> support_debug_packet
  -> context_work_item
  -> context_handoff_event(work_item.created)
```

Dispatch rules:

- Public portal captures are forced to triage.
- They should not directly auto-dispatch runners because the trust boundary is
  weaker and the evidence may need redaction/review.

### 4. External Or Reference Capture

Primary interface:

- Operator or engineer captures evidence outside the browser: meeting transcript,
  desktop recording, native mobile recording, file URI, or analysis folder.
- The evidence is attached through `npm run capture:reference`.

Implementation path:

```text
npm run capture:reference
  -> create manual_upload or desktop capture_session
  -> create URI-only or uploaded capture_artifacts
  -> finalize
  -> support_debug_packet
  -> context_work_item
```

This exists so external evidence still enters the same queue and uses the same
`capture_session_id` instead of becoming an unjoinable local note.

### 5. Artifact Analysis

Primary interface:

- No primary end-user UI yet; this is a worker pipeline that makes captured
  evidence useful to reviewers and runners.

Implementation path:

```text
finalized capture work item
  -> capture-artifact-analysis worker
  -> deterministic text/json/rrweb/canvas analysis
  -> optional local-whisper transcript
  -> optional video frames-only packaging
  -> context_handoff_event(agent.artifact_attached)
  -> metadata.capture_artifact_analysis.status=ready|pending
```

Important boundary:

- Current web capture is mic audio, DOM replay, typed events, and explicit state
  artifacts. Browser APIs are not a reliable mobile screen-video strategy.
- Native ReplayKit and Android MediaProjection are the real mobile screen-video
  path.
- Video analysis currently packages evidence; it does not complete the full
  multimodal review loop by itself.

### 6. Low-PII Product Trace

Primary interface:

- Usually invisible to end users.
- Useful for reconstructing page flow, workflow conformance, and learning.

Implementation path:

```text
workflow_event_log or capture_session_events
  -> mesh-trace-forward worker
  -> Mesh product_trace_events
```

Important boundary:

- A product trace event is not a problem report.
- A trace should join a feedback episode when `capture_session_id` is present.
- Empty `capture_session_id` means telemetry with no explicit feedback session.

### 7. Operator Chat And Control Plane Capture

Primary interface:

- Operator-context chat widget.
- Control Plane page-capture/captures triage.
- Browser-bridge/operator traces.

Implementation boundary:

- Chat dispatch can create a Mesh task and response loop without creating a
  Sitelayer `context_work_item`.
- Control Plane captures can promote/reassign/resolve Mesh tasks directly.
- Browser-bridge/operator capture should carry the same `capture_session_id`
  when it is observing an active Sitelayer feedback episode.

This path is related to context handoff, but it should not be collapsed into the
Sitelayer Kanban ontology. It is the operator-side dispatch surface.

## Dispatch Semantics

Use "dispatch" only when a prepared work item is being routed to Mesh.

A dispatchable Sitelayer handoff has these parts:

- One `context_work_item` as the local queue object.
- One `support_debug_packet` when client/server context exists.
- Zero or more `capture_artifacts`.
- An append-only `context_handoff_events` timeline.
- A `mutation_outbox` row for retryable external delivery.
- A versioned dispatch payload.
- A scoped callback token.
- Mesh task properties that preserve `capture_session_id`.

Dispatch should not mean:

- Starting audio recording.
- Uploading a replay.
- Appending `capture_session_events`.
- Forwarding product trace events.
- Creating a support packet.
- Creating a Mesh task outside Sitelayer's work-item queue.

## Policy Boundaries

The current policy is conservative and mostly right:

- Public portal feedback always enters triage.
- Authenticated feedback starts in triage unless explicitly promoted by trusted
  role and `CAPTURE_AUTH_AUTO_DISPATCH=1`.
- Analysis-ready auto-dispatch is default-off and should stay behind
  `CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH=1`.
- `context_work_dispatch` is a dispatch lane and can be paused independently.
- Backpressure should block new dispatch attempts before runners are flooded.
- The artifact set freezes after finalization so evidence cannot silently change
  after dispatch.
- Raw media stays pointer/file based with retention policy; runner briefs should
  receive references and export commands, not uncontrolled raw blobs.

## Overloaded Uses Of "Capture"

Sitelayer has older "capture" language that is legitimate but should not be
mixed with context handoff:

- Takeoff capture pipelines: blueprint vision, RoomPlan, drone, and
  photogrammetry produce `TakeoffResult` or geometry for estimating. They are
  product-domain capture, not feedback episodes.
- Clock/geolocation/photo capture records field operation facts. These may
  become evidence, but they are not work items unless routed through context
  handoff.
- Sentry/error capture is observability. It can seed a support packet, but it is
  not the Kanban item.

For new architecture and UI work, prefer the more specific noun before using
"capture."

## Gaps And Architecture Decisions

The system is close, but these gaps still matter:

- Real physical device proof: phone/tablet browser smoke plus native
  ReplayKit/MediaProjection planning.
- Real Mesh ingest proof: capture-generated dispatch should be verified against
  live Control Plane/Mesh with `auto_dispatch=false` first, then with the normal
  runner path once the payload is trusted.
- Product trace proof: verify grants, HMAC component config, and the
  `capture_session_id` join through Mesh product trace.
- Review import loop: multimodal reviewer output should attach back to the work
  item's handoff timeline, not stay in an export folder.
- Consent and PII posture: browser replay, audio, canvas geometry, and native
  screen video need a single product-level exposure sheet and retention policy.
- Kanban interface: `/work` currently acts as intake filters/status views. If it
  becomes a true board, columns should map to `context_work_items.status` and
  `lane`, not Mesh task state.
- ADR cleanup: `docs/adr/0001-use-mesh-task-queue-for-agent-workflow.md` should
  be clarified so Sitelayer-local work items are the intake layer and Mesh tasks
  are execution records.

## Recommended Next Slices

1. Vocabulary cleanup: use `Feedback episode`, `Work item`, `Handoff timeline`,
   `Dispatch`, `Mesh task`, and `Runner` consistently in docs and new UI copy.
2. ADR update: add or revise an ADR for "Sitelayer work items are the local
   intake layer; Mesh tasks are external execution."
3. Product surface pass: make `/work` read as a work intake/hand-off surface, not
   a generic issue tracker or Mesh task list.
4. Proof pass: run the existing capture dispatch and trace smokes in safe
   preflight/no-auto modes, then document exactly which live edges are still
   unproven.
5. Native capture track: keep ReplayKit/MediaProjection separate from the web
   feedback controller so the interface concept stays stable while the
   implementation ladder improves.
