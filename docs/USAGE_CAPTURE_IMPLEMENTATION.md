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
version: the deterministic workflow substrate is moving into code, but
`capture_sessions`, `capture_session_id`, rrweb, and `Record feedback` are still
net-new.

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

## What is net-new in this repo

- `capture_sessions` table plus `capture_session_id` threaded onto outbound
  events + a lightweight `nav` event so a session is a first-class object.
  Likely a small client helper in `apps/web/src/lib/` plus new migrations (next
  sequential prefix - migrations are immutable, add new files). Minimum fields:
  `company_id`, `actor_user_id`, `role`, `started_at`, `ended_at`, `route_start`,
  `device_class`, `platform`, `build_sha`, `mode`, `consent_version`,
  `retention_expires_at`, `redaction_version`.
- `capture_artifacts` table for high-PII refs: audio, transcript, rrweb replay,
  native video, screenshots, uploaded OS recordings, canvas snapshots. Raw bytes
  stay in object storage; the table stores refs, hashes, sizes, mime types,
  retention, and access policy.
- rrweb DOM replay. Today `apps/web/src/portal/IssueReporter.tsx` captures NO
  DOM/rrweb/input by design. Add an opt-in rrweb recorder, gated by consent,
  high-PII (blueprint screens), session-keyed.
- An invite-gated in-app "Record feedback" control (the one-tap recorder) that
  starts mic + rrweb + the event spine under one session id, and on stop runs
  the existing voice-to-log transcription and emits one context_work_item.
- Takeoff-canvas snapshot: the canvas is pixels, not DOM, so rrweb misses it.
  Snapshot takeoff geometry as state alongside the replay (geometry is already
  emitted), or rely on Layer 2 native video for true canvas pixels.
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
5. Stop uploads artifacts, creates a support packet, transcribes, summarizes,
   and creates one context_work_item.
6. Upload failure leaves retry state; Discard deletes local pending artifacts.

Fallback: support manual OS screen-record upload later, but do not make it the
pilot default. It is too much work for the end user and only loosely aligns to
events unless a `capture_session_id` or pairing code is active.

## Build order (Sitelayer side)

1. R0/C0: `capture_sessions`, `capture_session_id`, `nav` events, and product
   trace forwarding. Acceptance: one phone session produces joined events with
   no audio/video/DOM capture.
2. R1/C1: invite-gated web `Record feedback` = mic (existing) + rrweb (net-new)
   + spine + canvas geometry, consent-gated; transcribe via existing
   voice-to-log agent.
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
