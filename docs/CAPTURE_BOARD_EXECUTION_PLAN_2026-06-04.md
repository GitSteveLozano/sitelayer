# Capture → Issue Board + Multimodal Processing — Execution Plan - 2026-06-04

Status: **EXECUTION PLAN (verified against `main`).** Synthesizes the two companion
decision docs into a dependency-ordered, lane-disjoint plan — but **re-grounded by
reading the actual code**, which materially contradicts both docs' "what's missing"
claims. Read this before driving any board/processing work; it supersedes the
"Build slice" sections of:
- `FEEDBACK_ISSUE_BOARD_DECISION_2026-06-04.md` (§11)
- `CAPTURE_PROCESSING_PIPELINE_2026-06-04.md` (§10)

> Correction, 2026-06-04 17:50 UTC: a fresh `origin/main` check showed the
> board substrate was **not** in `origin/main`. The board pieces existed in the
> dirty current checkout / preservation work and have now been replayed into
> `capture-board-lanes` and `dev-land`: `/api/work-requests/board`,
> `/api/work-requests/:id/move`, `context_work_items_request_ref_uidx`, the web
> `issue-board` port, mobile `/work/board`, and the platform-admin `/admin`
> Issues tab. Treat the older "already shipped in main" wording below as stale
> historical analysis, not the current branch truth.

---

## 0. Headline — most of the board feature is already shipped in `main`

The companion docs were written as if the kanban board were net-new behind a port to
be built. **It is not.** It landed in `main` as commit
`d2767daf feat(work-dispatch): context-handoff substrate + work-request API + worker
dispatch runner`. Verified by reading the tree on `origin/main`
(`32584aba`, current HEAD):

- The **`IssueBoard` port the decision doc proposed as NEW (§4.1) already exists** —
  `apps/web/src/lib/api/issue-board.ts`: `fetchIssueBoard`, `fetchIssueBoardItem`,
  `moveIssueBoardItem`, `useIssueBoard`/`useIssueBoardItem`/`useMoveIssueBoardItem`,
  with `IssueBoardScope = 'company' | 'cross-tenant'`, filters, and column types.
- The **tenant board UI exists** — `apps/web/src/screens/mobile/issue-board.tsx`
  (246 lines), mounted via `apps/web/src/screens/mobile-shell.tsx`, reachable at
  `/work/board`, gated `canTriage`, with a status_group/lane groupBy toggle, status +
  severity pills, and move-via-select. The nav button is live
  (`screens/mobile/work-requests.tsx:94`).
- The **`move` endpoint exists** — `moveWorkRequest` (`work-requests.ts:1608`, routed
  `POST /api/work-requests/:id/move` at `:2497`): status/lane/assignee, optimistic
  `updated_at` guard, 409 on conflict / on terminal item. The decision doc called this
  "the only net-new backend operation." It isn't net-new.
- The **column-shaped read exists** — `GET /api/work-requests/board` →
  `listWorkRequestBoard` (`:1202`) → `buildWorkRequestBoardColumns` (`:410`),
  `groupBy=status_group|lane`. The 4 status columns (`STATUS_BOARD_COLUMNS`, `:383`)
  are **richer than the doc's proposed §8 mapping**:
  New `[new]` · Triaged `[triaged, human_assigned, reopened]` ·
  In Progress `[agent_running, review_ready, review_stale, proposal_expired]` ·
  Done `[resolved, wont_do, reversed]`.
- The **`request_ref` idempotency index exists** —
  `context_work_items_request_ref_uidx` (`000_baseline.sql:6148`), exactly
  `UNIQUE (company_id, (metadata->>'request_ref')) WHERE request_ref IS NOT NULL`.
  **Both** docs listed adding this as an open gap. It's already there.
- The **telemetry/dispatch seam already landed** — `origin/main` HEAD **is**
  `seam-sl-telemetry`'s HEAD (`32584aba`); `apps/api/src/routes/signal.ts` is in
  `origin/main`. The "in-flight seam worktree #1" is merged; that worktree is just
  sitting at `main`.
- **Dispatch-promote exists** — `dispatchWorkRequestToMesh` /
  `retryWorkRequestMeshDispatch` in the web client; `POST .../dispatch` routes server-side.

**Net:** the decision doc's build slice items 1 (backend move/list/index), 2 (tenant
board UI), 4 (card deep-link via brief/handoff-packet endpoints), and 5
(dispatch-promote) are **DONE**. Do not rebuild them — rebuilding shipped substrate is
the exact drift to avoid.

---

## 1. Verified state — DONE vs the real frontier

| Item (from companion docs) | Verified status | Proof |
| --- | --- | --- |
| `context_work_items` kanban entity | ✅ DONE | `000_baseline.sql:1262` |
| Capture→issue at `/finalize` | ✅ DONE | `capture-sessions.ts` finalize |
| `move` endpoint (status/lane/assignee, optimistic, 409) | ✅ DONE | `work-requests.ts:1608`, route `:2497` |
| Column-shaped board read (`groupBy`) | ✅ DONE | `work-requests.ts:1202,410,383` |
| `request_ref` unique index | ✅ DONE | `000_baseline.sql:6148` |
| `IssueBoard` port (web client) | ✅ DONE | `apps/web/src/lib/api/issue-board.ts` |
| Tenant board UI (`/work/board`, canTriage) | ✅ DONE | `screens/mobile/issue-board.tsx` + `mobile-shell.tsx` |
| `/api/signal` ingest seam + projectkit adopt | ✅ DONE (in `main`) | `signal.ts` in `origin/main` |
| Dispatch-promote to mesh | ✅ DONE | `dispatchWorkRequestToMesh`, route `:2503` |
| STT path (audio→whisper write-back) | 🟡 PARTIAL — built but **default `off`** | `capture-artifact-analysis.ts:138` (`AUDIO_ANALYSIS_MODES=['off','local-whisper']`) |
| **Operator cross-tenant board** | ✅ DONE in dirty checkout | `apps/api/src/routes/admin-work-requests.ts`, `/api/admin/work-requests/board`, `apps/web/src/lib/api/admin-issue-board.ts`, `/admin` `Issues` tab |
| **Media understanding seam** | ✅ DONE and replayed to this dirty checkout | `apps/worker/src/media/*` + `capture-artifact-analysis.ts` integration |
| **Lost-callback reconciler** | ✅ DONE in dirty checkout | `apps/worker/src/runners/work-dispatch-reconciler.ts`, `agent.callback_missing` timeline event |

So the **real remaining frontier is the STT config/verification lane**, not the ~10 slices the docs imply.

---

## 2. The real lanes

- **L1 — Operator cross-tenant admin board.** Done in the dirty checkout. The
  endpoint is `/api/admin/work-requests/board`, implemented in
  `apps/api/src/routes/admin-work-requests.ts` and gated by
  `authorizePlatformAdmin`. The admin client lives in
  `apps/web/src/lib/api/admin-issue-board.ts`, and `/admin` now has an `Issues`
  tab. Keep this platform-admin-only; do not relax company RLS.

- **L2 — STT quick win.** Flip `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE` `off→local-whisper`
  so finalized audio artifacts transcribe via the already-running fleet whisper
  (`:5678`, `$0`) and the transcript reconciles onto the issue. For Docker workers,
  use `CAPTURE_ARTIFACT_WHISPER_URL=http://host.docker.internal:5678`; for a direct
  host worker, `http://127.0.0.1:5678` is fine. The write-back
  machinery (`refreshAnalysisReadiness`, finalized-work-item sweep) already exists in
  `capture-artifact-analysis.ts`; this is config + a verify, not a build. **Cheapest
  win; do first.**

- **L3 — Multimodal understanding.** Done. Implemented in the main-aligned
  `capture-board-lanes` worktree and now replayed into the dirty checkout as a
  worker-local `MediaProcessor` seam:
  `gemini-cli` subscription path, explicitly gated `gemini-api` cash path, and
  deterministic `stub`, all feeding the existing `capture-artifact-analysis`
  runner. Do not build a separate runner unless the queue/lifecycle pressure later
  proves the inline analysis runner is too coupled.

- **L4 — Lost-callback reconciler.** Done. A worker-local sweep runs under the existing
  `work_request_stale` lane before the generic stale sweep. It detects
  `agent.dispatch_acknowledged` rows with no later callback event, appends
  `agent.callback_missing`, moves the work item to `proposal_expired`, and emits a
  best-effort mesh `work_item_obstructed` observation. No schema change.

Dropped from the docs' lists (already done): the `request_ref` index, the move
endpoint, the board read, the IssueBoard port, the tenant board UI.

---

## 3. Lane-disjointness — proven file footprints

Verified the two "in-flight" worktrees so lanes don't collide:
- `seam-sl-telemetry`: **0 diff vs `origin/main`** — merged. Not a constraint.
- `b-sitelayer` (`agent/claude/b-sitelayer`): touches **only** `Dockerfile`,
  `apps/worker/package.json`, `apps/worker/src/runners/mesh-trace-forward.{ts,test.ts}`,
  the vendored projectkit `.tgz`, `package-lock.json`. Disjoint from every lane below.

| Lane | Primary files (disjoint) | Migration? | Collides with |
| --- | --- | --- | --- |
| **L1 cross-tenant board** | `apps/api/src/routes/admin-work-requests.ts`, `apps/web/src/lib/api/admin-issue-board.ts`, `apps/web/src/routes/admin.tsx` | No | done in dirty checkout |
| **L2 STT flip** | env (`CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE`) + verify in `apps/worker/src/runners/capture-artifact-analysis.ts` | No | none |
| **L3 media understanding** | `apps/worker/src/media/*` + `apps/worker/src/runners/capture-artifact-analysis.ts`; replayed to dirty checkout | No | worker analysis runner only |
| **L4 reconciler** | `apps/worker/src/runners/work-dispatch-reconciler.ts`, `apps/worker/src/worker.ts`, event labels/types | No | built in dirty checkout |

L1 touches `admin-work-requests.ts`, `admin-issue-board.ts`, and `admin.tsx`;
L3/L4 are worker-only, and L2 is config. **No two active lanes write the same file.**
The remaining lanes are migration-free (the one migration the docs wanted —
`request_ref` — already exists).

---

## 4. Dependency order + verdicts

```
L2 (STT flip) ──────────────► independent, $0, safe-now              GO
L4 (reconciler) ────────────► built in dirty checkout                 DONE
L1 cross-tenant board ─────► built in dirty checkout                 DONE
L3 MediaProcessor seam ────► replayed to dirty checkout, default off DONE
```

- **L2 — GO.** Config flip + verify; whisper is free and already running. No approval
  needed (no cost, no schema, no prod-data risk beyond the existing opt-in posture).
- **L1 — DONE.** Reads through the platform-admin gate only. No schema change.
- **L4 — DONE.** Sitelayer-side deadline sweep; mesh stays subscriber. Bound +
  idempotent by `work_item_id` plus `mesh_task_id` when present.
- **L3 — DONE-WITH-CONFIRM.** The seam is built and replayed locally. Cost posture
  remains the gate: `MEDIA_UNDERSTANDING_ENGINE=gemini-cli` rides the operator subscription,
  `MEDIA_UNDERSTANDING_ENGINE=gemini-api` is inert unless
  `MEDIA_UNDERSTANDING_GEMINI_API_ENABLED=1` and a key are present, and the default
  remains `off`. Do not enable the cash path at volume without an explicit operator
  OK.

---

## 5. agentcell mapping (manual, lane-disjoint — per OPERATOR-INTENT)

Current lane-disjoint manual agents, matching the operator's A/B/C model (not autonomous
throughput):

- **Lane A — operator board hardening.** Built in the dirty checkout; remaining work is
  verification, polish, and deciding whether to replay it into `capture-board-lanes`.
- **Lane B — multimodal processing.** Validate the replayed `MediaProcessor` seam and
  decide whether to flip STT on for the target environment. Worker-only files.
- **Lane C — reconciliation hardening (L4).** Built in the dirty checkout; worker-only.

A/B/C wrote mostly disjoint files (A: `admin.*`+`issue-board.ts` client; B: worker
analysis + new media; C: worker reconciler plus shared event label/type) → safe to
replay as narrow patches, but do not merge raw branch stacks.

**Recommended first move:** Lane B's **L2 STT flip** — it's a config change + a verify,
free, and turns "a video nobody watched" into a transcript on the card today. It also
de-risks L3 by proving the whisper adapter end-to-end before the interface work.

---

## 6. What NOT to do (guardrails)

- **Do not rebuild** the move endpoint, board read, IssueBoard port, tenant board UI,
  `request_ref` index, or the `/api/signal` seam — all shipped in `main`.
- **Do not add an issue read/mutate surface to projectkit's `CONTRACT`** — it stays
  emit/dispatch-only; the issue store stays sitelayer-local. That's how the general
  problem stays deferred.
- **Do not relax `company_isolation` RLS** for the operator board — go through the
  existing platform-admin grant path only.
- **Do not route STT/VLM through mesh** — that re-acquires ownership of the testbed's
  data (the forbidden inversion). Mesh stays a subscriber; multimodal understanding is a
  sitelayer-internal enrichment step off the wire.
- **Do not enable the Gemini cash API at volume without an explicit operator OK** —
  whisper + CLI are the $0 defaults.

---

## 7. Doc reconciliation

The two companion docs keep their architecture decisions (C; processor-behind-interface)
— those are correct. Only their **"what's missing"/"build slice" framing is stale**.
A `STATUS CORRECTION` banner has been added to the top of each pointing here, so the
"add the index / build the move endpoint / build the port" lines don't re-trigger
rebuild work.

---

## Source map (verified on `origin/main` 32584aba)

- Board backend: `apps/api/src/routes/work-requests.ts` — `moveWorkRequest` :1608 (route
  :2497), `listWorkRequestBoard` :1202, `buildWorkRequestBoardColumns` :410,
  `STATUS_BOARD_COLUMNS` :383
- Board client/port: `apps/web/src/lib/api/issue-board.ts` (cross-tenant reject :131)
- Tenant board UI: `apps/web/src/screens/mobile/issue-board.tsx`,
  `apps/web/src/screens/mobile-shell.tsx`, nav `screens/mobile/work-requests.tsx:94`
- request_ref index: `docker/postgres/init/000_baseline.sql:6148`
- Cross-tenant pattern to copy: `apps/api/src/routes/admin.ts` (`/api/admin/companies`),
  `apps/api/src/routes/admin-jobs.ts`; admin tabs `apps/web/src/routes/admin.tsx:559`
- STT: `apps/worker/src/runners/capture-artifact-analysis.ts:138`
  (`CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE` default `off`), whisper `:5678`
  via `host.docker.internal` from Docker
- Multimodal precedent: `apps/worker/src/runners/voice-to-log.ts`;
  algorithm `~/projects/capture/bin/capture-analyze`
- Seam (landed): `apps/api/src/routes/signal.ts` in `origin/main`
- In-flight: `.worktrees/b-sitelayer` (mesh-trace-forward only); `seam-sl-telemetry`
  (== main, merged)
- Companion docs: `FEEDBACK_ISSUE_BOARD_DECISION_2026-06-04.md`,
  `CAPTURE_PROCESSING_PIPELINE_2026-06-04.md`
