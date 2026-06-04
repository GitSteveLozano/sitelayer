# Opt-In Capture Ladder - 2026-06-04

Status: implementation architecture.

Scope: Sitelayer as the reference implementation, with adapters for NHL,
Chess, WinWar, Sandolab, and later product sites. This document assumes the
same `capture_session_id` spine already used by Sitelayer capture sessions,
support packets, context work items, workflow/product traces, and artifact
analysis.

Related docs:

- `docs/STEVE_FEEDBACK_CAPTURE_WORKFLOW.md`
- `docs/CONTEXT_HANDOFF_CAPTURE_ARCHITECTURE_2026-06-02.md`
- `docs/USAGE_CAPTURE_IMPLEMENTATION.md`
- `docs/CAPTURE_PERSONA_ERROR_SCENARIOS_2026-06-04.md`
- `docs/SUPPORT_DEBUG_PACKETS.md`

## Decision

Build the no-plugin path first. A website can do enough for most known
reviewers without a Chrome extension:

1. Low-PII product telemetry and request/error traces.
2. Explicit issue submission with a short event/state prelude.
3. Optional DOM replay.
4. Optional microphone narration.
5. Optional screen video or live screen share through browser screen capture.

The browser screen-share tier is the same underlying model used by web meeting
tools: `navigator.mediaDevices.getDisplayMedia()` gives a user-selected
screen/window/tab `MediaStream`; `MediaRecorder` records it; WebRTC sends it
live. It still requires a user gesture and browser picker every time. We should
lean into that consent boundary instead of trying to work around it.

Do not make normal visitors answer permission prompts. The site must work if
all capture is disabled. Product managers, developers, and trusted pilots can
opt into richer capture progressively.

## User Cohorts

| Cohort                           | Default experience                                                | Capture allowed                                                                           | Prompt policy                                          |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Public/no-friction users         | Site works normally.                                              | At most low-PII telemetry already allowed by policy.                                      | No first-page prompt. No media prompt.                 |
| Pilot users                      | Site works normally, with visible issue entry point when invited. | Typed issue, route/build/request ids, recent low-PII events, sanitized state snapshot.    | Prompt only after `Report issue` or opt-in link.       |
| Product/dev reviewers            | Debug/review mode can show capture controls.                      | Rich event ring, state snapshots, DOM replay, optional mic/screen.                        | Explicit toggles by stream.                            |
| Maximum-permission collaborators | Can work with live assist and longer recordings.                  | Audio, screen video, WebRTC live view, clip manifests, derived transcript/video analysis. | Explicit media start, visible indicator, stop/discard. |
| External coding collaborators    | Can use their own agent/browser tools.                            | Sitelayer work items plus optional browser DevTools/Codex/Claude/Gemini setup.            | Separate from product-user consent.                    |

## Capture Ladder

| Tier | Name                    | What we collect                                                                                                            | User action                                   | Primary use                                     |
| ---- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| L0   | Ambient telemetry       | Route, page view, build id, request ids, low-PII UI events, API errors, performance timing.                                | None, subject to site privacy settings.       | Understand broad failures without friction.     |
| L1   | Issue-only              | Typed issue plus current route, build, request ids, last 2-5 minutes of L0 ring buffer, current sanitized state providers. | Click `Report issue`, type, submit.           | Pilot users and public feedback.                |
| L2   | Rich state/event opt-in | More event classes, XState/engine/state snapshots, workflow transitions, registered artifacts.                             | Opt-in review mode or issue toggle.           | Product/dev debugging.                          |
| L3   | DOM replay and mic      | rrweb DOM replay with masking, optional audio narration, transcript artifact.                                              | Explicit `Record feedback` or stream toggle.  | Reconstruct what the user saw and said.         |
| L4   | Screen video            | Browser-picked tab/window/screen video chunks, optional tab/system audio where supported.                                  | Explicit `Record screen` with browser picker. | Visual proof when DOM replay is insufficient.   |
| L5   | Live assist             | WebRTC live stream plus optional chunk recorder and operator marks.                                                        | Explicit `Share screen live`.                 | Known collaborators who want real-time help.    |
| L6   | Native/mobile capture   | ReplayKit, MediaProjection, desktop helper, or manual upload.                                                              | Native install or OS-level prompt.            | Mobile screen video and desktop-wide workflows. |

L0 must be small and policy-safe. L1 must close the "what were they doing?"
gap quickly. L3-L5 are never silent.

## Consent Scope Contract

Sitelayer stores `consent_scope`, and the authenticated plus portal capture
routes now enforce explicit flat stream/artifact/event-class scopes. Sessions
that only carry the older descriptive `mode`/`route_path` shape remain
backward-compatible; once a session declares streams, artifacts, booleans, or
event classes, the API treats the scope as an allow-list.

```json
{
  "version": "capture-consent-v1",
  "grant_id": "uuid",
  "actor_kind": "public_user|pilot_user|developer|operator|portal_guest",
  "reviewer_ref": "steve",
  "source": "discord_link|review_mode|issue_button|live_assist",
  "ttl_seconds": 7200,
  "streams": {
    "product_events": true,
    "request_ids": true,
    "state_snapshots": true,
    "dom_replay": false,
    "audio": false,
    "screen_video": false,
    "live_webrtc": false,
    "native_video": false
  },
  "artifacts": {
    "text_note": true,
    "state_snapshot": true,
    "rrweb": false,
    "audio": false,
    "transcript": true,
    "video": false,
    "video_clip_manifest": false,
    "canvas_geometry": true
  },
  "redaction_profile": "support-default",
  "retention_days": {
    "raw_media": 7,
    "raw_dom": 14,
    "events": 30,
    "derived_summary": 180
  },
  "submit_policy": "manual_issue|finalize_on_stop|operator_clip|debug_trace_only"
}
```

Server rules:

- Session creation validates `consent_scope.version` before the canonical
  nested contract becomes mandatory.
- Event append rejects event classes not allowed by explicit `event_classes`.
- Artifact upload rejects artifact kinds not allowed by explicit `artifacts`,
  stream flags, or legacy booleans such as `audio`, `dom_replay`, and
  `screen_video`.
- Finalization freezes the artifact set.
- Discard tombstones rows and deletes stored objects best-effort.
- Raw media and raw DOM are RBAC-gated and audited.

The remaining contract gap is standardizing the nested v1 shape across all
producers. Current code uses the flat shape produced by
`apps/web/src/lib/capture-policy.ts` and enforced by
`apps/api/src/capture-consent-policy.ts`.

Implemented route providers:

- Portal estimate: redacted review/signature state and estimate totals.
- Portal rentals: catalog/filter/cart/reservation state.
- Authenticated takeoff: desktop, mobile, and legacy project canvas state via
  `apps/web/src/lib/takeoff/canvas-state-snapshot.ts`. This provider captures
  xstate/session mode, active draft/blueprint/page, viewport/tool, selection
  counts, and measurement summaries; it deliberately omits storage paths, signed
  URLs, thumbnails, and raw media.
- Authenticated estimate-builder: totals, stale/conflict/save state, selected
  scope filter, active pricing profile identity, and line summaries via
  `apps/web/src/lib/estimate-builder-state-snapshot.ts`.

## State Provider Contract

The shared widget should not know each app's internals. Each route registers
sanitized state providers. The issue submitter asks providers for a snapshot at
the moment the user opens or submits the issue, plus optional snapshots at clip
boundaries.

```ts
type CaptureStateProvider = {
  id: string
  tier: 'issue' | 'telemetry' | 'media'
  piiLevel: 'low' | 'internal' | 'private' | 'restricted'
  getSnapshot(input: {
    reason: 'issue_opened' | 'issue_submitted' | 'transition' | 'clip_boundary'
    captureSessionId: string
    consentScope: CaptureConsentScope
  }): Promise<{
    kind: 'state_snapshot'
    schema: string
    payload: unknown
    redactionVersion: string
  } | null>
}
```

Recommended adapters:

- XState adapter: machine id, `state.value`, redacted context summary, last
  events, state version. Do not dump full context by default.
- Engine adapter: engine session id, phase/statechart state, digest, replay
  pointer, selected entity, viewport summary.
- Canvas adapter: sanitized geometry/state. Pixel/canvas screenshots only after
  explicit consent.
- Route adapter: path, query state, selected ids, visible mode, feature flags.
- Probe adapter: call `window.__controlPlaneProbe.capture()` where present.

## Event And Clip Pipeline

Do not build a system that waits for a 10-minute file to upload before we know
what happened. Keep rolling, correlated, small pieces.

Client rings:

- L0 event ring: 2-5 minutes, low PII, JSON only.
- State snapshot ring: current snapshot plus transition snapshots.
- DOM replay ring: 60-120 seconds or a bounded event count when opted in.
- Audio/video chunk manifest: append as chunks arrive.

Media chunking:

- Use `MediaRecorder.start(timeslice)` for screen/audio chunks.
- Default chunk target: 2-5 seconds for live upload, grouped into 30-60 second
  logical clips.
- Call `requestData()` on heartbeat and before stop.
- Upload chunks immediately with `capture_session_id`, sequence, start/end
  times, hash, and stream kind.
- Finalize with a manifest rather than one giant video blob.

Clip manifest:

```json
{
  "kind": "video_clip_manifest",
  "capture_session_id": "uuid",
  "clip_id": "uuid",
  "reason": "issue_submitted|operator_mark|recording_stopped|error_spike",
  "window_ms": { "start": -120000, "end": 15000, "relative_to": "issue_submitted" },
  "chunks": [{ "artifact_id": "uuid", "seq": 41, "start_ms": 123000, "end_ms": 128000 }],
  "events": ["capture_session_events:..."],
  "states": ["capture_artifacts:..."],
  "transcripts": ["capture_artifacts:..."]
}
```

Default issue clipping:

- For L1/L2, attach the event/state prelude immediately at submit.
- For L3/L4, attach the last useful window: normally `t - 120s` to `t + 15s`.
- For live assist, let the operator mark clips while streaming.

## Live Screen Share

Live sharing does not require a browser extension for desktop browsers that
support screen capture.

Flow:

```text
user clicks Share screen live
  -> create or reuse capture_session_id
  -> request getDisplayMedia()
  -> browser shows picker
  -> app adds stream tracks to RTCPeerConnection
  -> signaling service connects operator
  -> recorder writes local/server chunks
  -> operator can mark clips or ask user to submit issue
  -> finalization creates support packet and work item
```

Required infrastructure:

- Signaling route.
- STUN/TURN/ICE configuration.
- Operator viewer with RBAC.
- Recording indicator and stop/discard controls.
- Optional chunk recorder in parallel with the live WebRTC stream.

This is the "Google Meet/Zoom style" path. It is explicit, user-started, and
browser-visible. For mobile screen video, web screen capture is not the durable
strategy; use native ReplayKit/MediaProjection or manual upload as the higher
friction tier.

## Analysis Pipeline

Raw artifacts are evidence. Derived artifacts are what should flow into work
items and agents by default.

Derived artifacts:

- `transcript` from audio chunks.
- `video_clip_manifest` from media chunks and event windows.
- `video_summary` from selected clip manifests.
- `state_timeline` from state snapshots and workflow events.
- `repro_steps` from event timeline plus state transitions.
- `issue_summary` for the local work item.

Processing path:

```text
capture finalized
  -> deterministic artifact analysis
  -> local-whisper or other ASR for audio when enabled
  -> frame/key-moment extraction for video clips
  -> multimodal analysis over bounded clips
  -> context_handoff_event(agent.artifact_attached)
  -> update context_work_items.metadata.capture_artifact_analysis
  -> optional dispatch when lane and readiness rules allow it
```

Policy:

- Do not feed raw full-session video to analysis by default.
- Feed clip manifests and selected chunks.
- Keep analysis jobs idempotent by `capture_session_id` plus artifact ids.
- Derived summaries can live longer than raw media.

## Shared Widget Architecture

Use Sitelayer as the canonical backend and extract the client into a shared web
package once the policy contract lands.

Recommended package shape:

```text
@sitelayer/capture-client
  capture session id store
  consent policy resolver
  event ring
  state provider registry
  artifact upload client
  MediaRecorder wrappers
  WebRTC live-share client

@sitelayer/capture-react
  ReportIssueDock
  CaptureConsentControls
  LiveAssistPanel
```

Adapters:

```ts
installCapture({
  appId: 'nhl',
  endpoint: '/api/capture',
  profile: 'public|pilot|developer|operator',
  stateProviders,
  eventSink,
  artifactSink,
})
```

Embedding options:

- React package for Sitelayer/NHL/Chess where code integration is cheap.
- Plain script loader for smaller pages.
- Iframe dock only if we need strict UI isolation. Parent pages still need a
  `postMessage` provider bridge, because an iframe cannot magically read app
  state without cooperation.
- Per-app `/api/capture` proxy for same-origin requests and secrets, forwarding
  to central Sitelayer/control-plane capture storage.

## Project Adapters

### Sitelayer

Current working pieces:

- `capture_sessions`, `capture_session_events`, `capture_artifacts`.
- Active `capture_session_id` stored client-side and attached to API requests.
- Authenticated feedback dock with typed issue, audio, DOM replay, screen video.
- Portal feedback recorder.
- Shared web capture consent builders for authenticated, portal, text issue, and
  screen recording flows.
- Server-side event-class and artifact-kind consent enforcement for
  authenticated and portal capture routes.
- Trace consent leaf gates split from beacon sending.
- State-provider registry that uploads sanitized `state_snapshot` artifacts.
- Artifact provider registry.
- Canvas geometry provider.
- Friendly capture error copy for permission/cancel/API failures.
- Support packet and context work item finalization.
- Deterministic artifact analyzer, local-whisper option, video frame packaging.

Next Sitelayer changes:

1. Promote the flat policy builders into a fuller `CapturePolicy` /
   `CaptureTier` resolver used by product trace beacon and capability gating,
   not only the capture UI flows.
2. Append low-PII failure events for provider failures and recorder-start
   failures.
3. Generalize existing route artifact providers into the state provider
   contract where appropriate.
4. Add chunked screen recorder and clip manifest support. The current screen
   recorder uploads one video blob; that is fine for the Steve smoke, but not
   for long sessions.
5. Add live WebRTC share as an explicit L5 control.
6. Add bounded video analysis over clip manifests.

### NHL

NHL is the first non-Sitelayer port because it already has:

- A root-mounted invite-only issue reporter.
- Event buffering while active.
- Product telemetry through `trackEvent` and `/api/collect/batch`.
- ProjectSignal same-origin relay.
- XState machines for login, command palette, faceted search, team builder, and
  assistant flows.

Plan:

- Replace or extract the existing issue reporter instead of mounting a second
  overlay.
- Add `capture_session_id` to telemetry properties and eventually schema/index
  it if search/query matters.
- Register state providers for the XState machines and route-local codecs.
- Respect NHL's `ALLOWED_EVENTS`; add only the event names needed by the
  capture ladder.
- Keep artifact upload separate from `/api/signal`, which is event-only.

### Chess

Chess has no human issue reporter yet, but it has strong state seams:

- Router machine.
- UI/query machine.
- Puzzle/session machines.
- ProjectSignal relay.
- `ControlPlaneProbe` with game/puzzle/FEN/move context.

Plan:

- Mount a small issue widget under the app root or inside `AppShell` near
  `ControlPlaneProbe`.
- Do not reuse the name `captureMode`; in Chess that already means
  candidate-move training and is URL-owned by `cap=1`.
- Use XState providers for router/UI/puzzle/session snapshots.
- Keep keyboard focus isolation strict so the widget does not break board and
  puzzle shortcuts.
- Use `/api/signal` for lifecycle events only; blobs need a capture upload path.

### WinWar

WinWar must not get XState or a shadow state machine. The engine is the source
of gameplay truth.

Plan:

- Mount a widget in the UI shell beside the existing probe/boot, not in engine
  semantics.
- Add `capture_session_id` at the telemetry boundary for engine transition
  traces.
- Use `window.__controlPlaneProbe.capture()` for current page summary.
- Use existing session digest, checkpoint, and replay export as support-packet
  inputs when consented.
- Avoid interfering with map pointer capture, pinch zoom, and global keyboard
  shortcuts.
- Use digest/replay references by default; full checkpoints/replays are richer
  and should require a higher tier.

### Sandolab

Sandolab is a set of route-specific interactive pages with ProjectSignal and
route probes.

Plan:

- Mount a shared widget in the root layout after `{children}`.
- Add a capture API route or same-origin proxy; existing `/api/signal` is event
  telemetry, not artifact storage.
- Use `window.__controlPlaneProbe.capture()` and the probe registry as the
  first state-provider layer.
- Add route-specific providers for `8ball`, `debate`, `aquarium`, and other
  high-value pages.
- Default capture off or heavily redacted on admin/debate/ops routes.
- Do not replace the single global control-plane probe; call it.

## Collaborator Operating Model

Give technical collaborators the smallest piece needed for their role.

| Role                   | Give them                                                                                 | Do not require                                       |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Product reviewer       | Sitelayer review link and issue dock.                                                     | Repo checkout, extension, local agent subscription.  |
| Pilot user             | App URL, invite token, optional issue button.                                             | Any permission prompt on first page load.            |
| External developer     | Repo access, local setup docs, Sitelayer work-item queue, optional shared capture widget. | Full Control Plane/browser-bridge access by default. |
| Trusted agent operator | Local work items plus scoped Mesh callback/runner token.                                  | Direct database or unrestricted Mesh admin.          |
| Full operator          | Control Plane and browser-bridge where justified.                                         | Public-user capture controls.                        |

The common "Kanban" should be Sitelayer `context_work_items` for product issues
and evidence-backed feedback. Mesh tasks are execution records after dispatch.
Linear/GitHub Issues can mirror or receive promoted items, but they should not
be the only system of record for runtime feedback.

For external collaborators who keep their own Codex, Claude, or Gemini
subscription:

- They can test public/local routes with their own in-app browser or Playwright.
- They can use Chrome DevTools for agents/MCP for live browser debugging if
  they accept the browser-profile risk.
- They only need Browser Bridge or our full Control Plane if they are acting as
  an operator on our machine/session.

## Official Tool Surfaces Checked

OpenAI:

- Codex in-app browser is for localhost, file-backed previews, and public pages.
- Codex Chrome extension is for signed-in Chrome state.
- Codex Computer Use is for GUI workflows with screen/control permissions.
- Codex can integrate with Linear for issue delegation, and MCP can connect
  local tools.

Anthropic:

- Claude Code is a local/desktop/CLI coding agent for a collaborator with their
  own account.
- Claude Code GitHub Actions can respond to GitHub issue/PR comments and run
  automated workflows.
- Anthropic computer-use API is an automation primitive where the developer
  supplies screenshots, environment, and action loop.

Google/Chrome:

- Chrome DevTools for agents exposes Chrome debugging through MCP/CLI for
  Gemini CLI, Claude Code, Codex, and other tools.
- Auto-connect can attach to an existing Chrome session, but it exposes logged
  in browser content to the agent and requires explicit browser permission.

These are useful for technical collaborator testing. They are not substitutes
for the application capture protocol because they do not produce Sitelayer
`capture_session_id`, consent scope, retention policy, work item, or artifact
analysis by themselves.

## Implementation Sequence

P0 - Sitelayer policy and enforcement:

1. Done: add `apps/web/src/lib/capture-policy.ts`.
2. Done: route authenticated, portal, text issue, and screen recording flows
   through shared consent builders.
3. Done: add server-side consent/artifact enforcement to authenticated and
   portal capture session routes.
4. Done: add tests that forbidden audio uploads and event classes are rejected.
5. Remaining: fold product trace and capability visibility into the same policy
   resolver.

P1 - Sitelayer state and issue timing:

1. Done: add state-provider registry for sanitized `state_snapshot` artifacts.
2. Done: capture snapshots on authenticated text issue submit, authenticated
   recording stop, authenticated screen stop, and portal recording stop.
3. Remaining: capture snapshots at issue open.
4. Remaining: add provider adapters for route/probe/workflow/XState-style
   snapshots.
5. Remaining: include provider status/failures in support packet context.

P2 - chunked media:

1. Replace one-blob screen recording with chunked uploads.
2. Add clip manifest artifacts.
3. Add analyzer support for bounded video clips and transcript alignment.

P3 - live assist:

1. Add explicit `Share screen live` control.
2. Add signaling and operator viewer.
3. Record clip chunks only under the live consent scope.

P4 - shared package and ports:

1. Extract `@sitelayer/capture-client` and React widget.
2. Port NHL first by replacing its existing issue reporter.
3. Port Chess with a state-aware widget.
4. Port WinWar and Sandolab through probe/state adapters.

## Guardrails

- No media prompt on first page load.
- No hidden screen capture.
- No raw app state dumps by default.
- No cross-site iframe magic. Parent apps must register providers.
- No second overlay in apps that already have an issue widget.
- No reintroducing XState to WinWar.
- No route-state naming collision with Chess `captureMode`.
- No raw full-session video sent to analysis when a clip can answer the issue.
- No public portal auto-dispatch.

## Sources Checked

- Browser screen capture consent, user activation, and recording/sharing:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- Chrome screen-sharing controls:
  https://developer.chrome.com/docs/web-platform/screen-sharing-controls
- Browser media recording:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- WebRTC peer connection model:
  https://webrtc.org/getting-started/peer-connections
- Chrome DevTools for agents:
  https://developer.chrome.com/docs/devtools/agents/get-started
- OpenAI Codex manual:
  https://developers.openai.com/codex/codex-manual.md
- Claude Code setup:
  https://docs.anthropic.com/en/docs/claude-code/getting-started
- Claude Code GitHub Actions:
  https://docs.anthropic.com/en/docs/claude-code/github-actions
- Anthropic computer-use tool:
  https://docs.anthropic.com/en/docs/build-with-claude/computer-use
