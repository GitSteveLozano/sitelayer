# Capture Processing Pipeline — Multimodal Understanding & Event Reconciliation - 2026-06-04

Status: **DESIGN / working-through with dirty-checkout implementation notes.** Companion to
`FEEDBACK_ISSUE_BOARD_DECISION_2026-06-04.md` — that doc decided _where issues live_
(C: sitelayer-local behind the `IssueBoard` port); **this doc decides how raw
multimodal capture becomes an enriched, reconciled issue**, and where Gemini fits.

> **⚠️ STATUS CORRECTION (2026-06-04, verified against `main`):** the `request_ref`
> index this doc lists as a gap (§4.2) **already exists** in `main`
> (`000_baseline.sql:6148`), and the STT write-back machinery is built (just
> `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=off` by default). The processor-behind-interface
> design (§5–§6) stands. The verified remaining frontier + lane-disjoint plan live in
> **`CAPTURE_BOARD_EXECUTION_PLAN_2026-06-04.md`** — drive from there.

Scope: turning captured screen video, mic/audio, browser corpus, and event streams
into structured understanding (transcript + summary + issue enrichment) that
reconciles onto one work item, behind a swappable processor interface.

Decoupling axis held throughout (`~/notes/OPERATOR-INTENT.md`): processing output stays
**sitelayer-local** (company-scoped, RLS); the media processor (Gemini) is a
**swappable adapter behind an interface**, never baked into mesh; mesh remains ONE
subscriber/dispatch adapter; projectkit's `CONTRACT` stays emit/dispatch-only.

---

## 0. TL;DR — answering the three questions directly

1. **"Can we easily do speech-to-text?"** — **Yes, today, two ways.** A local
   `faster-whisper` server already runs on the fleet (`~/projects/voice-tools`, port
   **5678**, `large-v3`, GPU, $0); and the `gemini-video` CLI skill transcribes
   audio/video. Sitelayer's own worker can _already_ hit whisper — it's just
   **off by default** (`CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=off`). So STT is a
   config flip + a write-back, not a build.
2. **"How are we reconciling all these events?"** — Everything is keyed to the
   **`capture_session_id` spine**; `POST /finalize` collapses a session into **one**
   `context_work_item` + timeline, and that collapse is already idempotent. The real
   gaps are now narrower: the media-understanding seam exists in
   `capture-board-lanes` and has been replayed into the dirty top-level checkout,
   the operator cross-tenant board now exists in the dirty checkout, and the dirty
   checkout now has a local lost-callback reconciler that turns an acknowledged-but-
   silent dispatch into an explicit `agent.callback_missing` timeline event.
3. **"How might we use the Gemini API / Gemini-Antigravity CLI?"** — Behind one
   `MediaProcessor` interface with two adapters: **Gemini CLI (zero-cash, rides
   subscription)** for local/interactive understanding, and **Gemini API (explicit
   cash opt-in, structured JSON via `responseFormat`)** for headless/batchable
   understanding. Local whisper remains the STT path. Antigravity is a registered
   family but its canary is **not yet flipped** — treat as future adapter.

**The pipeline is no longer greenfield.** The media interface and worker hooks are
implemented in `capture-board-lanes` and replayed locally; the work is to validate
that slice, turn on the safe STT mode deliberately, and replay the dirty board stack
without widening branch drift.

---

## 1. The two layers of reality: captured vs understood

| Layer                       | State today                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Captured (stored)**       | ✅ Solid. Screen video / audio / browser corpus / events land as `capture_artifacts` (DO Spaces, `tor1`) + `capture_session_events`, keyed by `capture_session_id`, with `content_hash`, `duration_ms`, `pii_level`, `access_policy`, retention GC.                                                                           |
| **Understood (structured)** | ⚠️ Weak _in sitelayer_. On `finalize`, sitelayer records `artifact_count` but **reads no media content**. Audio STT exists but is `off` by default; video is `frames-only` (ffmpeg JPEG dump, **no VLM**). The rich media→action brain lives in the **host** `~/projects/capture` tooling, not the sitelayer/Spaces pipeline. |

The gap between these two layers is the whole subject of this doc.

---

## 2. What exists today (don't rebuild)

### 2.1 Speech-to-text — two working paths

- **Local faster-whisper (primary, $0).** `~/projects/voice-tools/lib/whisper-server.py`
  (`large-v3`, GPU, `POST /transcribe` + `/health` on **:5678**), unit
  `systemd/voice-tools-whisper.service`, config `config/voice-tools.env`. Clients
  `bin/vt-record`, `vt-stream`. This is the operator's day-to-day STT. Dockerized
  Sitelayer workers should only use `CAPTURE_ARTIFACT_WHISPER_URL=http://host.docker.internal:5678`
  on a host where Whisper is actually provisioned. For dev/prod droplets, audio
  STT is handled by the local GPU media worker described in
  `docs/CAPTURE_LOCAL_GPU_MEDIA_WORKER_DECISION_2026-06-04.md`;
  direct host workers can use `http://127.0.0.1:5678`.
- **Gemini CLI multimodal.** `gemini-video` skill (`~/.claude/skills/gemini-video/SKILL.md`,
  vendored in dotfiles) — `gemini -p "<prompt> @<file>"`, handles webm/mp4/mov +
  mp3/wav/aac/ogg/flac, ~1 fps. The "Claude can't read media → hand to Gemini" path.

### 2.2 Media capture + storage

- `~/projects/capture/bin/` (`capture-toggle`/`capture-agent`/`capture-stream`/
  `capture-session`/`capture-analyze`), `lib/capture_streams.py`, reaper bound
  `VT_CAPTURE_MAX_RECORD_SECONDS=3600`. Emits aligned `.mp4`/`.wav` + event corpus +
  narration transcript. The `c s/c w/c d/c z` leader bindings drive these.
- Sitelayer `capture_artifacts` (`docker/postgres/init/000_baseline.sql:692`) → DO
  Spaces (`DO_SPACES_*`); retention GC `apps/worker/src/runners/blueprint-storage-gc.ts`.

### 2.3 Existing processing (the brain is in the wrong place)

- **`~/projects/capture/bin/capture-analyze` already does media→tasks**: video →
  metered Gemini (`VT_CAPTURE_VIDEO_MODEL=gemini-3.1-flash-lite`, key
  `VT_CAPTURE_GEMINI_API_KEY`, cost-capped, kill-switch `VT_CAPTURE_VIDEO_API=0`) or
  sampled-frames+corpus → Claude (`VT_CAPTURE_CLAUDE_MODEL=claude-sonnet-4-6`), weaves
  the narration transcript in, extracts action items → `capture_action_executor` mesh
  tasks. **This is the reference algorithm to lift behind the interface.**
- **Sitelayer worker is the weak version**: `apps/worker/src/runners/capture-artifact-analysis.ts`
  — text/json → deterministic `agent.artifact_attached`; audio only if
  `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=local-whisper` (default **`off`**,
  `local-whisper-v1`, hits `CAPTURE_ARTIFACT_WHISPER_URL`); video `frames-only` =
  JPEG dump, no understanding.

### 2.4 Gemini access + routing

- **Keys** (metered cash) in `~/.env.local`: `GOOGLE_API_KEY`, `GEMINI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`.
- **REST scaffold** `mesh/scripts/gemini_research.py` — `generateContent`, reads keys,
  deposits + costs tokens, **text-only** (no `inline_data`/`fileData`), **disabled
  unless `MESH_ENABLE_GEMINI_API=1`** (`gemini_direct_api_disabled()`). Rate table
  `:161` (pro $2.50/$15, flash-lite $0.10/$0.40 per Mtok).
- **CLI rides subscription, not cash**: launch scripts `unset GEMINI_API_KEY
GOOGLE_API_KEY` (`mesh-worker-client/runners.go:791`); subscription Gemini 3 only via
  Auto-picker (no `-m`), translated at the CLI boundary
  (`mesh/core/gemini_cli_llm_adapter.go` — `subscriptionSafeGeminiCLIModelArg`).
  Scheduler routes `Tool="gemini"` runners (`runner_orchestrator.go:84-87`,
  `agent-runner.sh:429`).
- **Antigravity**: registered family (`policy_fleet_plan.go:52`, `review_questions.go:43`),
  configs at `~/.gemini/antigravity-cli/`, `~/.antigravity/`, but the canary is **not
  flipped** (`agent-cli-daily-upkeep.sh:680`: add a `Tool=antigravity` runner before
  `MESH_GEMINI_FAMILY_ALIAS=antigravity`). Future adapter, not v1.

---

## 3. Event reconciliation — the `capture_session_id` spine

Two stores: **sitelayer Postgres owns the issue** (RLS, company-scoped); **mesh holds
opaque mirrors** (`product_trace_events` mig 320, `contract_version` mig 325).

```
                         capture_sessions.id  ◀── THE SPINE (uuid)
                                 │
       ┌─────────────────┬───────┴────────┬──────────────────────┐
 capture_session_events  capture_artifacts   (consent fields)   product_trace_events
 (raw; dedupe:           (media: STT/VLM input;                  (mesh mirror; dedupe:
  client_event_id)        content_hash, duration_ms)              event_ref)
                                 │
                  POST /api/capture-sessions/:id/finalize  ── ONE issue per FINALIZED episode
                                 │
        ┌────────────────────────┼───────────────────────────┐
 support_debug_packet      context_work_item            context_handoff_event
 (evidence, 1:1)      (THE issue; capture_session_id,   (work_item.created; idem-key
                      support_packet_id; status/lane)    capture_session:finalize:<id>:work_item_created)
                                 │
              mutation_outbox(dispatch_mesh_work_request) ── only on operator/flag promote
                                 │  HttpDispatchAdapter (mesh = one URL)
                                 ▼
                    mesh Concern ─► mesh executes ─► Callback (keyed concern_ref)
                                 │
                    POST agent callback ─► context_handoff_event(agent.*)  (back on timeline)
```

**Idempotency, where it lives (already correct):**

- Finalize pre-checks `(company_id, capture_session_id, source='capture_session_finalize')`
  → `idempotent_replay:true` (`capture-sessions.ts:206,1001`); handoff idem-key
  `capture_session:finalize:<id>:work_item_created` (`:1145`); unique-violation race
  re-reads the existing item (`:1184`).
- Handoff events: `(company_id, idempotency_key) ON CONFLICT DO NOTHING`
  (`context-handoff.ts:397`). Raw events dedupe on `client_event_id`. Dispatch/callback
  dedupe on per-work-item idem-keys (`context-work-dispatch.ts:108,149`).

**Source of truth for issue state = `context_work_items` (sitelayer).** Mesh never owns it.

---

## 4. The reconciliation gaps (the issues to work through)

1. **Media is counted, not understood.** `finalize` records `artifact_count`
   (`capture-sessions.ts:1110`) but nothing reads `capture_artifacts` content. Audio/
   video sit unprocessed; no transcript/understanding reconciles onto the issue.
   → **Fixed by §5–§6 (the processing runner).**
2. **Producer-stable `request_ref` index.** Done. Inbound `WorkRequest`/
   `CaptureEnvelope` producers can dedupe by `(company_id, metadata->>'request_ref')`
   via `context_work_items_request_ref_uidx`. The remaining risk is using the field
   consistently from every producer, not adding storage support.
3. **Two-store split → callback timeline gap.** A mesh `Callback` only lands as a
   `context_handoff_event(agent.*)` via the callback route. The dirty checkout now has
   a local deadline reconciler: if `agent.dispatch_acknowledged` has no later callback,
   the worker appends `agent.callback_missing`, moves the item to `proposal_expired`,
   and emits a best-effort mesh obstruction observation. It does not recover a completed
   proposal body from mesh; that remains a future re-delivery/retry enhancement.
4. **Mesh-detected failures don't open a sitelayer issue.** Flow-conformance / product-
   trace anomalies live mesh-side; there's no inbound create path back into
   `context_work_items`. In-progress sessions that emit beacon events but never finalize
   produce no issue (correct by design), but genuine mesh-detected problems have no door
   home. → **Define a guarded inbound create** (mesh subscriber emits a `WorkRequest`;
   sitelayer ingests via `/api/signal`-style route → `createFromCapture`-equivalent),
   gated and rate-limited; defer unless needed.

---

## 5. The `MediaProcessor` interface — the swappable seam

A single interface hides which engine processes media; adapters are swappable so the
One-Line Boundary Test holds (swap the processor, the issue/timeline shapes don't change).

```
MediaProcessor (sitelayer-local port):
  transcribe(artifact: {uri, content_type, duration_ms}) -> { text, segments?, lang? }
  understand(artifacts[], context: {events, transcript}) ->
        { summary, suggested_title, suggested_severity, action_items[], confidence }

Adapters:
  LocalWhisperProcessor   -> POST :5678/transcribe        (STT, $0, default for audio)
  GeminiApiProcessor      -> generateContent(responseFormat) with sampled inline frames
                                                          (opt-in cash path; headless, structured JSON)
  GeminiCliProcessor      -> `gemini -p "@file"` (gemini-video skill)
                                                          (default opt-in; zero-cash, rides subscription; local-disk files only)
  AntigravityProcessor    -> (future; family registered, canary not flipped)
```

- The processing runner imports **only the interface**, never a vendor SDK or `:5678`
  directly — same discipline as the `IssueBoard` port.
- **STT** → local whisper mode when explicitly enabled (free, already running).
  **Understanding/VLM** → `GeminiCliProcessor` when using the operator subscription
  locally; `GeminiApiProcessor` only when the cash API gate and key are explicitly
  enabled. The API adapter uses structured JSON via `responseFormat`, not prose.
- Lift the **`capture-analyze` algorithm** (transcript-as-first-class-stream +
  action-item extraction) into `understand()` rather than re-inventing it.

---

## 6. Where processing runs — a sitelayer worker runner keyed by `capture_session_id`

**Precedent exists and is the exact shape:** `apps/worker/src/runners/voice-to-log.ts`
already drains `mutation_outbox` by `mutation_type` via `drainAgentMutations`, calls a
model gated by env (`VOICE_TO_LOG_MODE=live` + key), and falls back to a deterministic
stub otherwise. Mirror it.

The current implementation from `capture-board-lanes`, now replayed locally, extends the existing
`capture-artifact-analysis` runner instead of creating a second queue:

```
finalize
   └─ creates one context_work_item with metadata.source='capture_session_finalize'

capture-artifact-analysis runner:
   1. reads eligible capture_artifacts for finalized work items
   2. local whisper transcribes audio when CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=local-whisper
   3. ffmpeg samples video frames when CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE=frames-only|gemini
   4. MediaProcessor.understand(transcript and/or sampled frames) runs when MEDIA_UNDERSTANDING_ENGINE is enabled
   5. writes derived artifacts + agent.artifact_attached handoff events inside the company tx
   6. marks capture_artifact_analysis readiness and can optionally enqueue mesh dispatch
```

**Why a sitelayer worker step and not a mesh concern:** STT/VLM output is company-scoped
customer media that must stay behind RLS. Routing it through mesh would re-acquire
ownership of the testbed's data (the forbidden inversion). Mesh stays subscriber-only —
it sees the issue **after** promotion as a dispatched `Concern` and returns a `Callback`.
Multimodal _understanding_ is a sitelayer-internal enrichment step, off the wire. A
separate "processing lane" is over-engineering: the outbox+runner already _is_ a lane
keyed by `capture_session_id`, with retry/lease semantics.

**Default safety:** keep analysis modes gated. Audio and video analysis default off;
`MEDIA_UNDERSTANDING_ENGINE=off` is inert, `stub` is deterministic, `gemini-cli` is
subscription-backed, and `gemini-api` remains null unless the explicit cash gate and
key are present.

---

## 7. Cost / quota / safety posture (Gemini)

Per `~/CLAUDE.md` rules 3/4/7 — the operator is cash-constrained:

- **Default to subscription, not cash.** The fleet deliberately unsets API keys so the
  CLI rides OAuth subscription. The cash REST path (`gemini_research.py`) is opt-in
  (`MESH_ENABLE_GEMINI_API=1`). For sitelayer media: `LocalWhisperProcessor` is $0;
  `GeminiCliProcessor` is subscription-$0; `GeminiApiProcessor` spends cash —
  flash-lite is ~$0.10/Mtok (cheap for occasional captures) but **confirm with operator
  before enabling at volume**.
- **Model-id trap (rule 4):** bare `gemini-3-pro` 404s on the cash API; subscription
  Gemini 3 needs no `-m`. Pin via the existing `gemini_cli_llm_adapter.go` translation.
- **Don't run heavy media inline in a periodic tick** — there's no per-tick scheduler
  timeout (a hung tick wedges the scheduler). Keep STT/VLM inside the bounded worker
  runner path, never on the scheduler's inline path.
- **Known flakiness:** Gemini research deposits see 503 / runner stalls and the
  `print`-arg bug; batch via the runner pool inherits that — make the runner retry-safe
  (idempotent by `capture_session_id`) and bounded.
- **CLI ~1 fps:** long video = high token/latency cost; prefer audio-first STT + sampled
  frames (as `capture-analyze` already does) over full-video inference.

---

## 8. End-to-end flow (target)

```
operator/Steve/tenant captures  ─►  capture_sessions + capture_artifacts (Spaces) + events
        │                                         (the /api/signal beacon mirrors low-PII traces out via projectkit HttpSink — telemetry only)
        ▼
   POST /finalize  ─►  ONE context_work_item (issue) + support_debug_packet + timeline
        ▼
   capture-artifact-analysis runner ─► local whisper + MediaProcessor.understand
        │                              (CLI subscription by default when enabled; API cash path gated)
        ▼
   write back (RLS tx): transcript artifact + handoff event + enrich issue
        │
        ▼
   issue now has: video/audio + transcript + summary + suggested title/severity + action items
        │
        ▼  (operator/flag promote only)
   DispatchAdapter ─► mesh Concern ─► Callback ─► timeline   (mesh = one swappable subscriber)
```

The board (decision doc) renders the enriched issue; processing is what makes the card
worth triaging instead of "a video nobody watched."

---

## 9. Open questions / risks (for the operator)

1. **Default engine per modality** — confirm: audio → whisper ($0), understanding →
   Gemini API (cash, capped) vs Gemini CLI (subscription)? Recommend whisper-default +
   CLI-understand for v1 ($0), API-understand when batch/headless is needed.
2. **Turn-on scope** — flip `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE` to `local-whisper`
   now (cheap win, STT today), then validate the replayed `MediaProcessor` hooks
   for VLM understanding.
3. **PII / consent** — `capture_artifacts.pii_level`/`access_policy` exist; confirm the
   transcript inherits the parent's `pii_level` and that media leaving to the Gemini API
   respects consent (the capture-ladder consent contract). Subscription-CLI keeps data
   off the cash API but still sends it to Google — operator call.
4. **Antigravity** — flip the canary (add a `Tool=antigravity` runner) only after v1;
   it's an adapter swap, not a v1 dependency.
5. **Mesh result recovery after lost callbacks (optional)** — the local deadline
   reconciler is built. If we later need automatic recovery of completed proposal bodies,
   add a Mesh read/re-delivery path rather than overloading the local stale sweep.

---

## 10. Build slice (NOT NOW — for when greenlit)

Ordered, lane-disjoint:

1. **STT quick win:** flip audio analysis to `local-whisper`, write transcript back as a
   `capture_artifact` + handoff event. (`capture-artifact-analysis.ts`, voice-to-log
   precedent.)
2. **Validate replayed media seam:** `apps/worker/src/media/*` plus the
   `capture-artifact-analysis.ts` understanding hooks and tests.
3. **Reconciliation fixes:** local lost-callback deadline reconciler is built in the
   dirty checkout; optional Mesh re-delivery is deferred.
4. **(Defer)** mesh→sitelayer inbound create for flow-conformance failures (§4.4);
   Antigravity adapter; Gemini API batch/file-upload extension if inline sampled frames
   are not enough.

---

## Source map (verified paths)

- STT: `~/projects/voice-tools/lib/whisper-server.py` (:5678), `systemd/voice-tools-whisper.service`, `config/voice-tools.env`, `bin/vt-record`/`vt-stream`; same-host Docker workers can use `http://host.docker.internal:5678`, while dev/prod use the local GPU media-worker path.
- Media capture brain: `~/projects/capture/bin/capture-analyze` (`VT_CAPTURE_VIDEO_MODEL=gemini-3.1-flash-lite`, `VT_CAPTURE_VIDEO_API`, `VT_CAPTURE_CLAUDE_MODEL`), `lib/capture_streams.py`
- Gemini CLI: `~/.claude/skills/gemini-video/SKILL.md`
- Sitelayer weak processor: `apps/worker/src/runners/capture-artifact-analysis.ts` (`CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE`)
- Precedent runner: `apps/worker/src/runners/voice-to-log.ts` (`mutation_outbox`/`drainAgentMutations`/`VOICE_TO_LOG_MODE`)
- Schema: `docker/postgres/init/000_baseline.sql` — `capture_artifacts` (:692), `capture_session_events` (:719), `capture_sessions` (:749), `context_handoff_events` (:1228), `context_work_items` (:1262), `support_debug_packets` (:3082); `120_capture_sessions.sql`
- Finalize/reconcile: `apps/api/src/routes/capture-sessions.ts` (:206,:1001,:1110,:1145,:1184), `apps/api/src/context-handoff.ts` (:8,:24,:397), `apps/worker/src/runners/context-work-dispatch.ts` (:108,:149), `apps/api/src/routes/work-requests.ts` (:1731)
- Gemini API/routing (mesh): `mesh/scripts/gemini_research.py` (REST, `MESH_ENABLE_GEMINI_API`, rates :161), `mesh/core/gemini_cli_llm_adapter.go`, `mesh/core/runner_orchestrator.go:84-87`, `mesh/scripts/agent-runner.sh:429`, `mesh-worker-client/runners.go:791`; Antigravity: `policy_fleet_plan.go:52`, `review_questions.go:43`, `agent-cli-daily-upkeep.sh:680`; keys `~/.env.local`; posture `~/CLAUDE.md` rules 3/4/7
- Storage/GC: `apps/worker/src/runners/blueprint-storage-gc.ts` (`DO_SPACES_*`, `tor1`)
- In-flight seam: `sitelayer-worktrees/seam-sl-telemetry/apps/api/src/routes/signal.ts`, `apps/worker/src/runners/mesh-trace-forward.ts`
- Contract: `~/projects/projectkit/CONTRACT.md` (v1.3.0); mesh subscriber mirror `control-plane/mesh/core/contracts/projectkit/README.md`
- Companion: `docs/FEEDBACK_ISSUE_BOARD_DECISION_2026-06-04.md`
