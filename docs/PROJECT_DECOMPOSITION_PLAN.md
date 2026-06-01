# Sitelayer Project Decomposition & Independent-Workstreams Plan

Audience: Taylor (operator) + the agents/devs who execute in parallel.
Status: prescriptive. Every move below is a file split / type re-export / additive route / test seam within the existing npm-workspaces + raw-`tsc`/vite + raw-SQL + single-web-app layout. No ORM, no Nx/Turbo, no rewrite.

---

## 1. Thesis

Sitelayer is **already well-factored at the package-dependency level** — the workspaces form a clean DAG and each has its own `build`/`typecheck`/`lint`/`test`. Parallel work does not serialize on the package graph; it serializes on **four concrete aggregation points** (`apps/api/src/routes/dispatch.ts`, `apps/web/src/screens/mobile-shell.tsx`, `apps/web/src/lib/api/index.ts`, and the two god-components `desktop-workspace.tsx` / `est-canvas.tsx`), on **copy-paste duplication** (the three takeoff canvases carry "copied verbatim" math), on **three hand-kept-aligned geometry type vocabularies**, and on the **monolithic CI shape** (one serial build chain hand-copied in three places, one un-tagged Playwright run). The unlocking principle is therefore the same everywhere: **turn each shared array/region/barrel into a thin registry that merely _collects_ files each slice owns**, hoist duplicated logic into shared `lib/` modules, derive the geometry types from one source, and add path-filtered CI lanes + e2e tags so a slice runs only its own checks. Two subsystems (capture and the takeoff capture-pipelines) and the scenario/demo engine are already DI-clean islands — their work is mostly _naming the seams that exist_, not refactoring.

---

## 2. Workstream map

| #   | Workstream                                | Owns what                                                             | Boundary interface                                                                                                                               | Package / folder                                                                                                                                                                      | What unblocks it                                                                                                                                             |
| --- | ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **blueprint-ingest**                      | upload → storage → rasterize → render                                 | `BlueprintStorage` iface (`apps/api/src/storage.ts:22`) + `PdfRenderer`/`PdfDocument` (`apps/web/src/lib/pdf/renderer/types.ts`)                 | `apps/api/src/{blueprint-upload,storage,blueprint-rasterize}.ts`, `routes/{blueprints,blueprint-pages}.ts`; `apps/web/src/lib/pdf/`                                                   | Already sealed (both are interfaces). Start now; only blur is `ctx.storage` over-threading (cosmetic).                                                       |
| 2   | **drawing-canvas**                        | the annotation/measurement draw surface (desktop + mobile + projects) | web `TakeoffMeasurement`/`MeasurementGeometry` (`apps/web/src/lib/api/takeoff.ts:39,75`); emits via `useCreateMeasurement`/`usePatchMeasurement` | `apps/web/src/screens/{desktop/est-canvas,mobile/takeoff-mobile,projects/takeoff-canvas}.tsx` + `apps/web/src/lib/takeoff/*`                                                          | **Blocked by 3-way copy-paste** (`est-canvas.tsx:391,2791`). Hoist CTM/board-space/totals math into `lib/takeoff/canvas-math.ts` + `canvas-totals.ts` first. |
| 3   | **takeoff-quantities**                    | geometry → quantities math                                            | `@sitelayer/domain` (`calculateGeometryQuantity`, `normalizeGeometry`, `*Scaled`)                                                                | `packages/domain/src/` + `apps/web/src/lib/takeoff/{world-scale,sheet-scale}.ts`                                                                                                      | Package boundary exists. Split geometry out of the 1,500-line `index.ts` god-file; remember `npm run build --workspace @sitelayer/domain` (dist gotcha).     |
| 4   | **capture-pipelines** (takeoff)           | the 4 PDF→quantity engines                                            | `@sitelayer/capture-schema` `TakeoffResult` (`packages/capture-schema/src/takeoff.ts:422`)                                                       | `packages/pipe-{blueprint,roomplan,drone,photogrammetry}` + `apps/api/src/takeoff-capture-pipelines/*`                                                                                | **Already independent** — each `pipe-*` imports only `capture-schema`, has its own `cli.ts`. Owner works in one `pipe-<x>` + one glue file.                  |
| 5   | **3D-preview**                            | measurements → three.js scene                                         | `TakeoffPreviewScene`/`TakeoffPreviewItem` (`apps/web/src/lib/takeoff/geometry-3d.ts`)                                                           | `geometry-3d.ts` + `apps/web/src/screens/projects/takeoff-3d-scene.tsx`                                                                                                               | **Already independent** — single consumer. Owner edits 2 files.                                                                                              |
| 6   | **feedback-capture** (video/audio/events) | session spine + recorders + tier negotiation                          | `FeedbackCaptureController` + `FeedbackCaptureBackend` iface (`apps/web/src/lib/feedback-capture-controller.ts:43-58,115`)                       | `apps/web/src/lib/capture-*.ts`, `components/capture/`, `portal/IssueReporter.tsx`; `apps/api/src/routes/capture-sessions.ts`; `apps/worker/src/runners/capture-artifact-analysis.ts` | Already DI-clean. Extract `capture-capabilities.ts`; make `controller.start` negotiate down.                                                                 |
| 7   | **demo / scenario**                       | the demo dataset + engine + surfaces                                  | scenario YAML Zod `ScenarioDoc` (`packages/scenario/src/schema.ts`)                                                                              | `packages/scenario/src/*`, `scenarios/steve-demo.yaml`, `scripts/{seed-scenario,demo-email,deploy}.ts/.sh`, `apps/api/src/routes/{demo,admin}.ts`, `apps/web/src/routes/admin.tsx`    | Pure, app-independent engine. Missing primitive: idempotent **reset-to-scenario** route.                                                                     |
| 8   | **workflow reducers**                     | deterministic state machines                                          | reducer registry + Zod schemas (`packages/workflows/src/index.ts`)                                                                               | `packages/{workflows,scenario,queue}`                                                                                                                                                 | Pure reducers, zero internal deps for `workflows`. One agent per workflow; collide only in the registry.                                                     |
| 9   | **api resource slices**                   | one route module each                                                 | uniform `handle(req,url,deps)=>Promise<boolean>`                                                                                                 | `apps/api/src/routes/<name>.ts`                                                                                                                                                       | Independent thunks; only `dispatch.ts` is shared → convert to a registry (Seam 1).                                                                           |
| 10  | **web feature slices**                    | one screen + its hook + machine                                       | per-resource `lib/api/<resource>.ts` + `machines/<name>.ts`                                                                                      | `apps/web/src/screens/{mobile,desktop}/<name>.tsx`                                                                                                                                    | Shared `mobile-shell.tsx` route table + `lib/api/index.ts` barrel + god-components → split (Seams 2, 3).                                                     |
| 11  | **worker/queue runners**                  | server-side analysis/jobs                                             | `queue` + `workflows` + `domain` types                                                                                                           | `apps/worker/src/*`                                                                                                                                                                   | Already independent of web entirely. One agent owns runners.                                                                                                 |
| 12  | **infra / CI**                            | build chain, Dockerfile, CI, env                                      | the build order + `quality.yml` lanes                                                                                                            | `scripts/*`, `Dockerfile`, `.github/workflows/quality.yml`, `ops/env/*`                                                                                                               | Orthogonal; gated by CLAUDE.md production-change rules.                                                                                                      |

---

## 3. Takeoff / canvas / blueprint decomposition

These three (workstreams 1, 2, 3 + the already-independent 4, 5) are the highest-collision cluster. Five concerns, tangled through a web type-vocabulary hub and copy-paste. **Capture-pipelines (4) and 3D-preview (5) are already parallel-safe — start them immediately, no refactor.** The real blockers, ranked by leverage, with the smallest first move each:

### Blocker 1 — Canvas copy-paste (highest collision risk) → unblocks drawing-canvas

Three screens carry "copied verbatim" CTM + totals math: `est-canvas.tsx:391` ("EXACT same CTM math as takeoff-mobile.tsx — do not change") and `est-canvas.tsx:2791` ("Helpers (copied verbatim from takeoff-mobile.tsx — same totals + math)"). Two people editing draw/totals/CTM math diverge silently across files.

- **Smallest first refactor:** extract the duplicated helpers into `apps/web/src/lib/takeoff/canvas-math.ts` (CTM / board-space transforms) and `canvas-totals.ts` (the "same totals" helpers). Pure functions, move the already-identical code, no behavior/API change. The three screens become thin shells over one helper set. Mechanical de-dup of code already marked identical = low risk.

### Blocker 2 — `index.ts` god-file + dist rebuild blast radius → unblocks takeoff-quantities

Geometry math lives alongside markup/rental/bonus/assembly in one ~1,500-line `packages/domain/src/index.ts`, so a quantities edit and a billing edit touch the same file and both trigger a full-monorepo `dist` rebuild.

- **Smallest first refactor:** split the geometry section (`domain/src/index.ts:50-91, 678-893`) into `packages/domain/src/geometry.ts` and re-export from `index.ts` (barrel unchanged → zero import-site churn). Isolates the seam to one file without changing the public surface or the build graph.

### Blocker 3 — Three parallel geometry type vocabularies → shared follow-up for 2 + 3

Web `MeasurementGeometry` (`lib/api/takeoff.ts:39`) ⟂ domain `TakeoffGeometry` (`domain/src/index.ts:91`) ⟂ capture-schema `TakeoffGeometry` (`capture-schema/src/takeoff.ts:118`). Edits to one don't propagate.

- **Smallest first refactor (types-only):** make web `MeasurementGeometry` re-export/derive from `@sitelayer/domain`'s `TakeoffGeometry` union (web already imports `TakeoffPoint` from domain in `arc.ts`/`est-canvas.tsx`). Domain becomes the single source for the _measurement_ shape. **Leave capture-schema's `TakeoffGeometry` separate** — it is the deliberately-different cross-pipeline contract. No runtime change.

### Blocker 4 — `ctx.storage` over-threading (do NOT refactor)

`BlueprintStorage` is injected into many non-ingest routes via `routes/dispatch.ts:124`. It is _already an interface_, so callers depend on the type, not the impl — it does not block parallel work. Leave as-is; just note the ownership blur.

### Ordering by leverage

1. Blocker 1 (canvas-math/totals extraction) — mechanical, unblocks the biggest collision.
2. Blocker 2 (domain `geometry.ts` split) — mechanical, isolates the quantities seam.
3. Blocker 3 (type derivation) — types-only follow-up once 1+2 land.

After these three, the five seams map to five owners with minimal collision: `lib/pdf/` + 3 ingest files / `screens/*-canvas` + `lib/takeoff/canvas-*` / `packages/domain/src/geometry.ts` + `world-scale.ts` / `packages/pipe-<x>` (one per engine) / `geometry-3d.ts` + `takeoff-3d-scene.tsx`.

**The dist gotcha applies to all package work:** every `@sitelayer/*` has `main: ./dist/index.js`; `dist` is git-ignored but present on disk; the `Dockerfile:33` copies host-prebuilt `packages/*/dist`. Editing `packages/<x>/src` has **no runtime effect until `npm run build --workspace @sitelayer/<x>`**.

---

## 4. Capture E2E + progressive enhancement

> Disambiguation: this is the **feedback/usage-capture session** subsystem (video/audio/DOM-events for bug reports + observability), _not_ the takeoff capture-pipelines of §3. They only share the word "capture."

The client stack is already a **dependency-injected state machine**: `FeedbackCaptureController` (`feedback-capture-controller.ts:115`) takes `audioRecorder`, `replayRecorder`, `backend`, `offlineQueue` as deps; both surfaces (`AuthenticatedFeedbackDock.tsx`, `portal/IssueReporter.tsx`) construct it identically with a different `backend`. The server is already **tier-agnostic** (it counts whatever subset of events/artifacts exists — `capture-sessions.ts:315-327`). So progressive enhancement is ~90% latent in the design.

### Capability tiers (strictly additive; degrade down, never block)

- **Tier 0 — passive events** (no consent, no permission): the trace beacon (`product-trace-beacon.ts`) + `capture_session_events`. Mode `trace` already allowed without consent (`capture-sessions.ts:157`). The floor a "records-nothing" session falls to.
- **Tier 1 — +DOM replay (rrweb)**: opt-in flag + `CaptureReplayRecorder.supported`. No OS prompt. Masks PII by default (`capture-replay-recorder.ts:189-199`).
- **Tier 2 — +audio**: requires `getUserMedia({audio})` grant. Gated by `isAudioCaptureSupported()` (`capture-recorder.ts:50`).
- **Tier 3 — +video**: `desktop`/`native` modes, ingested as `kind='video'`, frame-extracted server-side (`capture-artifact-analysis.ts:683`). **Currently ingest-only — no in-browser `getDisplayMedia` recorder exists.**

### Graceful-degradation design (the two missing seams)

1. **`apps/web/src/lib/capture-capabilities.ts`** — a single resolver returning `CaptureCapabilities { tier, audio, dom_replay, beacon, video }` by composing the existing `isAudioCaptureSupported()`, `isCaptureReplayRecorderSupported()`, `beaconEnabled()`, and a permission probe. Today this logic is duplicated across `AuthenticatedFeedbackDock.tsx:62-77`, `IssueReporter.tsx:51-67`, `product-trace-beacon.ts:81-83`.
2. **`controller.start` negotiates down instead of throwing.** Today denied audio throws all-or-nothing (`feedback-capture-controller.ts:178-187`). Make it fall to Tier 1 (rrweb-only) or Tier 0 (events-only) and still finalize a work item. `ensureAudioUploaded`/`ensureReplayUploaded` are already null-tolerant, so the change is in _start_ negotiation only. Write the active tier into `consent_scope.streams` (already populated at `AuthenticatedFeedbackDock.tsx:158`) as the canonical marker. **No server schema change needed.**

### Deterministic-in-CI test harness (three layers)

- **Layer A — tier-parametrized conformance E2E (CI-gating).** Generalize the _working_ portal smoke (`e2e/tests/portal-feedback-capture.smoke.spec.ts`): inject the `FakeMediaRecorder` + `getUserMedia` shim (dedupe both copies into `e2e/fixtures/fake-media.ts`); inject deterministic rrweb via the `CreateRrwebCaptureReplayRecorderOptions.record` DI seam (`capture-replay-recorder.ts:11`); **mock the API at the boundary** so there is no worker/storage race; assert on _requests the client emits_ (upload `kind`s, the `x-sitelayer-capture-session-id` header, finalize body, `consent_scope.streams`). Per-tier matrix: Tier 0 (deny audio + rrweb off → finalize with `streams:[]`, `artifact_count=0`), Tier 1 (one `rrweb`, zero `audio`), Tier 2 (`['audio','rrweb']`), Tier 3 (server-side test POSTing a tiny fixture webm asserting `kind='video'` accepted, with ffmpeg asserted at worker unit level via the injectable `videoFrameExtractor` dep — no real ffmpeg in CI). Wire as a new `capture:conformance` npm script in the gating run.
- **Layer B — keep `.live` smoke diagnostic-not-gating, then fix + re-fold.** `authenticated-feedback-capture.live.spec.ts` flakes because it (a) treats the correct offline **"queued"** outcome as failure and (b) races the worker on read-back. Fix: accept "queued" as a pass (or force offline off), and poll on `capture_artifact_analysis.status='ready'` (`capture-artifact-analysis.ts:329`) instead of a raw count. Stays behind `E2E_LIVE=1`, runs nightly until de-flaked.
- **Layer C — fill unit gaps.** Add a Tier-0 assertion to `capture-sessions.test.ts`: a session finalized with only events (no artifacts) still produces a work item — locks the degradation contract at the API layer.

---

## 5. Easy demo — recommended primary path

**The hosted always-on demo (`demo.preview.sitelayer.sandolab.xyz`) stays the canonical demo** — it is already working e2e (build `ad8a733`): one curated scenario (`scenarios/steve-demo.yaml`, "L&A Exteriors") seeded deterministically by the pure, app-independent `@sitelayer/scenario` engine, re-seeded idempotently on every `scripts/deploy.sh demo`, with a Clerk-ON magic-link flow (`/api/demo/sign-in-link` mints a `__clerk_ticket`) and sendable email links (`npm run demo:email`). An `/admin` Apply button (superadmin, prod-blocked) already spins up a scenario, optionally retargeting a fresh company slug.

**Recommendation: keep the hosted demo as the headline and close exactly two gaps — (A) idempotent reset-to-scenario, and (B) a one-command local boot — both reusing the scenario engine + demo tier.** Do not build a separate "demo-mode toggle" (`APP_TIER=demo` already is one).

### A. One-click reset-to-scenario (highest value, lowest risk)

The seed is additive-idempotent (`ON CONFLICT DO NOTHING`), so it cannot undo prospect edits — only a manual volume wipe does (`DEMO_ENVIRONMENT.md:77-79`).

1. Add `POST /api/admin/scenarios/:slug/reset` beside the existing apply route (`apps/api/src/routes/admin.ts:131-163`), gated identically (superadmin + the `deps.tier === 'prod'` block at `admin.ts:135`). In one tx: company-id-scoped `DELETE FROM <tenant tables> WHERE company_id = (SELECT id FROM companies WHERE slug=$1)`, then call the shipped `runScenarioApply` (`admin-scenarios.ts:146-189`). Surgical and safe — never touches other tenants or prod.
2. Add a "Reset to scenario" button in `apps/web/src/routes/admin.tsx:310-326` (same XState-free fetch pattern already there).
3. Schedule a nightly reset via the existing systemd-timer convention on the preview droplet (`scripts/install-replay-sweep-systemd.sh` is the template) — the nightly reseed the demo doc already asks for.

### B. One command to boot a fully-seeded local instance (engineers / new users)

Compose existing pieces into `scripts/demo-up.sh` (no new infra): `docker compose up -d` (local stack, `APP_TIER` set so migrations + `check-db-schema.sh` run) → `npm run seed:demo` (the exact path the hosted deploy uses) → print the local URL and note roles switch via the dev `<RoleSwitcher />` (Clerk-off locally). Extend `steve-demo.yaml` to seed the canonical `e2e-*` ids for the four roles (it already seeds `e2e-bookkeeper` at `:53`) so the **same YAML drives both the hosted Clerk path and the local act-as path.**

Net: headline = hosted URL + magic-link (zero viewer setup); reset = one-click / nightly; local = one command — all three driven by the **same** `scenarios/steve-demo.yaml`. The reset route is the single primitive that decouples "author/enrich the scenario" from "operate the demo."

---

## 6. CI / test seams for parallel work (no Nx/Turbo)

The serialization is the monolithic Quality run + the hand-ordered build chain + the un-tagged Playwright suite. All fixes are incremental and npm-workspaces-native.

- **Seam 1 — route registry (kills the #1 hotspot, `dispatch.ts` = 27 touches/200).** Today every route is a closure inside the 74-entry array at `dispatch.ts:206`, with a hand-maintained import block and load-bearing order ("earlier entries win"). Convert to a directory convention: each `routes/<name>.ts` exports `{ match, handle, order? }`; `dispatch.ts` builds the array by globbing + sorting on the explicit `order` field (preserves "earlier wins" as data, not position). Net-new routes first; migrate existing opportunistically. Two agents adding routes then touch only their own file.
- **Seam 2 — mobile route manifest.** Replace the ~48 inline `<Route>` entries (`mobile-shell.tsx:305-473`) with `mobileRoutes: RouteDef[]` assembled from per-feature `screens/mobile/<feature>/routes.ts`, with the catchalls (`projects/:projectId/*`, `rentals/*`, `*`) appended **last** by the shell. Removes the merge region AND structurally fixes the CLAUDE.md:30 "catchall swallows new route" footgun (ordering becomes data). Same pattern for `App.tsx` mounts and the `lib/api/index.ts` barrel (import `lib/api/<resource>` directly or generate the barrel).
- **Seam 3 — decompose the god-components.** Split `desktop-workspace.tsx` (23) and `est-canvas.tsx` (22) into folders of per-panel / per-tool subcomponents with a thin composing parent. Pure file splitting.
- **Seam 4 — path-filtered CI lanes.** Keep `quality.yml`'s jobs but make the heavy ones conditional on changed paths (`dorny/paths-filter` or `paths:`): a `packages/**` change runs that package's `test` + downstream; `apps/worker/**`-only skips web typecheck/e2e; `apps/web/**`-only skips the API-server boot in `test-integration`. The per-workspace scripts already exist, so a lane is just `--workspace` scoping behind a filter. Keep the full chain on `push: main` as the merge gate; scope only PR lanes. This is the npm-native "affected" without Nx.
- **Seam 5 — e2e tags + parallel Playwright projects.** `playwright.config.ts:65` has `testDir: './e2e'` and no `projects`/`grep`; the 10 specs already encode areas in filenames. Add Playwright `projects` or a `@tag` convention (`@rental`, `@takeoff`, `@payroll`) so a PR runs `playwright test --grep @rental` and CI shards by project instead of one serial run gated `needs: test-integration`. The four standalone `e2e/*.config.ts` smokes prove the pattern.
- **Seam 6 — contract tests at the shared-kernel boundaries.** The risk slices are `domain`/`workflows`/`capture-schema` (everything depends on them). Add: (a) per-pipe conformance — each `pipe-*` emits a schema-valid `TakeoffResult`; (b) workflows — each registered reducer's snapshot matches the API `WorkflowSnapshot { state, state_version, context, next_events }` shape; (c) domain — lock the exported function signatures api/web both consume. With these green, a kernel change is caught at the seam, not by round-tripping every consumer.
- **Seam 7 — self-describing build order.** The 17-step `&&` chain in `package.json:14` is hand-copied into `quality.yml` (`:214-228`, `:346-360`) — adding a package means editing **three** places. Replace with `npm run build --workspaces --if-present` (npm's workspace topo-order) or a tiny topo-sort helper. Not a task runner — just removing three hand-maintained copies.

**Preserve the single-web-app invariant.** `Dockerfile:33-35` ships only `apps/web/dist` + globbed `packages/*/dist`; `check-dockerfile-imports.mjs` + `check-web-bundle-budget.mjs` enforce one bundle. Decomposition must not add a second app or second bundle — feature-folder splits keep this intact.

---

## 7. Sequenced rollout

Each phase is independently shippable. Phase 0 is pure-additive zero-runtime-risk and should land first because it immediately lets agents run scoped checks.

### Phase 0 — additive enablers (no behavior change, ship in any order)

- **CI:** Seam 4 (path-filtered PR lanes) + Seam 5 (e2e `@tags` / Playwright projects). _First PR:_ add `dorny/paths-filter` to `quality.yml` PR jobs + a `@rental` tag + `projects` to `playwright.config.ts`.
- **Demo:** the `POST /api/admin/scenarios/:slug/reset` route + admin button + nightly timer (§5A). _First PR:_ the reset route alone (company-scoped DELETE + `runScenarioApply`), prod-blocked.
- **Capture:** extract `apps/web/src/lib/capture-capabilities.ts` + dedupe `e2e/fixtures/fake-media.ts`. _First PR:_ `capture-capabilities.ts` + refactor both docks + the beacon to call it (pure consolidation, unit-testable).
- **Takeoff:** Blocker 1 — extract `lib/takeoff/canvas-math.ts` + `canvas-totals.ts` from the verbatim-duplicated code. _First PR:_ `canvas-math.ts` (CTM/board-space) with the three screens importing it.

### Phase 1 — seam-cutting (mechanical, removes the top hotspots)

- **API:** Seam 1 route registry, net-new-first. _First PR:_ the `{match,handle,order}` descriptor type + glob loader in `dispatch.ts`, migrate one route.
- **Web:** Seam 2 mobile route manifest + `lib/api` barrel relief. _First PR:_ `mobileRoutes: RouteDef[]` with catchalls appended last.
- **Domain:** Blocker 2 — split `packages/domain/src/geometry.ts`, re-export from `index.ts`, `npm run build --workspace @sitelayer/domain`. _First PR:_ the file split (barrel unchanged).
- **Capture:** Layer A tier-parametrized conformance E2E (`capture:conformance`) + Layer C Tier-0 unit assertion. _First PR:_ the Tier-2 conformance spec reusing the shared fixture.
- **Kernel:** Seam 6 contract tests (per-pipe `TakeoffResult`, workflow snapshot, domain signatures).

### Phase 2 — behavioral + cleanup (gated by Phase 1's tests)

- **Capture:** make `controller.start` negotiate down (§4, covered by Phase 1's conformance matrix); then Layer B de-flake the `.live` smoke and re-fold into the gate.
- **Takeoff:** Blocker 3 — derive web `MeasurementGeometry` from `@sitelayer/domain` (types-only).
- **Web:** Seam 3 — decompose `desktop-workspace.tsx` + `est-canvas.tsx` into per-panel folders.
- **Demo:** Seam B — `scripts/demo-up.sh` + extend `steve-demo.yaml` `e2e-*` ids; (optional) generalize `/api/demo/sign-in-link` for per-prospect companies (OQ4).
- **Infra:** Seam 7 — replace the 3-copy build chain with `--workspaces --if-present` or a topo helper.
- **Capture (optional, net-new):** `ScreenVideoRecorder` (`getDisplayMedia`) as a new controller recorder dep for true in-browser Tier-3 — only if product wants it; server/worker video path already exists.

---

## 8. Risks / unknowns to verify before committing

1. **`dispatch.ts` ordering correctness.** The "earlier entries win" rule is load-bearing across 74 routes. Before the registry migration, snapshot the current resolution order and assert the globbed+sorted array reproduces it exactly (a test that diffs old vs new order). Mis-ordering silently shadows routes.
2. **Mobile catchall positions.** `projects/:projectId/*` and `rentals/*` must stay last. The manifest must guarantee append-last; verify against the CLAUDE.md:30 warning with a route-resolution test before deleting the inline `<Route>`s.
3. **Domain `geometry.ts` split boundary.** Confirm the exact export set in `index.ts:50-91, 678-893` (geometry vs markup/rental/bonus/assembly) so the split is clean — and that nothing in markup/rental imports a geometry helper that would need to move too. Re-run the full build chain after, since the dist artifact is shared.
4. **dist rebuild discipline.** Every package PR must include the `npm run build --workspace @sitelayer/<x>` step (or rely on CI's build chain) — confirm CI rebuilds dist from src and does not consume stale host dist; otherwise the silent no-op ships.
5. **Reset route blast radius.** Enumerate the full set of tenant tables keyed by `company_id` for the company-scoped DELETE; a missed table leaves orphans, an over-broad one risks cross-tenant deletion. Verify the prod-block guard and superadmin gate on the new route exactly mirror the apply route. Test on the demo DB only.
6. **`steve-demo.yaml` dual-id seeding.** Adding the four `e2e-*` ids must not collide with the existing Clerk `members:` block or break the hosted magic-link resolution-by-email. Verify both paths after the change.
7. **Capture tier negotiation vs consent.** When `controller.start` degrades from Tier 2 to Tier 1/0, confirm `consent_version` requirements still hold (non-`trace` modes require consent — `capture-sessions.ts:157`) and that the written `consent_scope.streams` matches what actually recorded.
8. **e2e tag coverage gaps.** Tagging specs by area risks a PR running too few specs. Keep the full untagged suite on `push: main` so nothing is permanently skipped; the tags only scope PR lanes.
9. **`@sitelayer/capture-catalog` is dead code** (no runtime consumer; classification is inline in `takeoff-drafts.ts` via `catalog.ts`). Decide whether to wire it or drop it before assigning the capture-pipelines workstream — it is currently in the build chain for nothing.
10. **In-request pipeline dispatch.** `takeoff-drafts.ts:261` runs `dispatchCapturePipeline` (incl. Anthropic calls under `BLUEPRINT_VISION_MODE=live`) synchronously inside the HTTP request. Decoupling pipelines may want this moved to the worker/queue — verify whether the capture-pipelines workstream owns that move or it is a separate concern.

---

### Key file references

`apps/api/src/routes/dispatch.ts:206` (74-entry ordered route array), `apps/web/src/screens/mobile-shell.tsx:304-473` (~48 inline routes + catchalls), `apps/web/src/lib/api/index.ts` (hook barrel), `apps/web/src/screens/desktop/{desktop-workspace,est-canvas}.tsx` (god-components; `est-canvas.tsx:391,2791` copy-paste markers), `apps/web/src/screens/{projects/takeoff-canvas,mobile/takeoff-mobile}.tsx`, `apps/web/src/lib/takeoff/{geometry-3d,world-scale,sheet-scale,canvas-geometry-artifact,arc,blueprint-reference}.ts`, `apps/web/src/lib/pdf/renderer/{index,embedpdf,types}.ts`, `apps/web/src/lib/api/takeoff.ts:39,75`, `apps/api/src/{blueprint-upload,storage,blueprint-rasterize}.ts`, `apps/api/src/routes/{blueprints,blueprint-pages,takeoff-drafts,takeoff-write,takeoff-measurements}.ts`, `apps/api/src/takeoff-capture-pipelines/*`, `packages/domain/src/index.ts:50-91,678-893`, `packages/capture-schema/src/takeoff.ts:118,422`, `packages/pipe-{blueprint,roomplan,drone,photogrammetry}/src/`, `apps/web/src/lib/{capture-recorder,capture-replay-recorder,feedback-capture-controller,capture-session,product-trace-beacon}.ts`, `apps/web/src/components/capture/AuthenticatedFeedbackDock.tsx`, `apps/web/src/portal/IssueReporter.tsx`, `apps/api/src/routes/capture-sessions.ts:157,315-327`, `apps/worker/src/runners/capture-artifact-analysis.ts:108,329,683`, `e2e/tests/{portal-feedback-capture.smoke,authenticated-feedback-capture.live}.spec.ts`, `packages/scenario/src/{index,plan,apply,schema}.ts`, `scenarios/steve-demo.yaml`, `scripts/{seed-scenario,demo-email,deploy}.{ts,sh}`, `apps/api/src/routes/{demo,admin}.ts`, `apps/api/src/admin-scenarios.ts:146-189`, `apps/web/src/routes/admin.tsx:240-326`, `package.json:14` (build chain), `.github/workflows/quality.yml:214-228,276,346-360`, `playwright.config.ts:65`, `Dockerfile:33-35`, `scripts/check-dockerfile-imports.mjs`, `CLAUDE.md:30`, `docs/DEMO_ENVIRONMENT.md:77-79`, `docs/SCENARIO_HARNESS_AND_ADMIN_PLAN.md`.
