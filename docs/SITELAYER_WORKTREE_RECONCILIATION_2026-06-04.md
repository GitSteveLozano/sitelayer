# Sitelayer Worktree Reconciliation - 2026-06-04

This is the working reconciliation snapshot for the feedback capture / issue-board work on June 4, 2026.

## Snapshot

- Current checkout: `/home/taylorsando/projects/sitelayer`
  - Branch: `agent/claude/dev-blueprint-seed-and-company-switcher`
  - Git note: this checkout has `core.bare=true`; use `git --git-dir=sitelayer/.git --work-tree=sitelayer ...` from `/home/taylorsando/projects` for truthful status/diffs.
  - Upstream-equivalent ref: `origin/dev`
  - Divergence from `origin/main`: 3 commits on `origin/main`, 3 commits on this branch.
  - Current uncommitted layer includes the issue-board API/UI slice plus broader capture WIP that predated this pass.
- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes`
  - Branch: `agent/claude/capture-board-lanes`
  - Main-aligned replay target, now dirty with the worker trace/media fixes and the narrow web state-provider replay.
  - This is the lowest-drift target if the current patch stack needs to be replayed away from `origin/dev`.
- `/home/taylorsando/projects/sitelayer-worktrees/dev-land`
  - Branch: `dev`
  - Integrated replay candidate, ahead of `origin/dev` by the media-understanding merge and the same semantic replay stack as `capture-board-lanes`.
  - Keep it aligned with `capture-board-lanes` for clean slices, but do not depend on it for verification until its local web/worker dependencies are installed again.
- `/home/taylorsando/projects/sitelayer-worktrees/seam-sl-telemetry`
  - Branch: `agent/claude/seam-sitelayer-telemetry`
  - Clean and one commit behind `origin/main`.
  - The telemetry seam work is already represented in `origin/main` by the projectkit telemetry commits; only the deploy-copy commit is newer.
- `/home/taylorsando/projects/.worktrees/b-sitelayer`
  - Branch: `agent/claude/b-sitelayer`
  - Clean, ahead 1 / behind 7 relative to `origin/main`.
  - Its lone commit overlaps the newer projectkit telemetry path already in `origin/main`. Do not merge it raw.

## Reconciliation Matrix

| Slice                                              | Canonical source                                     | Current checkout            | `capture-board-lanes`          | `dev-land`          | Action                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------- | --------------------------- | ------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projectkit trace/observation sinks + `/api/signal` | `origin/main` plus semantic tests from `b-sitelayer` | Replayed                    | Replayed                       | Replayed            | Done; do not merge `b-sitelayer` raw.                                                                                                                            |
| Media understanding + Gemini REST fix              | `capture-board-lanes`                                | Replayed                    | Canonical clean implementation | Replayed            | Done; default remains off.                                                                                                                                       |
| Lost-callback reconciler                           | Current checkout                                     | Replayed                    | Replayed                       | Replayed            | Done; verified in `capture-board-lanes`.                                                                                                                         |
| Capture/STT Docker env plumbing                    | Current checkout                                     | Replayed                    | Replayed                       | Replayed            | Done; verify target deployment before enabling STT.                                                                                                              |
| Shared route state-provider registry               | Current checkout                                     | Replayed                    | Replayed                       | Replayed            | Done for takeoff, estimate builder, project detail, and estimate review.                                                                                         |
| Work-request list `lane` filter                    | Current checkout                                     | Present                     | Replayed 2026-06-04            | Replayed 2026-06-04 | Done; API/web typecheck passed in `capture-board-lanes`.                                                                                                         |
| Tenant issue-board substrate                       | Current checkout                                     | Canonical WIP               | Replayed 2026-06-04            | Replayed 2026-06-04 | Done; includes `/api/work-requests/board`, `/move`, web port, mobile `/work/board`.                                                                              |
| Operator cross-tenant issue board                  | Current checkout                                     | Canonical WIP               | Replayed 2026-06-04            | Replayed 2026-06-04 | Done; includes platform-admin API route, admin client, `/admin` Issues tab, RLS lint exception.                                                                  |
| `request_ref` create-route dedupe                  | Current checkout                                     | Canonical WIP               | Replayed 2026-06-04            | Replayed 2026-06-04 | Done; includes route logic, tests, client create-input field, and `context_work_items_request_ref_uidx` without unrelated feedback-invite schema.                |
| Steve authenticated text/screen feedback dock      | Current checkout                                     | Canonical WIP               | Replayed 2026-06-04            | Replayed 2026-06-04 | Done; includes `/collab/steve`, Steve-aware global dock mount, text issue prewarm/submit, screen recording, smoke test script.                                   |
| Public feedback invite token surface               | Current checkout                                     | Canonical WIP               | Replayed 2026-06-04            | Replayed 2026-06-04 | Done; includes API token/admin/public capture routes, feedback_invites schema, `/feedback`, settings link management, portal state/audio/screen capture helpers. |
| `rescue-loose-board`                               | Preservation snapshot                                | Older than current checkout | N/A                            | N/A                 | Do not cherry-pick raw; use only if current dirty WIP is lost.                                                                                                   |

Reconciliation status: all dirty paths in the current checkout are present in `capture-board-lanes` and `dev-land`, and the files are byte-identical across all three trees. This includes the `/api/signal` seam restored into the current checkout after typecheck exposed the missing `routes/signal.ts` module.

Direct `origin/main` check after `git fetch --all --prune` showed that `origin/main` does not contain `apps/web/src/lib/api/issue-board.ts`, `apps/web/src/screens/mobile/issue-board.tsx`, `apps/api/src/routes/admin-work-requests.ts`, `/api/work-requests/board`, `/move`, or the `context_work_items_request_ref_uidx` index. Earlier notes saying the board was already in main were stale/wrong. The board substrate is now reconciled from the current checkout into both replay trees.

No remaining root-only feature slices are pending reconciliation. If new work continues in one tree, rerun the path-by-path parity check before handing off.

## b-sitelayer Salvage Decision

`b-sitelayer` contains one unique commit: `aff45141 worker: adopt @operator/projectkit SDK for product-trace emit path`.

Do not cherry-pick it raw. Current `origin/main` has the later, better version of this work:

- `origin/main` uses `@operator/projectkit` already.
- `origin/main` supports the newer `SIGNAL_SINK_URL` seam and falls back to `MESH_TRACE_FORWARD_URL`.
- `origin/main` signs over the actual ingest URL pathname instead of hard-coding `/api/product-trace/ingest`.
- `origin/main` wraps trace items in projectkit `ProjectEvent` / `ProjectEventEnvelope`; the stale branch still sends the older raw `{ project_key, tier, events }` body.

Useful idea stolen: the `MemorySink` boundary test from `b-sitelayer` proves a non-mesh sink can be injected without calling `fetch`. It has now been ported semantically into the clean `capture-board-lanes` worktree, `dev-land`, and the current dirty checkout, adapted to the `origin/main` projectkit `ProjectEventEnvelope` shape rather than `b-sitelayer`'s stale raw `{ project_key, tier, events }` envelope. Do not preserve the stale raw-envelope expectation.

Port location:

- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/runners/mesh-trace-forward.ts`
- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/runners/mesh-trace-forward.test.ts`
- `/home/taylorsando/projects/sitelayer/apps/worker/src/runners/mesh-trace-forward.ts`
- `/home/taylorsando/projects/sitelayer/apps/worker/src/runners/mesh-trace-forward.test.ts`

Verification:

- `npm run test --workspace @sitelayer/worker -- src/runners/mesh-trace-forward.test.ts` — 8 tests passed.
- `npm run typecheck --workspace @sitelayer/worker` — passed.
- `git diff --check` — passed.
- Same focused worker test and typecheck now pass in the current dirty checkout after replay.

## Reconciliation Rules

1. Treat `b-sitelayer` as stale unless a file-level review proves its commit contains unique logic not present in `origin/main`.
2. Treat `seam-sl-telemetry` as absorbed into `origin/main`; fast-forward or prune it once no runner is actively using that worktree.
3. Keep this board/capture patch stack on the current branch until the dirty tree is either committed or exported as a patch.
4. Before merging to main, replay this work onto `origin/main` or the `capture-board-lanes` worktree and resolve conflicts there.
5. Expected conflict zones during replay: capture dock files, `product-trace-beacon`, `package.json` / lockfile, and any worker projectkit emit path touched by the old seam branches.
6. Keep the projectkit boundary unchanged: projectkit remains emit/dispatch only; Sitelayer issue-board screens consume the Sitelayer API seam.

## Media Understanding Slice

The useful media-understanding work originated in the clean, main-aligned `capture-board-lanes` worktree and was then replayed into `dev-land` and the current dirty checkout. Do not rebuild it from older worker files.

Replay locations:

- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/media/create-media-understanding-processor.ts`
- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/media/gemini-api-processor.ts`
- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/media/gemini-cli-processor.ts`
- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/media/media-processor.ts`
- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/media/media-processor.test.ts`
- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/runners/capture-artifact-analysis.ts`
- `/home/taylorsando/projects/sitelayer-worktrees/capture-board-lanes/apps/worker/src/runners/capture-artifact-analysis.test.ts`
- `/home/taylorsando/projects/sitelayer/apps/worker/src/media/*`
- `/home/taylorsando/projects/sitelayer/apps/worker/src/runners/capture-artifact-analysis.ts`
- `/home/taylorsando/projects/sitelayer/apps/worker/src/runners/capture-artifact-analysis.test.ts`

What to preserve:

- `MEDIA_UNDERSTANDING_ENGINE=off|gemini-cli|gemini-api|stub`, default `off`.
- `gemini-cli` is the zero-cash subscription path.
- `gemini-api` stays inert unless both `MEDIA_UNDERSTANDING_GEMINI_API_ENABLED=1` and a key are present.
- The API adapter uses the current REST structured-output request shape: `generationConfig.responseFormat.text`.
- API keys are sent in `x-goog-api-key`, not in the URL query string.
- Understanding failures degrade to transcript/frames-only attachment; they must not fail artifact analysis.

Verification:

- `npm run test --workspace @sitelayer/worker -- src/media/media-processor.test.ts src/runners/capture-artifact-analysis.test.ts` — 26 tests passed.
- `npm run typecheck --workspace @sitelayer/worker` — passed.
- Current dirty checkout replay: `npm run test --workspace @sitelayer/worker -- src/media/media-processor.test.ts src/runners/capture-artifact-analysis.test.ts src/runners/mesh-trace-forward.test.ts` — 34 tests passed.
- Current dirty checkout replay: `npm run typecheck --workspace @sitelayer/worker` — passed.

## Web State Provider Replay

The reusable state-provider layer now exists in the current dirty checkout, `dev-land`, and `capture-board-lanes`.

Replay files:

- `apps/web/src/lib/capture-state-providers.ts`
- `apps/web/src/lib/capture-state-providers.test.ts`
- `apps/web/src/lib/takeoff/canvas-state-snapshot.ts`
- `apps/web/src/lib/takeoff/canvas-state-snapshot.test.ts`
- `apps/web/src/lib/estimate-builder-state-snapshot.ts`
- `apps/web/src/lib/estimate-builder-state-snapshot.test.ts`
- `apps/web/src/lib/project-detail-state-snapshot.ts`
- `apps/web/src/lib/project-detail-state-snapshot.test.ts`
- `apps/web/src/lib/estimate-review-state-snapshot.ts`
- `apps/web/src/lib/estimate-review-state-snapshot.test.ts`
- route registrations in authenticated takeoff desktop/mobile/project screens
- route registration in authenticated estimate-builder
- route registration in authenticated mobile project detail
- route registration in authenticated mobile estimate review/send
- `AuthenticatedFeedbackDock` state-snapshot upload on recording stop; in the current dirty checkout and `dev-land`, the broader dock also uploads on text issue submit.

Verification:

- Current dirty checkout: `npm run test --workspace @sitelayer/web -- src/components/capture/AuthenticatedFeedbackDock.test.tsx src/portal/IssueReporter.test.tsx src/screens/feedback/FeedbackInviteEntry.test.tsx src/lib/capture-state-providers.test.ts src/lib/takeoff/canvas-state-snapshot.test.ts src/lib/estimate-builder-state-snapshot.test.ts src/portal/EstimateView.test.tsx src/portal/RentalsPortalProvider.test.tsx` — 20 tests passed.
- Current dirty checkout: `npm run typecheck --workspace @sitelayer/web` — passed.
- `capture-board-lanes`: `npm run test --workspace @sitelayer/web -- src/lib/capture-state-providers.test.ts src/lib/takeoff/canvas-state-snapshot.test.ts src/lib/estimate-builder-state-snapshot.test.ts src/components/capture/AuthenticatedFeedbackDock.test.tsx` — 8 tests passed.
- `capture-board-lanes`: `npm run typecheck --workspace @sitelayer/web` — passed.
- `capture-board-lanes`: `npm run test --workspace @sitelayer/web -- src/lib/project-detail-state-snapshot.test.ts src/lib/estimate-review-state-snapshot.test.ts` — passed after the mobile route-provider replay.
- `dev-land`: focused web tests/typecheck remain blocked by missing installed web dependencies (`vitest`, `vite/client`, `vite-plugin-pwa/client`), but `git diff --check` passed.

## dev-land Integrated Branch

`/home/taylorsando/projects/sitelayer-worktrees/dev-land` is branch `dev`, ahead of `origin/dev` by the integrated projectkit telemetry and media-understanding merge. It should be treated as the integrated replay candidate, not as an unrelated branch.

Semantic ports added there as well:

- Gemini API media adapter now uses `generationConfig.responseFormat.text` and `x-goog-api-key`, matching the `capture-board-lanes` fix.
- `mesh-trace-forward` accepts an injected projectkit `EventSink`.
- `mesh-trace-forward.test.ts` has the same `MemorySink` boundary test proving delivery can be swapped without changing `ProjectEventEnvelope`.
- The shared web state-provider registry was replayed from the current dirty checkout:
  - `apps/web/src/lib/capture-state-providers.ts`
  - `apps/web/src/lib/takeoff/canvas-state-snapshot.ts`
  - `apps/web/src/lib/estimate-builder-state-snapshot.ts`
- Authenticated takeoff and estimate-builder routes in `dev-land` now register the same sanitized route state providers as the dirty checkout.
- Authenticated mobile project detail and estimate-review routes in `dev-land` now register the same sanitized route state providers as the dirty checkout.
- `dev-land` now has the same work-request list `lane` filter surface as the dirty checkout and `capture-board-lanes`.
- `AuthenticatedFeedbackDock` in `dev-land` now uploads registered state snapshots before registered geometry/artifact providers on text issue submit and recording stop.
- This was intentionally limited to the provider layer. The broader public feedback-invite, Steve prewarm, and screen-recording WIP has not been replayed to `dev-land`.

Verification:

- `git diff --check` in `dev-land` — passed after worker and web provider replay.
- Focused worker tests and typecheck could not run in `dev-land` because that worktree has no installed dependencies (`vitest: not found`, missing `@types/node`). The same worker patches passed focused worker tests and typecheck in `capture-board-lanes`, where dependencies are installed.
- Focused web provider/dock tests could not run in `dev-land` because `vitest` is not installed in that worktree.
- Web typecheck could not run in `dev-land` because Vite type packages are unresolved (`vite/client`, `vite-plugin-pwa/client`).

## rescue-loose-board

`/home/taylorsando/projects/sitelayer-worktrees/rescue-loose-board` is a preservation commit for the loose board/capture WIP, not a newer design branch.

Checked against the current dirty checkout:

- Same content: admin cross-tenant board route/client/UI, tenant issue board UI, feedback-invite route, authenticated feedback dock, capture policy, capture recorder.
- Different content: `apps/web/src/screens/feedback/FeedbackInviteEntry.tsx`; the current dirty checkout is newer because it adds the token-bound public invite capture/provider work.

Do not cherry-pick `rescue-loose-board` raw. Keep it as a backup/proof snapshot only.

## Current Board Slice

- Tenant board: `/work/board`, company-scoped, triage-role gated.
- Operator board API: `GET /api/admin/work-requests/board`, pre-company, Clerk platform-admin gated.
- Operator board UI: `/admin/*` console `Issues` tab, read-only cross-tenant triage view.
- Steve/public collaborator access is now partially implemented through a dedicated feedback-invite token surface, not `capture_invite` as auth:
  - Admins can create/list/revoke feedback invites.
  - Company admins can create/copy/revoke those links from Settings -> External reviewers.
  - `/feedback?token=...` resolves the invite, strips the token from the URL, and can submit text issues.
  - Feedback-invite capture sessions can append events, upload artifacts, finalize, and discard through the existing portal capture helpers.
  - The public page can upload opt-in state snapshots, microphone audio, and browser-picked screen video when those invite modes are allowed.
  - Feedback-invite state upload now runs the shared `capture-state-providers` registry through a token-bound portal upload adapter.
  - Estimate/rental portal feedback also injects the token-bound portal upload adapter for registered state providers.
  - Estimate and rental portal pages now register redacted production state providers for review/signature state, estimate totals, catalog/filter/cart state, and reservation status.
  - Authenticated takeoff canvas pages now register redacted state snapshots for desktop, mobile, and legacy project takeoff surfaces. These capture xstate/session mode, active draft/blueprint/page, viewport/tool, selection counts, and measurement summaries alongside the existing canvas geometry artifact.
  - Authenticated estimate-builder pages now register redacted state snapshots for totals, stale/conflict/save state, selected scope filter, active pricing profile identity, and line summaries.
  - Authenticated mobile project detail pages now register redacted state snapshots for active tab, project lifecycle/status, budget counters, and related row counts.
  - Authenticated mobile estimate review/send pages now register redacted state snapshots for sell/cost/margin totals, builder dirty/conflict/error state, send-sheet state, and line summaries.
  - Dirty root also closes the Steve text-issue open gap: the prewarmed authenticated feedback session appends `authenticated.feedback.issue_opened` and uploads registered state snapshots with reason `issue_opened`. This is root-only for now because `dev-land` and `capture-board-lanes` intentionally do not carry the full Steve prewarm/text-issue stack.
  - The worker now has a local lost-callback reconciler: acknowledged Mesh dispatches with no later callback get an `agent.callback_missing` timeline event and move to `proposal_expired` before the generic stale sweep.
  - STT deployment plumbing now exposes the capture-analysis and callback-reconciler env knobs, and Docker workers can reach the host whisper service through `host.docker.internal:5678`.
  - The projectkit observation sink from `capture-board-lanes` has been replayed into the dirty root and `dev-land`: `mesh-observation-client.ts` now emits projectkit envelopes instead of legacy flat observation JSON while preserving the same HMAC auth and best-effort semantics.
  - Still missing before production: registering additional route-specific state providers beyond portal + takeoff + estimate-builder + mobile project detail + mobile estimate review, and replaying this dirty stack onto `origin/main`.
