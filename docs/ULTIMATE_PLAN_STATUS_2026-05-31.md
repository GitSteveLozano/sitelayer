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
  finalization, artifact upload plumbing, and local deterministic artifact
  analysis proof. The authenticated browser recorder is now smoke-tested against
  the real local API/DB/storage/analyzer/export stack, and the signed-portal
  recorder is smoke-tested with mocked APIs. The full real device-to-Mesh
  learning loop is still not closed. The Mesh dispatch payload contract is now
  versioned and safe real-mode smoke defaults to `auto_dispatch=false`; a
  no-dispatch Control Plane preflight task was accepted, but capture-generated
  real dispatch plus DB verification is still open.
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
- URI-only capture artifacts now produce reference analysis events and count
  toward readiness, so seeded/demo or external-reference evidence is not
  invisible to dispatch;
- analyzer readiness metadata on finalized context work items, so future
  routing can wait for artifact analysis instead of racing finalization;
- signed public estimate/rental portal capture finalization into triage work
  items, plus public portal upload/finalize client helpers;
- a dependency-injected rrweb replay helper for future recorder UI wiring;
- a backend-injected feedback capture controller that composes session start,
  mic/replay artifact upload, finalization, and discard without touching screens;
- an invite-gated `Record feedback` control on signed estimate/rental portal
  links with audio plus explicit opt-in DOM replay;
- an opt-in authenticated `Record feedback` dock mounted in workspace and
  desktop shells. It uses the same controller with authenticated capture APIs,
  records audio by default, can explicitly enable rrweb through
  `capture_replay=1`, appends authenticated feedback start/stop/discard events,
  finalizes into triage, and discards the server session when cancelled. It is
  gated by `capture_feedback=1`, `VITE_AUTH_CAPTURE_FEEDBACK=1`, or
  `sitelayer.auth-feedback-enabled` so it does not unexpectedly alter the pilot
  UI while the design-conformance pass is active;
- token-bound public portal discard routes that mark sessions discarded,
  tombstone artifact rows, and best-effort delete stored artifact objects;
- desktop command-center routes now mount the same `ControlPlaneProbe` context
  bridge as the canonical workspace route, so browser-bridge capture can label
  `/desktop/*` sessions with company/route/project context;
- active Sitelayer capture sessions are now included in operator trace payloads
  and `ControlPlaneProbe.capture()`, giving browser-bridge desktop traces the
  same `capture_session_id` join key as API headers, work items, and artifacts;
- context-work dispatch handoffs now carry
  `sitelayer.context_work_dispatch.v1`, validate callback payload shape before
  mutation, reject unknown callback token types before posting to Mesh, and
  allow real smoke runs to create Control Plane tasks with
  `auto_dispatch=false`;
- low-PII `capture_session_events` forwarding into Mesh product trace;
- durable `mesh_trace_forward_state` proof/retry rows for product-trace
  forwarding;
- a sanitized takeoff canvas geometry artifact helper plus mounted-screen
  providers for project, desktop, and mobile takeoff canvases;
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
  analysis event without leaking storage keys. Video reasoning remains gated,
  but `frames-only` now extracts local frame evidence and a manifest instead of
  only recording a skipped event.
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
- `apps/web/src/lib/capture-replay-recorder.ts` now imports
  `@rrweb/record`, applies masked/no-canvas/no-inline-image defaults, buffers
  replay events, and uploads `rrweb` JSON artifacts through the active backend.
- `apps/web/src/lib/feedback-capture-controller.ts` now provides the non-UI
  orchestration for `Record feedback`: start session, start mic and optional
  replay, upload audio/replay artifacts, finalize, or discard. Its backend is
  injected, so authenticated, estimate portal, and rental portal flows can share
  it. It also keeps an in-memory pending-stop state after upload/finalize
  failures and persists replayable offline queue rows for capture start,
  artifact upload, and finalization. If the network fails before Start returns,
  the controller can still record locally and later replay start -> artifacts ->
  finalize in order.
- `apps/web/src/portal/IssueReporter.tsx` now wires that controller into signed
  public estimate/rental portals as an invite-gated recorder. It starts a
  token-bound session, appends start/stop events, uploads audio, can optionally
  upload DOM replay when `capture_replay=1` or `VITE_CAPTURE_REPLAY=1` is set,
  can discard the token-bound session server-side, and finalizes one triage work
  item without Clerk auth. Public portal recording still does not capture
  takeoff-canvas geometry; the geometry providers are currently mounted only in
  authenticated takeoff screens.
- `apps/worker/src/runners/mesh-trace-forward.ts` selects
  `workflow_event_log.capture_session_id`, emits a stable producer `event_ref`,
  and forwards both to Mesh product trace. It now also forwards low-PII
  `capture_session_events` as product trace events, so browser/mobile/public-link
  behavior can feed the learning loop even when no workflow reducer fired.
  `docker/postgres/init/131_mesh_trace_forward_state.sql` now records accepted
  and failed forward attempts, giving the learning loop local proof/retry state
  instead of relying only on mesh-side dedupe logs.
- `apps/web/src/lib/takeoff/canvas-geometry-artifact.ts` now builds and uploads a
  sanitized takeoff `canvas_geometry` artifact payload that strips storage paths,
  file URLs, data URLs, and photo thumbnails.
- `apps/web/src/lib/capture-artifact-providers.ts` now provides the extra
  artifact bridge used by authenticated feedback. The project takeoff canvas,
  desktop estimator canvas, and mobile takeoff screen register providers while
  mounted; the authenticated feedback dock calls them before finalization so a
  takeoff feedback session can carry committed measurements plus current
  draft/selection/viewport state as `canvas_geometry`.
- `scripts/test-capture-session-smoke.sh` now provides the repeatable
  authenticated live smoke for the capture API/storage/finalize path:
  start session, append low-PII events, upload transcript plus rrweb artifacts,
  finalize one support packet/context work item, fetch counts, and prove
  re-finalization idempotency.
- `scripts/analyze-capture-session.ts` / `npm run capture:analyze` now provides
  the repeatable worker-side check for one `CAPTURE_SESSION_ID`: force artifact
  analysis, verify analysis handoff event counts, and verify work-item readiness
  metadata.
- `e2e/tests/portal-feedback-capture.smoke.spec.ts` /
  `npm run capture:portal-smoke` now proves the public portal browser recorder
  with mocked APIs: invite-gated control, fake browser mic permission,
  `MediaRecorder`, opt-in rrweb replay, capture-session request header, event
  append, audio/replay artifact uploads, and finalize payload. The smoke also
  caught and fixed a local dev-overlay collision by moving the portal recorder
  anchor away from the bottom-right role switcher.
- `e2e/tests/authenticated-feedback-capture.live.spec.ts` /
  `npm run capture:auth-browser-smoke` now drives the authenticated feedback dock
  against the real local/dev API, using e2e act-as auth and faking only browser
  mic hardware. It proves browser start/stop, audio plus rrweb upload,
  finalization, and capture-session detail counts.
- `scripts/test-authenticated-feedback-capture.sh` /
  `npm run capture:auth-smoke` wraps that browser smoke into the backend learning
  loop: it takes the browser-created `capture_session_id`, runs deterministic
  artifact analysis, and exports the review corpus. It runs current source on
  `localhost:5173` so the test does not depend on the potentially stale compose
  web container on `localhost:3000`, and it preflights API CORS before launching
  Playwright. The same config now supports `AUTH_CAPTURE_SMOKE_PROJECTS=mobile`
  for Pixel 7 emulation and `AUTH_CAPTURE_SMOKE_PROJECTS=tablet` for Chromium
  tablet-touch emulation, keeping the same live API/storage/analyzer/export
  assertions while exercising the mobile/tablet layout.
- `scripts/export-capture-session.ts` / `npm run capture:export` now bridges
  Sitelayer capture sessions to the existing `capture` repo analysis lane. It
  exports JSON/Markdown corpus files, an artifact index, optional stored
  artifact files, and a transcript sidecar. The generated safe
  `run-capture-analyze.sh` command is corpus-only through the
  Gemini/Antigravity `agent-cli` reviewer path; when an exported video artifact
  exists, the exporter also writes `run-capture-analyze-video.sh`, which passes
  that file as the positional recording. It does not run Gemini or create Mesh
  tasks by itself.
- `scripts/review-capture-session.sh` / `npm run capture:review` now wraps the
  export handoff into a prepare-first reviewer command. It defaults to
  `CAPTURE_REVIEWER=gemini`, prints the selected generated command, and only
  executes the Gemini/Antigravity `agent-cli` reviewer lane when
  `CAPTURE_REVIEW_EXECUTE=1` is set.
- `apps/worker/src/runners/capture-artifact-analysis.ts` now has an optional
  analysis-ready dispatch bridge. With
  `CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH=1`, once artifact analysis metadata is
  `ready`, the worker queues the existing `dispatch_mesh_work_request` outbox
  for work items already in `lane='agent'/'both'` or explicitly marked
  `metadata.capture_auto_dispatch=true`. It also backfills already-ready work
  items, so routing can be enabled after analysis has completed. This is
  intentionally default-off; it prevents public portal triage items from
  silently becoming implementation tasks.
- Capture auto-dispatch now mints the same scoped callback contract as manual
  `/api/work-requests/:id/dispatch/mesh`: callback path, optional public URL,
  bearer token, expiration, and SHA-256 token hash stored on
  `context_work_items`. That closes the previous one-way handoff gap where a
  capture-generated Mesh task could be created without a reliable
  `/agent-callback` return path.
- Capture auto-dispatch now also carries the evidence correlation key through
  the handoff. The queued payload includes `capture_session_id`; Mesh task
  `properties`, `execution_context`, nested `context_handoff`, and the human
  description all retain it; and the analysis-ready brief includes a
  `capture_export` instruction for the exact `CAPTURE_SESSION_ID` export command
  with `--include-artifact-files`. That closes the previous gap where a
  receiving agent could get a context-work task without a deterministic evidence
  export pointer.
- Finalized audio-only sessions no longer get stuck before dispatch just because
  audio transcription is disabled. The artifact analyzer now refreshes readiness
  for finalized capture work items even when the current analysis modes produce
  zero eligible artifacts, so the work item records explicit ready/pending counts
  instead of silently missing `metadata.capture_artifact_analysis`.
- URI-only capture artifacts now get explicit `reference-artifact-v1` handoff
  events. The worker uses `metadata.excerpt` when present, stores only a safe
  reference descriptor, avoids a fake download path, and counts the artifact in
  readiness. This is what makes the `steve-demo` scenario transcript reference
  visible to the same analysis/dispatch gate as stored bytes.
- Trusted authenticated captures now have a server-side promotion path, still
  default-off. With `CAPTURE_AUTH_AUTO_DISPATCH=1`, authenticated
  admin/foreman/office/bookkeeper feedback/desktop/native captures can finalize
  to `lane='both'` with `metadata.capture_auto_dispatch=true`; public portal
  captures remain forced to triage.
- Work-item dispatch/callback lifecycle events now retain the session join key.
  `updateContextWorkItemWithEventTx` defaults new handoff events to the work
  item's existing `capture_session_id`; manual dispatch outbox rows store
  `mutation_outbox.capture_session_id`; manual dispatch briefs/diagnostics and
  responses expose the same capture id; analyzer auto-dispatch outbox rows store
  the same column; worker Mesh ack/cancel events write the session id; and
  `lane='both'` now routes as implementation-capable work rather than read-only
  audit.
- Finalized capture sessions now have a frozen artifact set. Authenticated and
  portal artifact upload routes return `409` after a session has produced its
  `capture_session_finalize` work item, so late uploads cannot invalidate
  readiness after dispatch. Finalize/discard transitions also append
  low-PII lifecycle `capture_session_events` (`session.finalized`,
  `session.discarded`, etc.) for the trace stream.
- `CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE=frames-only` now does real local evidence
  packaging. The worker extracts frames through `ffmpeg`/`ffprobe`, stores frame
  artifacts plus a manifest as derived `capture_artifacts`, inherits source
  retention/access policy, and links those refs from the analysis event. The
  remaining gap is multimodal interpretation of those frames, not packaging.
- `scripts/dispatch-capture-session-smoke.ts` /
  `npm run capture:dispatch-smoke` now proves the analysis-ready dispatch bridge
  without touching the real Mesh. It marks one finalized capture work item as
  explicitly agent-routable, enables the default-off auto-dispatch bridge, runs
  artifact analysis, drains context-work dispatch into a local fake Mesh
  endpoint, verifies queued plus acknowledged dispatch events, verifies the
  dispatched handoff includes a scoped callback token, verifies the fake Mesh
  payload retains `capture_session_id` plus `capture_export`, redacts that token
  from output, and checks the work item reaches `agent_running`. The same script
  can hit a real Control Plane dispatch URL only behind
  `ALLOW_REAL_MESH_DISPATCH_SMOKE=1`; when `MESH_POSTGRES_DSN` or
  `CONTROL_PLANE_POSTGRES_DSN` is present, it also verifies the created
  Control Plane `tasks` row by idempotency key and checks
  `capture_session_id`, `work_item_id`, `context_handoff_ref`, payload version,
  callback token type, and nested execution-context handoff preservation. In
  real Control Plane mode it now defaults Mesh `auto_dispatch=false` unless
  `CAPTURE_DISPATCH_SMOKE_AUTO_DISPATCH=1` is explicit, which lets us prove task
  creation without waking a downstream agent. `REQUIRE_MESH_DISPATCH_DB_VERIFY=1`
  makes that read-side proof mandatory. The script now also emits the local
  `agent.dispatch_acknowledged` payload as `dispatch_acknowledgement`, giving an
  audit handle for the returned Mesh task id even when DB access is blocked.
  Current workstation note: the live dispatch endpoint accepted safe no-auto
  task `162115`, but direct DB verification is blocked by Control Plane Postgres
  `pg_hba.conf`. When `SITELAYER_API_URL` is set, it can replay the scoped
  callback token into
  `/api/work-requests/:id/agent-callback`; `REQUIRE_CAPTURE_CALLBACK_REPLAY=1`
  makes that return-path proof mandatory.
- `scripts/trace-capture-session-smoke.ts` /
  `npm run capture:trace-smoke` now proves the Sitelayer product-trace lane
  without depending on Control Plane. It appends one low-PII
  `capture_session_event`, runs the existing Mesh trace forwarder once, posts to
  a local fake product-trace endpoint by default, and asserts the forwarded event
  preserves `capture_session_id` without leaking the raw capture event payload.
  It also verifies the matching `mesh_trace_forward_state` row is `forwarded`
  and retains the session join.
  `npm run capture:trace-smoke -- --preflight` now checks the real Control Plane
  prerequisites without mutating a capture session: trace env, product-trace
  tables, `product_trace_events.capture_session_id`, component-secret metadata,
  and active `capture_grants` authorization for the configured HMAC component.
  `REQUIRE_MESH_TRACE_PREFLIGHT=1` turns missing checked prerequisites into a
  hard gate.
  It can hit a real Control Plane product-trace endpoint only behind
  `ALLOW_REAL_MESH_TRACE_SMOKE=1` plus configured `MESH_TRACE_*`. When
  `MESH_POSTGRES_DSN` or `CONTROL_PLANE_POSTGRES_DSN` is present, it also
  checks the exact stored `product_trace_events.event_ref`; set
  `REQUIRE_MESH_TRACE_DB_VERIFY=1` to make that read-side proof mandatory.
- `scripts/export-capture-session.ts` can now package stored artifact bytes for
  the existing capture/agent-cli analysis lane. `--include-artifact-files`
  exports allowed files into `./artifacts`; `pii_level='restricted'` artifacts
  remain skipped unless `--include-restricted-artifact-files` is explicit. It
  also writes `sitelayer-capture-artifacts.md` and includes it as a context file
  for `capture-analyze`. If the exported corpus contains a video artifact, the
  optional video handoff command uses the video path as real media so Gemini can
  analyze video and Antigravity can sample frames. The default command stays
  corpus-only. This gives Gemini/Antigravity review a concrete local corpus
  instead of only manifest/download-path pointers.
- `scripts/import-capture-review.ts` closes the return path from that reviewer
  lane. `npm run capture:review-import` takes `CAPTURE_SESSION_ID`,
  `REVIEW_FILE`, and `DATABASE_URL`, then inserts an idempotent
  `agent.capture_review_attached` event on the finalized work item with the
  reviewer, hash, truncated markdown, and source command reference.
- `scripts/create-capture-reference.ts` adds a command-line ingress for
  evidence captured outside the in-app recorder. `npm run capture:reference`
  can create a `manual_upload` or `desktop` session from browser-bridge trace
  ids, Meet/video/audio/transcript/context URIs, local file paths as URI
  references, stored local uploads, and operator notes, then finalize it into the
  same work-item spine. This is the first concrete Steve/operator path for
  external desktop capture evidence that should still become analyzable
  Sitelayer context.
- `scripts/test-capture-reference-ingest.sh` /
  `npm run capture:reference-smoke` turns that path into a repeatable local
  proof: one external reference capture, deterministic reference/stored-artifact
  analysis, and corpus export for the Gemini/Antigravity reviewer lane.
- `scripts/test-capture-audio-roundtrip.sh` /
  `npm run capture:audio-qa` now wraps the existing capture repo
  `capture-audio-qa` path. It generates known TTS speech, transcribes through
  the local voice-tools Whisper server, scores WER, and fails above
  `CAPTURE_AUDIO_QA_MAX_WER`. This is local STT quality proof, not a live
  Sitelayer upload smoke.
- `scripts/test-capture-learning-loop.sh` /
  `npm run capture:learning-smoke` now runs the focused capture smokes against
  one session and emits one aggregate JSON proof: capture API/finalize, worker
  analysis readiness, dispatch bridge, product-trace forwarding, export
  packaging, and synthetic reviewer-output import. It is the fastest local/demo
  proof that the pieces still line up without turning every focused smoke into
  one large script.
- Local compose proof on 2026-05-31: smoke session
  `85db0e65-cc1f-4082-be9c-beed3b0d6896` created context work item
  `414b005c-802c-46f1-9e3f-cdb8f4c43f23` with two capture events and two stored
  artifacts. Forced worker analysis then wrote two
  `agent.artifact_attached` handoff events, marked
  `metadata.capture_artifact_analysis.status` as `ready`, queued one dispatch
  outbox row with a scoped callback, posted once to a fake Mesh endpoint, marked
  the outbox `applied`, and moved the work item to `agent_running`.
- Local compose proof on 2026-06-01: authenticated browser smoke session
  `794f44df-9178-47eb-a554-bf17f4ee1919` drove the actual `Record feedback` dock
  on the project takeoff canvas in Playwright against the real local API. It
  uploaded `audio`, `rrweb`, and `canvas_geometry`, recorded three capture
  events, finalized support packet `789eb991-6aa7-4f59-b1b6-b68de7307894` and
  context work item `6a43a259-fdfe-4d13-bfff-a2336fa235c7`, ran deterministic
  artifact analysis to `metadata.capture_artifact_analysis.status = ready`, and
  exported three artifact files for reviewer handoff. The same smoke also
  created discarded session `1a629483-1439-4741-888a-21a8c2c58f36` and verified
  it stayed terminal with zero artifacts.
- Mobile/tablet emulation proof on 2026-06-01: the same authenticated browser
  smoke passed under `AUTH_CAPTURE_SMOKE_PROJECTS=mobile` (`mobile-pixel-7`) and
  `AUTH_CAPTURE_SMOKE_PROJECTS=tablet` (`tablet-chromium-touch`) against the
  live local API. That proves stop/finalize plus discard on emulated mobile and
  tablet form factors, including the authenticated capture dock and takeoff
  canvas geometry provider. It is not a substitute for physical phone/tablet
  testing.

What is still missing is the closed user-facing capture loop beyond the first
public-portal audio/replay slice and the opt-in authenticated dock:

- no physical phone/tablet smoke of the authenticated `Record feedback` dock
  against the live API and worker analyzer yet. The desktop-browser live
  stop/finalize and discard smoke is green, and mobile/tablet browser emulation
  is now green for the same smoke path;
- no product decision on when authenticated feedback should become visible by
  default versus pilot/invite/query gated;
- no decision to enable `CAPTURE_AUTH_AUTO_DISPATCH=1` outside controlled smoke;
- no fuller authenticated consent sheet yet;
- no real-device proof of the IndexedDB replay path yet. The controller now
  queues start/upload/finalize across refresh/offline and shows a queued
  terminal state, but it still needs a device smoke against the live API/worker;
- no real-device smoke proving takeoff `canvas_geometry` uploads from a physical
  phone/tablet. The authenticated desktop-browser smoke now proves the project
  takeoff-canvas provider before finalization;
- no multimodal video analyzer yet. Frame/manifest packaging is now present, and
  capture exports now point the analyzer at local video when one exists, but
  Gemini/Antigravity review of those frame artifacts is still a separate lane.
  `npm run capture:review` now makes that lane one command, and
  `npm run capture:review-import` can attach the result back to the work item,
  but it still needs a real run over an actual video capture;
- no derived-artifact retention policy yet for future model-produced video
  summary artifacts. Raw artifacts, local-whisper transcripts, and frame
  manifests now use normal artifact rows;
- no native Capacitor path with ReplayKit/MediaProjection yet;
- no aggregate real-device smoke proving one phone/tablet session creates a
  session row, event rows, artifact rows, finalized support packet/context work
  item, Mesh trace event, exported capture-analyze corpus, and reviewable
  task/evidence. The scripted API smoke proves the
  API/storage/finalize/analyzer path, the authenticated browser smoke proves the
  live web recorder-to-export path including takeoff `canvas_geometry` plus
  discard, and the portal smoke proves public browser recorder behavior with
  mocked APIs. The missing part is still real device plus real Mesh.
- no capture-generated real Mesh dispatch smoke for the new analysis-ready
  bridge yet. The fake Mesh smoke proves Sitelayer queueing, dispatch POST,
  callback payload, `capture_session_id`, `capture_export`, outbox application,
  and local status movement. The live Control Plane task-create endpoint has
  accepted a safe no-auto preflight task, and the real-mode script now defaults
  to non-auto dispatch. What remains is running the capture-generated real-mode
  check, replaying the scoped callback against a running Sitelayer API, and
  doing DB-side verification after the `pg_hba.conf` access gap is fixed.
- no real Control Plane product-trace smoke yet. The local trace smoke proves
  Sitelayer's outbound forwarding shape and local durable forward-state row, and
  it now has a real prerequisite preflight plus an optional Control Plane DB
  verifier. A real run still needs a valid component secret, an active
  `capture_grants` row where `principal_id` equals
  `MESH_TRACE_HMAC_COMPONENT`, and verification that the ingested row proceeds
  into conformance and pending belief evidence.
- the `steve-demo` captured-feedback row is a deterministic fixture with a
  scenario transcript URI and analyzer-style handoff event. It is useful for
  demoing and querying the model, but it does not replace a live recording,
  storage-backed transcript, worker-run analysis, or Mesh ingest smoke.

Domain 1 is also not fully closed. Sitelayer can emit workflow traces and Mesh
can ingest `product_trace_events`. The current Control Plane dirty tree adds the
first `product_trace -> belief_evidence` review route, but it still needs
aggregate validation, migration review, and a live trace-to-review smoke.

## Pilot-readiness blockers that remain

> **Update 2026-06-01 — several of these have LANDED on `main`** (verified
> against the migrations/files cited): teammate invites
> (`docker/postgres/init/134_company_invites.sql`), the worker QBO pull lane
> (`135_qbo_pull_lane.sql`), RBAC custom roles (`136_custom_roles.sql`), and
> the PlanSwift assembly-explode + formula-evaluator engine
> (`109_assembly_explode_and_formulas.sql` + `110_seed_cladding_assemblies.sql`,
> `packages/domain/src/assembly.ts`, `packages/formula-evaluator/`). The
> PDFium-based blueprint render foundation has also landed
> (`apps/web/src/lib/pdf/renderer/`). The bullets below predate those merges —
> treat the invite / QBO-pull / custom-roles items as substantially addressed
> and re-scope to what still needs sandbox-smoke / live repro rather than
> greenfield build.

The current worktree improves many screens, but the founder walkthrough still
has real pilot walls:

- teammate invite is not fully solved unless the backend becomes a real
  email/phone invite and acceptance flow, not just a membership upsert; _(see
  2026-06-01 update — invite schema landed in migration 134; remaining work is
  the full email/phone accept loop, not the schema.)_
- new assignment visibility likely still has the `draft` vs active/confirmed
  mismatch;
- AI auto-takeoff 404 still needs live deployed repro with the exact failing
  URL and build SHA;
- QBO pull/backfill has moved toward partial inline sync, but it is not a
  sandbox-smoked, worker-backed loop; _(see 2026-06-01 update — the worker QBO
  pull lane landed in migration 135; remaining work is the sandbox smoke.)_
- roles/custom roles remain larger schema/API work; _(see 2026-06-01 update —
  custom-roles schema landed in migration 136.)_
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
5. Finish and prove C0/R0 usage capture: run the new capture-session smoke
   against dev/demo, then verify worker artifact analysis, local
   `mesh_trace_forward_state`, safe real Control Plane task creation, callback
   replay, and Mesh trace ingest for the same `capture_session_id`. The
   authenticated local browser-to-analyzer/export smoke is now green; the
   remaining C0/R0 proof is real Mesh trace ingest plus capture-generated real
   task dispatch with DB verification once Control Plane Postgres access allows
   it.
6. Then prove R1 user feedback capture on real devices: public portal
   audio/replay, opt-in authenticated `Record feedback`, takeoff canvas geometry,
   transcript, support packet, and one context work item.

## Where this sits in the ultimate plan

The current repo is strong on representation and weak on closure.

- Representation: increasingly real. Workflows, statecharts, design conformance,
  and replayable transitions exist and are being connected.
- Capture: the user-session object, artifact route, finalization path, and a
  first public-portal recorder plus opt-in authenticated recorder now exist in
  code. The authenticated browser recorder is live-smoked locally through
  artifact analysis and export, including project takeoff `canvas_geometry`.
  Canvas geometry state capture is wired for takeoff screens, but real
  phone/tablet smoke, pixel video, and the true end-to-end Mesh smoke are
  missing.
- Learning: partially wired in dirty Control Plane code; not yet proven live.
- Pilot: close enough to justify a stabilization push, not safe enough to treat
  as ready.

The next proof artifact should not be another synthesis doc. It should be one
real vertical slice: a user action creates a workflow event, the event joins a
capture/session id, the trace lands in Mesh, and a resulting context-rich task
or belief evidence row is created.
