# Usage Capture - Sitelayer Implementation Notes

Date: 2026-05-31
Branch reviewed: `dev-np`

Architecture lives in the control-plane repo:
`control-plane/docs/audits/usage-capture-architecture-2026-05-31.md`.
This file is the Sitelayer-side slice only: which files exist, what is net-new,
and the order to build it. All paths verified on `dev-np`.

End-user strategy lives in the control-plane repo:
`control-plane/docs/audits/end-user-capture-strategy-2026-05-31.md`.

Current Sitelayer status note:
`docs/ULTIMATE_PLAN_STATUS_2026-05-31.md`. That document reconciles the current
dirty Steve-handoff/headless-workflow sweep with this capture plan. Short
version: the deterministic workflow substrate is moving into code, and C0/R0 is
now partially present in code. `capture_sessions`, `capture_artifacts`, the
local session helper, API header propagation, support/context-work joins,
workflow-event joins, storage-backed artifact upload, finalization, and Mesh
trace-forwarding are present. Uploaded artifacts are review-fetchable through a
company-scoped file route, inherit the capture-session retention window, and
text/json artifacts now get deterministic `agent.artifact_attached` analysis
events, and finalized work items get artifact-analysis readiness metadata so
later routing can wait for processed evidence. Local-whisper audio can now write
a derived transcript artifact row with the source retention/access policy.
Signed public estimate/rental portal links can start token-bound capture
sessions, append low-PII session events, upload token-bound artifacts, show an
invite-gated audio-only `Record feedback` control, and finalize into triage
context work without Clerk. The missing pieces are proof and higher-fidelity
capture/analysis: browser/mobile smoke, rrweb screen wiring, authenticated
surfaces, takeoff-canvas geometry upload during stop/finalize, and video
manifests.

## What already exists in this repo (reuse, do not rebuild)

- Typed event log: `docker/postgres/init/020_workflow_event_log.sql` -
  transitions with `state_version`, `event_type`, `snapshot_after`. Written
  transactionally in `packages/queue/src/index.ts:appendWorkflowEvent`.
- Trace forwarder to Mesh: `apps/worker/src/runners/mesh-trace-forward.ts` -
  code-complete, INERT. Activate with `MESH_TRACE_FORWARD_URL`,
  `MESH_TRACE_HMAC_COMPONENT`, `MESH_TRACE_HMAC_SECRET` (worker env).
- In-app audio recording: `apps/web/src/screens/mobile/worker-issue.tsx:343,361`
  (`MediaRecorder` + `getUserMedia({audio:true})`).
- Camera access proven: `apps/web/src/screens/rentals/barcode-scanner.tsx:78`.
- Voice -> transcript -> structured log: `apps/worker/src/voice-to-log-agent.ts`.
- Client+server context capture with redaction version + request-id graph:
  `apps/api/src/routes/support-packets.ts` (`REDACTION_VERSION` =
  'support-packet-v1'); already creates context_work_items.
- Context-work dispatch to Mesh: `apps/worker/src/runners/context-work-dispatch.ts`
  (env-gated `MESH_WORK_REQUEST_DISPATCH_URL`; sets `project_hint=sitelayer`,
  `source_kind=context_work_item`).
- PWA shell (makes the native wrap cheap): `apps/web/dist/manifest.webmanifest`,
  `apps/web/dist/sw.js`, `apps/web/src/pwa/register.ts`.
- Context handoff event ledger: `docker/postgres/init/088_context_handoff.sql`.

## What is now partially present in the dirty tree

- `capture_sessions`, `capture_session_events`, `capture_artifacts`, and the
  `capture_session_id` columns/indexes live in
  `docker/postgres/init/120_capture_sessions.sql`.
- The web app can hold a local session id in
  `apps/web/src/lib/capture-session.ts`, attach it to API calls, and include it
  in product-trace beacon events.
- The API request context reads `x-sitelayer-capture-session-id`, and support
  packets / context work / work requests can carry it.
- `workflow_event_log` inserts from both API and worker paths now include
  `capture_session_id`.
- The Mesh trace forwarder now includes `capture_session_id` and a stable
  producer `event_ref` when forwarding workflow rows to product trace, and it
  forwards low-PII `capture_session_events` as product trace events too. This
  keeps public-link/mobile/browser behavior from being trapped only in support
  packets.
- The capture API now has an idempotent finalization route that emits one
  support packet, one context work item, and one handoff event for a stopped/open
  session.
- The capture API now has a storage-backed multipart artifact upload route for
  audio/video/text/json artifacts, including byte count, content hash, and
  capture-session storage key. Multipart uploads now default their
  `retention_expires_at` to the parent capture session so raw audio/video cannot
  bypass the retention-GC lane by omission.
- The capture API now has a scoped artifact file route for review/analyzer
  retrieval, reusing the existing storage presign/stream pattern.
- Discard/redaction now tombstones artifact rows and deletes stored artifact
  objects best-effort during the status transition.
- A capture artifact retention-GC worker now sweeps expired stored artifacts
  after `retention_expires_at` and tombstones rows.
- A deterministic capture artifact analysis worker now reads text/json artifacts
  and attaches reviewable summaries/excerpts/stats to the finalized work item as
  `agent.artifact_attached` events.
- After each artifact analysis event, the worker refreshes
  `context_work_items.metadata.capture_artifact_analysis` with
  eligible/processed/pending counts plus audio/video mode flags. That gives
  future auto-dispatch a deterministic readiness gate instead of racing
  finalization.
- The analyzer can transcribe raw audio artifacts through the local
  faster-whisper HTTP server when explicitly enabled with
  `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=local-whisper`; default is off. When
  enabled, it writes a normal `capture_artifacts(kind='transcript')` row for the
  transcript, copies the source retention/access policy, and links that derived
  artifact from the analysis event without exposing storage keys.
- `apps/web/src/lib/takeoff/canvas-geometry-artifact.ts` now builds and uploads a
  sanitized `canvas_geometry` artifact payload for takeoff measurements. It
  strips storage paths, file URLs, data URLs, and photo thumbnails. This is a
  helper only; it is not yet wired into the recorder/finalize UI.
- Capture artifact worker lanes are included in lane-health degradation logic,
  so backlog pressure now applies to capture analysis/retention too.
- Public estimate/rental portal routes now have signed-token capture start,
  event-append, artifact-upload, and finalize endpoints. Public finalization is
  token-bound to `consent_actor_kind='portal_guest'`, writes a synthetic portal
  actor id, and always lands in `triage` so public users cannot directly trigger
  agent dispatch. The public portal fetch layer attaches `x-request-id`, trace
  headers, and active `x-sitelayer-capture-session-id` without auth/company
  headers.
- Web-side capture helpers now include storage-backed artifact upload,
  finalization, detail fetch, and a reusable `AudioCaptureRecorder`.
- Public portal client helpers now include token-bound artifact upload and
  finalize calls for estimate and rental links.
- `apps/web/src/lib/capture-replay-recorder.ts` now provides a dependency-
  injected rrweb-compatible helper that buffers replay events and uploads an
  `rrweb` JSON artifact. It is a helper only; no product UI imports rrweb or
  starts it yet.
- `apps/web/src/lib/feedback-capture-controller.ts` now composes the non-UI
  feedback loop: start a capture session, start mic and optional rrweb replay,
  upload audio/replay artifacts, finalize one work item, or discard local/server
  state. The backend is injected, so the same controller can target
  authenticated routes or signed estimate/rental portal routes.
- `apps/web/src/portal/IssueReporter.tsx` now exposes an invite-gated
  `Record feedback` control on signed estimate and rental portal links. It
  starts a token-bound capture session, records mic audio, appends
  `portal.feedback.recording_started/stopped` events, uploads the audio artifact,
  and finalizes one triage work item through the public portal helpers. This is
  intentionally audio-only for now: `consent_scope.dom_replay=false`.
- Public estimate/rental portal links now also have token-bound discard routes.
  Discard marks the capture session `discarded`, tombstones artifact rows, and
  best-effort deletes stored artifact objects before the UI clears local state.
- `/desktop/*` now mounts `ControlPlaneProbe` directly, matching the canonical
  workspace route. That closes the browser-bridge context hole where desktop
  command-center captures lacked company/route/project labels.
- `scripts/seed-scenario.ts` now accepts an optional `capture_sessions` section.
  A scenario can seed a deterministic capture session, low-PII session events,
  artifact refs, support packet, context work item, and handoff events joined by
  `capture_session_id`. `scenarios/steve-demo.yaml` uses this to include one
  captured AI-takeoff feedback episode. This is fixture proof of the data model,
  not proof that a live browser recording and worker analyzer ran.

These need review as one C0/R0 stack. Do not assume they are live until a smoke
proves one real browser/mobile session produces joined rows across the database,
support packet, context work item, and Mesh trace ingest.

## What is still net-new in this repo

- A verified browser/device session lifecycle smoke: start, emit nav/session
  events, stop, discard, and retention fields. Route-unit coverage exists, but
  the proof still needs a real browser/mobile run.
- A real demo smoke that compares the seeded `capture_sessions` fixture against
  a freshly recorded session from `/demo` or a signed portal link. The seeded
  episode proves the tables and joins can be represented; the live smoke must
  prove permissions, upload, finalization, artifact analysis, and trace
  forwarding.
- Browser feedback artifact capture beyond the signed public portal audio slice.
  Estimate/rental portal audio now calls the storage-backed upload route; the
  authenticated app surfaces, rrweb/canvas capture, retry UX, and device smoke
  are still missing.
- Video frame artifacts. `CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE=frames-only`
  records an explicit skipped analysis event until a frame extractor exists.
- Retention policy for future video/frame-derived artifacts. Raw artifacts and
  local-whisper transcript artifacts are covered by the existing artifact rows and
  GC path; future video-derived outputs need the same treatment.
- rrweb DOM replay UI wiring. Today `apps/web/src/portal/IssueReporter.tsx`
  captures NO DOM/rrweb/input by design. The recorder helper exists, but an
  opt-in UI still needs to import a real rrweb `record` function, gate it by
  consent, and upload replay artifacts under the active capture session.
- The broader invite-gated in-app "Record feedback" surface. Signed public
  estimate/rental links now have an audio-only control; authenticated desktop
  and mobile surfaces still need the same controller wired with the authenticated
  backend, a fuller consent sheet, upload retry state, and server-side discard
  confirmation.
- Takeoff-canvas wiring: the canvas is pixels, not DOM, so rrweb misses it. The
  sanitized geometry artifact builder now exists, but recorder/finalize screens
  still need to call it when a takeoff session is active.
- Capacitor wrap (Layer 2, separate track): wrap the existing PWA, add a
  screen-record plugin (ReplayKit / MediaProjection), set up signing +
  TestFlight / Android internal distribution.

Do not use web `getDisplayMedia` as the mobile strategy. It is not dependable on
iOS Safari or mobile Android browsers. Web capture is mic + DOM replay + typed
events + canvas geometry. Native capture is the screen-video path.

## Consent + PII (load-bearing, per repo rules)

- Blueprints are untrusted PII blobs (root `CLAUDE.md`, blueprint storage
  hygiene): no server-side scan/redact. Any DOM/pixel capture of a takeoff
  screen can contain customer PII -> capture is opt-in and high-PII-tagged.
- Carry a `redaction_version` on every capture artifact (reuse the
  support-packet pattern).
- Raw audio/video stays in Sitelayer storage (Spaces); only low-PII refs +
  the truncated trace cross to Mesh (the existing forwarder already truncates).
- Pilot users opt in explicitly per session. No silent capture.
- During capture, show a persistent recording indicator with Stop and Discard.
  The user must be able to discard before upload.

## End-user capture UX

For pilot users, the app should expose one stable control: `Record feedback`.
Keep it invite-gated until retention and access logs are proven.

Flow:

1. User taps `Record feedback`.
2. Consent sheet states: voice, visible Sitelayer page replay or native screen
   video, project context, retention window, and who can review.
3. Browser/native OS permission prompt appears.
4. Persistent recording bar appears with elapsed time, Stop, and Discard.
5. Stop uploads artifacts, calls the capture-session finalization route,
   transcribes, summarizes, and creates or replays one context_work_item.
6. Upload failure leaves retry state; Discard deletes local pending artifacts.

Fallback: support manual OS screen-record upload later, but do not make it the
pilot default. It is too much work for the end user and only loosely aligns to
events unless a `capture_session_id` or pairing code is active.

## Build order (Sitelayer side)

1. R0/C0: `capture_sessions`, `capture_session_id`, `nav` events, stable
   `event_ref`, and product trace forwarding. Acceptance: one phone session
   produces joined events with no audio/video/DOM capture. This now includes
   public estimate/rental links through token-bound capture start/event/upload/
   finalize routes and Mesh trace forwarding for `capture_session_events`.
2. R1/C1: invite-gated web `Record feedback`. The public portal audio slice now
   exists. Next: real-device smoke, authenticated app surfaces, rrweb (net-new),
   canvas geometry at stop/finalize, and transcription through the existing
   voice-to-log/local-whisper path.
3. R2/C2: on stop, create support_debug_packet + one context_work_item -> Mesh
   via the existing dispatch path (flip `MESH_WORK_REQUEST_DISPATCH_URL` + the
   trace-forward env only after sandbox validation).
4. R3/C3: usage-model report reads observed session paths against designed
   workflow statecharts.
5. R4/C4 (separate track): Capacitor wrap for native pixel video incl. the
   canvas.

The usage-model work (observed vs designed statechart, product_trace -> belief
feeder) is Mesh-side; see the architecture doc and the development-process
roadmap. This repo's job is clean capture + one context-laden task per session.
