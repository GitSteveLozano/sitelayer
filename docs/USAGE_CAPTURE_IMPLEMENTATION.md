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
Analysis-ready auto-dispatch payloads now carry the `capture_session_id` through
the outbox, Mesh properties, execution context, context handoff, and
agent-readable brief, including a deterministic `npm run capture:export` handoff
for the receiving agent. Those handoffs now carry a versioned
`sitelayer.context_work_dispatch.v1` payload contract, and inbound agent
callbacks are schema-validated before they can mutate a context work item.
Audio-only finalized sessions no longer stall when audio transcription is
disabled: the analyzer refreshes readiness for finalized work items even when
the current analysis mode has zero eligible artifacts.
URI-only capture artifacts, including scenario/demo transcript references, now
produce `reference-artifact-v1` handoff events and count toward readiness rather
than disappearing because no local storage bytes exist.
Browser-bridge/operator traces now get the same join key: active
`capture_session_id` is emitted through the Sitelayer client trace tap and
included in `ControlPlaneProbe.capture()`.
Trusted authenticated feedback captures can now be promoted server-side to the
agent/both lane behind `CAPTURE_AUTH_AUTO_DISPATCH=1`; public portal captures
remain forced to triage. Finalized capture sessions now have a frozen artifact
set: later authenticated or portal uploads return `409` instead of invalidating
readiness after dispatch. Capture lifecycle transitions also write
low-PII `capture_session_events` rows such as `session.finalized` and
`session.discarded`, so the trace stream can see the session outcome directly.
Mesh trace forwarding now has a Sitelayer-side proof/retry ledger in
`mesh_trace_forward_state`: successful forwards are skipped on later windows,
and failed forwards record attempt metadata instead of disappearing.
Signed public estimate/rental portal links can start token-bound capture
sessions, append low-PII session events, upload token-bound artifacts, show an
invite-gated `Record feedback` control, record mic audio, optionally record
DOM replay, and finalize into triage context work without Clerk. Authenticated
workspace/desktop shells now have an opt-in `Record feedback` dock using the
same controller and authenticated backend. The authenticated browser path is now
smoke-tested against the real local API/DB/storage/analyzer/export stack; the
missing pieces are higher-fidelity capture/analysis: real phone/tablet smoke,
real Mesh ingest proof, multimodal review over exported video/frame evidence,
and the native ReplayKit/MediaProjection path.

Opt-in capture ladder note:
`docs/OPT_IN_CAPTURE_LADDER_2026-06-04.md`. That document is the cross-product
policy and adapter plan: user cohorts, consent scopes, state-provider contract,
chunked media, live screen sharing, and the NHL/Chess/WinWar/Sandolab porting
sequence. The Sitelayer-specific next step is to centralize the capture policy
and enforce `consent_scope` server-side for events and artifacts.

## What already exists in this repo (reuse, do not rebuild)

- Typed event log: `docker/postgres/init/020_workflow_event_log.sql` -
  transitions with `state_version`, `event_type`, `snapshot_after`. Written
  transactionally in `packages/queue/src/index.ts:appendWorkflowEvent`.
- Trace forwarder to Mesh: `apps/worker/src/runners/mesh-trace-forward.ts` -
  code-complete, INERT. Activate with `MESH_TRACE_FORWARD_URL`,
  `MESH_TRACE_HMAC_COMPONENT`, `MESH_TRACE_HMAC_SECRET` (worker env). Durable
  forwarding state lives in
  `docker/postgres/init/131_mesh_trace_forward_state.sql`.
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
  packets. It also records accepted or failed forward attempts in
  `mesh_trace_forward_state`, so local proof/retry state does not depend only on
  Control Plane ingest logs.
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
- The analyzer also refreshes readiness for finalized capture work items even
  when no artifact is eligible under the current mode flags. This matters for
  the default browser UX: authenticated and portal recorders are audio-first, but
  `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE` defaults to `off`; such sessions now
  get explicit zero-eligible readiness instead of hanging forever before the
  dispatch gate.
- URI-only capture artifacts now count as reference evidence. The worker writes
  an `agent.artifact_attached` event with analyzer `reference-artifact-v1`,
  preserves a safe reference descriptor, uses `metadata.excerpt` when present,
  and does not fabricate a download path for bytes it cannot fetch. This keeps
  seeded/demo captures and externally referenced evidence visible to the same
  readiness gate as stored artifacts.
- The analyzer can now optionally enqueue the existing Mesh context-work
  dispatch outbox after artifact analysis is ready. It is default-off behind
  `CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH=1`, and only applies to work items
  already routed to `lane in ('agent', 'both')` or explicitly marked with
  `metadata.capture_auto_dispatch=true`. Public portal finalization still lands
  in `triage` and will not auto-dispatch by default.
- Authenticated capture finalization now has a trusted promotion policy. With
  `CAPTURE_AUTH_AUTO_DISPATCH=1`, feedback/desktop/native sessions consented by
  authenticated admin/foreman/office/bookkeeper users finalize to `lane =
'both'` and `metadata.capture_auto_dispatch = true` when the requested lane was
  the default `triage`. This gives pilots a controlled path from internal
  recordings to the analysis-ready dispatch gate without letting public portal
  guests create agent tasks.
- The analyzer can transcribe raw audio artifacts through the local
  faster-whisper HTTP server when explicitly enabled with
  `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=local-whisper`; default is off. When
  enabled, it writes a normal `capture_artifacts(kind='transcript')` row for the
  transcript, copies the source retention/access policy, and links that derived
  artifact from the analysis event without exposing storage keys.
- `apps/web/src/lib/takeoff/canvas-geometry-artifact.ts` now builds and uploads a
  sanitized `canvas_geometry` artifact payload for takeoff measurements. It
  strips storage paths, file URLs, data URLs, and photo thumbnails.
- `apps/web/src/lib/capture-artifact-providers.ts` now provides a mounted-screen
  artifact registry. The authenticated feedback dock calls registered providers
  before finalization, and the project, desktop, and mobile takeoff canvases
  register sanitized `canvas_geometry` uploads while mounted. That means an
  authenticated `Record feedback` stop on a takeoff canvas can attach committed
  measurements plus current draft/selection/viewport state to the same
  `capture_session_id` before the work item is finalized.
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
- `apps/web/src/lib/capture-replay-recorder.ts` now imports
  `@rrweb/record`, applies privacy-preserving defaults (`maskAllInputs`,
  no inline images, no canvas recording), buffers replay events, and uploads an
  `rrweb` JSON artifact through the active backend.
- `apps/web/src/lib/feedback-capture-controller.ts` now composes the non-UI
  feedback loop: start a capture session, start mic and optional rrweb replay,
  upload audio/replay artifacts, finalize one work item, or discard local/server
  state. The backend is injected, so the same controller can target
  authenticated routes or signed estimate/rental portal routes. It now keeps
  in-memory pending-stop state after upload/finalize failures and also writes
  replayable IndexedDB queue rows for capture start, artifact upload, and
  finalization when the network drops. A session that fails before Start returns
  can still record locally, then replay start -> artifacts -> finalize in order.
- `apps/web/src/portal/IssueReporter.tsx` now exposes an invite-gated
  `Record feedback` control on signed estimate and rental portal links. It
  starts a token-bound capture session, records mic audio, appends
  `portal.feedback.recording_started/stopped` events, uploads artifacts, and
  finalizes one triage work item through the public portal helpers. The default
  path is audio-only; DOM replay is explicit opt-in via `capture_replay=1` or
  `VITE_CAPTURE_REPLAY=1`, and the consent scope records
  `streams: ["audio", "dom_replay"]` only in that mode.
- `apps/web/src/components/capture/AuthenticatedFeedbackDock.tsx` now exposes
  the same `Record feedback` loop inside authenticated workspace and desktop
  shells. It is deliberately opt-in for now through `capture_feedback=1`,
  `VITE_AUTH_CAPTURE_FEEDBACK=1`, or the
  `sitelayer.auth-feedback-enabled` localStorage flag. It starts an
  authenticated capture session with a caller-provided `capture_session_id`,
  records mic audio, appends
  `authenticated.feedback.recording_started/stopped/discarded` events, uploads
  audio, optionally uploads rrweb replay when `capture_replay=1` or
  `VITE_AUTH_CAPTURE_REPLAY=1` is set, finalizes into triage, and can discard
  the server session. The dock defaults to audio-only to avoid silently capturing
  customer/project/money DOM content.
- Public estimate/rental portal links now also have token-bound discard routes.
  Discard marks the capture session `discarded`, tombstones artifact rows, and
  best-effort deletes stored artifact objects before the UI clears local state.
- `/desktop/*` now mounts `ControlPlaneProbe` directly, matching the canonical
  workspace route. That closes the browser-bridge context hole where desktop
  command-center captures lacked company/route/project labels.
- The operator trace tap (`apps/web/src/lib/control-plane-trace.ts`) and
  `ControlPlaneProbe` now include the active Sitelayer capture-session summary
  when one exists. That gives browser-bridge desktop captures, Sitelayer API
  headers, product trace, support packets, context work, and artifact analysis a
  common `capture_session_id` instead of parallel unjoinable traces.
- `scripts/seed-scenario.ts` now accepts an optional `capture_sessions` section.
  A scenario can seed a deterministic capture session, low-PII session events,
  artifact refs, support packet, context work item, and handoff events joined by
  `capture_session_id`. `scenarios/steve-demo.yaml` uses this to include one
  captured AI-takeoff feedback episode. This is fixture proof of the data model,
  not proof that a live browser recording and worker analyzer ran.
- `scripts/test-capture-session-smoke.sh` now drives the authenticated capture
  API end to end: start session, append events, upload transcript and rrweb
  artifacts through multipart storage, finalize into one support packet/context
  work item, fetch counts, and re-finalize to prove idempotency.
- `scripts/analyze-capture-session.ts` / `npm run capture:analyze` now forces
  the deterministic artifact analyzer for one `CAPTURE_SESSION_ID` and verifies
  analysis handoff event counts plus readiness metadata. In local compose, run
  it inside the worker container so it inherits database and object-storage env.
- `e2e/tests/portal-feedback-capture.smoke.spec.ts` /
  `npm run capture:portal-smoke` now proves the browser side of the signed
  public portal recorder with mocked APIs: invite gate, `MediaRecorder`, optional
  rrweb replay, capture-session header propagation, start/stop events, audio and
  `rrweb` multipart uploads, and finalize payload. The config uses an isolated
  `/tmp/sitelayer-vite-cache-portal-smoke` Vite cache so root-owned container
  cache files do not block local runs.
- `e2e/tests/authenticated-feedback-capture.live.spec.ts` /
  `npm run capture:auth-browser-smoke` drives the authenticated `Record feedback`
  dock in a real browser against the real local/dev API. It uses the e2e act-as
  headers, fakes only the browser microphone, records audio plus opt-in rrweb,
  finalizes, fetches the capture-session detail route, and writes a JSON result
  when `AUTH_CAPTURE_SMOKE_OUT` is set.
- `scripts/test-authenticated-feedback-capture.sh` /
  `npm run capture:auth-smoke` is the full live browser proof wrapper: run the
  authenticated browser smoke, force deterministic artifact analysis for the
  resulting `capture_session_id`, and export the same corpus for
  Gemini/Antigravity review. It runs current web source on the API-allowed
  `localhost:5173` origin, preflights CORS before launching Playwright, and fails
  with captured request errors instead of hanging on browser CORS failures. The
  Playwright config now has device presets: default `desktop`,
  `AUTH_CAPTURE_SMOKE_PROJECTS=mobile` for Pixel 7 emulation, and
  `AUTH_CAPTURE_SMOKE_PROJECTS=tablet` for Chromium tablet-touch emulation.
  These are
  still browser emulation, not physical-device proof, but they exercise the
  mobile/tablet layout, capture dock, mic/replay/controller path, takeoff
  geometry provider, API finalization, analyzer, and export assertions against
  the same live local backend.
- `scripts/export-capture-session.ts` / `npm run capture:export` now exports one
  Sitelayer `CAPTURE_SESSION_ID` into a corpus package for the existing
  `/home/taylorsando/projects/capture/bin/capture-analyze` lane: JSON manifest,
  Markdown context file, artifact index, transcript sidecar, optional
  artifact-file export, and `run-capture-analyze.sh` for the Gemini/Antigravity
  `agent-cli` lane. `--include-artifact-files` pulls allowed stored artifact
  bytes into `./artifacts`; restricted-PII artifacts are skipped unless
  `--include-restricted-artifact-files` is passed. It always writes a safe
  corpus-only `run-capture-analyze.sh`; when an exported video artifact exists,
  it also writes `run-capture-analyze-video.sh`, which passes the media file as
  the positional recording so Gemini can use native video analysis and
  Antigravity can sample frames. It does not invoke Gemini or create Mesh tasks
  by itself.
- `scripts/create-capture-reference.ts` / `npm run capture:reference` is the
  non-UI ingress for Steve/operator/external sessions. It can take
  browser-bridge trace ids, Meet/video/audio/transcript/context URIs, local file
  paths as `file://` references, stored local uploads via `--recording-file`,
  `--audio-file`, `--transcript-file`, `--context-file`, and operator notes; it
  creates a `manual_upload` or `desktop` capture session, appends URI-only
  artifacts, uploads local files through the normal artifact route, writes low-PII
  note events, and finalizes through the same support-packet/context-work
  pipeline. This closes the scenario where the evidence was captured outside the
  web recorder but still needs the same `capture_session_id`.
- `scripts/test-capture-reference-ingest.sh` /
  `npm run capture:reference-smoke` proves that reference path against a local
  API/DB: create external reference capture, run deterministic artifact analysis
  over URI-only plus uploaded artifacts, and export the corpus for reviewer
  handoff.
- `scripts/review-capture-session.sh` / `npm run capture:review` wraps that
  export into a safer operator command. By default it prepares the corpus and
  prints the selected `capture-analyze` command path without spending reviewer
  quota; `CAPTURE_REVIEW_EXECUTE=1` runs the Gemini/Antigravity/agent-cli lane,
  and `CAPTURE_REVIEW_USE_VIDEO=1` prefers the generated positional-video
  command when a video artifact was exported.
- `scripts/import-capture-review.ts` / `npm run capture:review-import` is the
  return path for reviewer output. Given `CAPTURE_SESSION_ID`, `REVIEW_FILE`,
  and `DATABASE_URL`, it inserts an idempotent
  `agent.capture_review_attached` handoff event on the finalized work item with
  the reviewer name, content hash, truncated review markdown, and source command
  reference. That keeps Gemini/Antigravity output joined to the same
  `capture_session_id` instead of living only in a local export folder.
- `scripts/dispatch-capture-session-smoke.ts` /
  `npm run capture:dispatch-smoke` now proves the default-off analysis-ready
  dispatch bridge without touching the real Mesh. It marks one finalized capture
  work item as explicitly agent-routable, enables
  `CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH=1`, runs artifact analysis, drains
  `dispatch_mesh_work_request` into a local fake Mesh endpoint, verifies
  `agent.dispatch_queued` plus `agent.dispatch_acknowledged`, and verifies the
  dispatched handoff carries a scoped callback token. The script redacts that
  token from terminal output. It can also hit a real Control Plane dispatch URL
  only when `MESH_WORK_REQUEST_DISPATCH_URL` and
  `ALLOW_REAL_MESH_DISPATCH_SMOKE=1` are set. In real Control Plane mode it now
  forces Mesh `auto_dispatch=false` unless
  `CAPTURE_DISPATCH_SMOKE_AUTO_DISPATCH=1` is explicit, so the smoke can prove
  task creation without routing a live agent. When `MESH_POSTGRES_DSN` or
  `CONTROL_PLANE_POSTGRES_DSN` is present, the script verifies the matching
  Control Plane `tasks` row by idempotency key and asserts it preserved
  `capture_session_id`, `work_item_id`, `context_handoff_ref`, payload version,
  callback token type, and the nested execution-context handoff.
  `REQUIRE_MESH_DISPATCH_DB_VERIFY=1` makes that read-side proof mandatory.
  The script also prints the local `agent.dispatch_acknowledged` payload as
  `dispatch_acknowledgement`, so a real run still exposes the Mesh task id that
  Mesh returned even when direct Control Plane DB verification is unavailable.
  Current workstation note: `http://mesh-hetzner:8713/api/orchestrate/tasks`
  accepted a safe no-auto preflight task (`162115`), but direct Control Plane
  Postgres verification is blocked here by `pg_hba.conf`, so do not turn on the
  mandatory DB verifier until that access is fixed. When `SITELAYER_API_URL` is
  present, the same smoke replays the scoped callback token back into
  `/api/work-requests/:id/agent-callback` as `agent.message_received`;
  `REQUIRE_CAPTURE_CALLBACK_REPLAY=1` makes that return-path proof mandatory.
- `scripts/trace-capture-session-smoke.ts` / `npm run capture:trace-smoke` now
  proves the product-trace lane for one capture session. It appends one low-PII
  `capture_session_event`, runs the existing Mesh trace forwarder once, and by
  default posts to a local fake `/api/product-trace/ingest` endpoint while
  asserting the forwarded event preserves `capture_session_id` and does not leak
  raw capture event payload. It also verifies the matching
  `mesh_trace_forward_state` row is `forwarded` and retains the session join.
  `npm run capture:trace-smoke -- --preflight` now checks the real Control
  Plane prerequisites without mutating a capture session: trace env shape,
  product-trace migrations, `product_trace_events.capture_session_id`,
  component-secret metadata, and the active `capture_grants` row for
  `project_key=sitelayer` plus `principal_id=<MESH_TRACE_HMAC_COMPONENT>`.
  The DB probe is skipped when the trace env itself is incomplete unless
  `MESH_TRACE_PREFLIGHT_CHECK_DB=1` is set. `REQUIRE_MESH_TRACE_PREFLIGHT=1`
  turns missing checked prerequisites into a hard failure.
  It can hit a real Control Plane product-trace URL only when `MESH_TRACE_*` env
  and `ALLOW_REAL_MESH_TRACE_SMOKE=1` are set. When `MESH_POSTGRES_DSN` or
  `CONTROL_PLANE_POSTGRES_DSN` is present, the script also verifies the exact
  stored `product_trace_events.event_ref`; `REQUIRE_MESH_TRACE_DB_VERIFY=1`
  turns that read-side verification into a hard gate.
- `apps/worker/src/runners/capture-artifact-analysis.ts` now also mints the
  same scoped callback shape that manual `/api/work-requests/:id/dispatch/mesh`
  uses: callback path, optional public URL, bearer token, expiration, and a
  stored SHA-256 token hash on `context_work_items`. Auto-dispatched capture
  tasks can now report back through `/api/work-requests/:id/agent-callback`.
- Capture auto-dispatch payloads now carry `capture_session_id` through the
  `dispatch_mesh_work_request` outbox payload, Mesh task `properties`,
  `execution_context`, nested `context_handoff`, and task description. The
  analysis-ready brief also embeds a `capture_export` instruction with
  `CAPTURE_SESSION_ID=<id> npm run capture:export -- --include-artifact-files`,
  so the receiving agent can pull the exact evidence package without guessing
  from title/route text.
- Manual work-request dispatch now stores `mutation_outbox.capture_session_id`,
  exposes `capture_session_id` in dispatch diagnostics/briefs/responses, and
  work-item status/callback events inherit the work item's existing
  `capture_session_id` even when the later request itself does not carry the
  capture header. Worker-side Mesh ack/cancel events also write the session id.
  `lane='both'` now routes as implementation-capable work, not read-only audit,
  so trusted internal capture promotion does not silently land in the wrong
  Mesh lane. That keeps callback and dispatch lifecycle events joined to the
  original capture session. Dispatch payloads now have a stable payload version,
  reject unknown callback token types before posting to Mesh, and include the
  callback token type in Mesh properties/execution context so downstream agents
  know how to report back.
- Video `frames-only` analysis now has a first local implementation: the worker
  extracts review frames with `ffmpeg`/`ffprobe`, stores each frame plus a
  JSON manifest as derived `capture_artifacts`, inherits the source
  retention/access policy, and links the manifest/frame refs from the
  `agent.artifact_attached` analysis event. This is not multimodal reasoning
  yet; it is the evidence packaging layer Gemini/Antigravity can consume next.
- `scripts/test-capture-audio-roundtrip.sh` /
  `npm run capture:audio-qa` now wraps the existing
  `/home/taylorsando/projects/capture/bin/capture-audio-qa` tool. It generates
  known TTS speech at multiple speeds, transcribes through the local
  voice-tools Whisper server, scores WER, and fails above
  `CAPTURE_AUDIO_QA_MAX_WER` (default `0.25`). This proves the local
  speech-to-text quality path without using Claude or a second STT pipeline.
- `scripts/test-capture-learning-loop.sh` /
  `npm run capture:learning-smoke` now orchestrates the focused smokes against
  one `capture_session_id`: API capture/finalize, artifact analysis, dispatch
  bridge, product-trace forwarding, corpus export, and a synthetic reviewer
  output import through `capture:review-import`. It produces one aggregate JSON
  result while preserving the focused scripts as the source of truth for each
  assertion.
- Local compose proof on 2026-05-31: scripted smoke session
  `85db0e65-cc1f-4082-be9c-beed3b0d6896` created one context work item
  (`414b005c-802c-46f1-9e3f-cdb8f4c43f23`) with two events and two stored
  artifacts. Worker analysis produced two `agent.artifact_attached` handoff
  events, set `metadata.capture_artifact_analysis.status` to `ready`, queued one
  dispatch outbox row with a scoped callback, posted once to a fake Mesh
  endpoint, marked the outbox `applied`, and moved the work item to
  `agent_running`.

These need review as one C0/R0 stack. A real authenticated browser session now
proves joined rows across the database, support packet, context work item,
artifact analysis, and corpus export. Local compose proof on 2026-06-01:
`npm run capture:auth-smoke` created capture session
`794f44df-9178-47eb-a554-bf17f4ee1919`, work item
`6a43a259-fdfe-4d13-bfff-a2336fa235c7`, support packet
`789eb991-6aa7-4f59-b1b6-b68de7307894`, drove the project takeoff canvas,
uploaded `audio`, `rrweb`, and `canvas_geometry`, recorded three events, ran
deterministic artifact analysis to `ready`, and exported three artifact files
for reviewer handoff. The same browser smoke also created discarded session
`1a629483-1439-4741-888a-21a8c2c58f36` and verified it stayed terminal with zero
artifacts. Mobile/tablet emulation proof on 2026-06-01: the same
authenticated browser smoke passed under `AUTH_CAPTURE_SMOKE_PROJECTS=mobile`
(`mobile-pixel-7`) and `AUTH_CAPTURE_SMOKE_PROJECTS=tablet`
(`tablet-chromium-touch`) against the live local API, proving stop/finalize and
discard for both emulated form factors. What is still missing is the real
Mesh-ingest half and a true physical phone/tablet device run. The
analysis-ready dispatch bridge is implemented and
locally smoke-tested against a fake Mesh endpoint, but it is deliberately opt-in
and still needs a real Mesh-ingest smoke before enabling.

## What is still net-new in this repo

- A true phone/tablet session lifecycle smoke against the real API: start, emit
  nav/session events, stop, upload, discard, retention fields, and artifact
  analysis. The authenticated desktop-browser path now has a live
  API/DB/storage/analyzer/export smoke, and its discard branch is live-smoked
  against the same API. Mobile/tablet browser emulation is now green through the
  same smoke config, so the remaining gap is graduating to physical
  phone/tablet coverage and the offline replay branch on real mobile browsers.
- A real demo smoke that compares the seeded `capture_sessions` fixture against
  a freshly recorded session from `/demo` or a signed portal link. The seeded
  episode proves the tables and joins can be represented; the live smoke must
  prove permissions, upload, finalization, artifact analysis, and trace
  forwarding from a browser/device. The local scripted API smoke now proves
  storage-backed upload, finalization, deterministic artifact analysis, and
  analysis-readiness metadata against compose; the portal browser smoke proves
  browser recorder behavior with mocked APIs.
- Browser feedback artifact capture beyond smoke-tested slices. Estimate/rental
  portals can upload audio and opt-in DOM replay artifacts, and authenticated
  workspace/desktop shells now have an opt-in dock with audio plus explicit
  replay. Takeoff canvases now register sanitized geometry artifact providers.
  The controller now has in-memory retry for page-local retries and persisted
  IndexedDB replay for queued start/upload/finalize sequences, with the capture
  controls showing a queued terminal state when a recording has been saved for
  replay. The authenticated desktop-browser smoke now proves live takeoff-canvas
  geometry upload before finalization. Richer consent copy and real phone/tablet
  smoke are still missing.
- Mesh task dispatch after capture analysis is now mechanically available and
  fake-Mesh smoke-tested. The real Control Plane task-create route has been
  probed safely with `auto_dispatch=false` (task `162115`), and the same capture
  smoke now defaults real-mode dispatch to non-auto unless explicitly
  overridden. What is still missing is an operator-run capture-generated real
  smoke against that safe endpoint, plus DB-side verification after Control
  Plane Postgres access is fixed. The script can now also replay the scoped
  callback against a running Sitelayer API when `SITELAYER_API_URL` is set, so
  the remaining work is running that proof in the same real endpoint
  environment.
- Product-trace forwarding now has a local smoke proving Sitelayer's outbound
  shape, HMAC-signed request path, and local durable forward-state row. The
  script can verify a real Control Plane `product_trace_events` row when given a
  mesh Postgres DSN, and it now has a preflight that checks the exact auth/grant
  prerequisites before mutating a session. The remaining gap is provisioning or
  verifying the Control Plane component secret plus active `capture_grants` row
  for the configured Sitelayer component, then verifying the trace continues into
  conformance/belief review. On this workstation, direct Control Plane DB access
  is still the practical blocker for mandatory read-side verification.
- Video frame artifacts. `CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE=frames-only`
  now extracts derived frame artifacts plus a manifest locally. The remaining
  gap is a live multimodal model-review run of that manifest/frame set and a
  real video-session smoke. `npm run capture:review` is now the prepared wrapper
  for that Gemini/Antigravity handoff, and `npm run capture:review-import`
  attaches the reviewer result back to the capture work item.
- Retention policy for future model-derived video summaries. Raw artifacts,
  local-whisper transcript artifacts, and extracted video frames/manifests now
  use normal artifact rows and the GC path; future Gemini/Antigravity summary
  artifacts need the same treatment.
- rrweb DOM replay beyond explicit opt-in. The real rrweb recorder is installed,
  and both public portal plus authenticated dock paths can upload replay
  artifacts when explicitly enabled. Replay is still not the canvas/video answer.
- The broader in-app "Record feedback" surface now exists as an opt-in dock, but
  it still needs a fuller consent sheet, real device smoke, and a product
  decision on when to expose it by default to pilot users. The server-side
  trusted promotion flag exists, but should stay off until the real Mesh
  dispatch smoke is complete.
- Takeoff-canvas fidelity: the canvas is pixels, not DOM, so rrweb still misses
  visual video. The authenticated dock now uploads sanitized geometry snapshots
  from mounted takeoff screens before finalization, but this is state capture,
  not pixel video, and still needs browser/device smoke.
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
   finalize routes, durable Mesh trace forward state, and Mesh trace forwarding
   for `capture_session_events`.
2. R1/C1: invite-gated web `Record feedback`. The public portal audio slice now
   exists, public portal DOM replay can be explicitly enabled, and an
   authenticated opt-in dock is mounted in workspace/desktop shells. The desktop
   browser smoke now proves audio/replay/canvas-geometry/finalize/analyze/export
   against the real local API. Next: real phone/tablet smoke of the same path,
   and transcription through the existing local-whisper path.
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
