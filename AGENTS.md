# Agent guide for Sitelayer

This file is for AI agents (Claude, Codex, Gemini, anything) editing this repository. If you are a human, read [`CLAUDE.md`](./CLAUDE.md) first; it covers the same ground with more detail.

> **Steve / Claude Code local work? Read [`docs/STEVE_LOCAL_CLAUDE_CODE_HANDOFF.md`](docs/STEVE_LOCAL_CLAUDE_CODE_HANDOFF.md) FIRST.** Steve's machine is a collaborator workstation: feature branches and PRs only; Taylor's workstation/fleet path pushes `dev`/`main` and deploys dev/demo/prod.
>
> **Collaborator agent with none of the operator infra (mesh / MCP / browser-bridge / Tailnet / prod / Taylor's creds)? Read [`docs/agents/COLLABORATOR.md`](docs/agents/COLLABORATOR.md) FIRST** — it is the self-contained guide for running, testing, and contributing to Sitelayer from a clean GitHub clone.

## Collaborator Workstation Override

If this repo is checked out under `~/projects/collaborator-system/`, assume the
machine is a collaborator Mac, not Taylor's operator workstation:

- do not require Mesh, control-plane, Tailscale, Bitbucket, browser-bridge, or
  Taylor's private credentials;
- do not add Mesh planning notes or upsert Mesh runtime dependencies unless
  Taylor explicitly assigns an infra/deploy task;
- use the checked-in code, this file, and `docs/ONBOARDING_DEVELOPER.md` as the
  local source of truth;
- report missing GitHub, Docker, browser-profile, Clerk, or production access
  as blockers instead of trying to recreate Taylor's setup;
- do **not** run `scripts/deploy.sh prod` (fleet-only — it needs the DO
  registry, the prod droplet, and `DEPLOY_HOST`/`DEPLOY_SSH_KEY`); verify
  locally with `npm run verify` and open a PR — Taylor deploys;
- leave `MESH_API_URL`, `SENTRY_DSN`, `AXIOM_TOKEN`/`AXIOM_DATASET`, the QBO
  prod realm creds, `DATABASE_URL_PROD_RO`, and `DEPLOY_HOST`/`DEPLOY_SSH_KEY`
  **EMPTY** — their hosts are Tailnet-only or production, so setting them will
  not work and will only confuse the logs.

## Read this before editing anything

### 0. Capabilities that exist — do not report these as "missing"

A recon/audit pass once concluded "no 3D engine" because this file and `CLAUDE.md`'s structure section didn't mention it. They exist. Verify against code before calling any of these absent:

- **A working three.js 3D takeoff preview.** `apps/web/src/screens/projects/takeoff-3d-scene.tsx` is a real WebGL renderer (raycasting, drag-rotate/zoom, lighting, blueprint underlay); `apps/web/src/lib/takeoff/geometry-3d.ts` (`buildTakeoffPreviewScene`) converts board-space takeoff measurements → a to-scale (horizontal) / schematic-height 2.5D scene. Lazy-loaded as the `vendor-three` chunk. Live at `/projects/:id/takeoff-preview`; public synthetic demo at `/demo/takeoff-preview-3d`. **three.js is the only 3D lib** — no Babylon/Cesium/react-three-fiber.
- **Four capture pipelines** in `packages/pipe-{blueprint,roomplan,drone,photogrammetry}`, all returning a unified `TakeoffResult`/`TakeoffGeometry` from `packages/capture-schema` (codes via `packages/capture-catalog`). Endpoint `POST /api/projects/:id/takeoff-drafts/capture` dispatches by `kind`, then promote → `takeoff_measurements`. Status: **blueprint_vision** live; prod default = Gemini (`BLUEPRINT_VISION_MODE=gemini`+`GEMINI_API_KEY`, run **async** in the worker since `ef9c6926`), with Anthropic/Claude as the opt-in alt (`BLUEPRINT_VISION_MODE=live`+`ANTHROPIC_API_KEY`); either missing ⇒ deterministic dry-run stub (see CLAUDE.md "Blueprint storage hygiene" rule #4); **roomplan** parser real (areas, not yet 3D coords); **drone** sidecar path real + a real NodeODM client (raster extraction needs external Python); **photogrammetry** labeled-mesh path real, Luma client untested.
- **What is genuinely NOT built:** a scaffold _designer_ (scaffold today is catalog+BOM+approval, not design); and captured geometry is not yet piped into the 3D renderer (only manually-drawn blueprint polygons are). Deeper detail: `docs/BLUEPRINT_TO_3D_PREVIEW.md`, `docs/MULTI_DRAFT_TAKEOFF_SPEC.md`.

### 1. There is one web app: `apps/web/`

The old parallel frontend track was removed on 2026-05-05 (ADR 0003). If you see a stale doc or comment describing a second web app, the canonical answer is `apps/web/`. There is no rollback target.

The mobile shell at `apps/web/src/screens/mobile/` is the canonical UI. Steve's design lives there; everything else mounts under it.

The runtime shell is `apps/web/src/screens/mobile-shell.tsx` (`MobileShell`), mounted at `App.tsx`'s `/*` via `routes/workspace.tsx`, with its own inline route table including the `projects/:projectId/*` and `rentals/*` catchalls. Add a new reachable mobile route inside `mobile-shell.tsx` **before** those catchalls, or mount a full-screen route directly in `App.tsx`/`more.tsx`/`financial.tsx`. The standalone `routes/{projects,rentals,schedule,home,time,log,crew}.tsx` modules are legacy/dead (never mounted under the shell, and being removed) — do not add routes there.

### 2. State management contract

| Concern                     | Where it lives                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long-lived UI orchestration | XState machines in `apps/web/src/machines/` (exemplars: `project-lifecycle.ts`, `estimate-push.ts`, `time-review.ts`, `crew-schedule.ts`, `billing-review.ts`, `field-event.ts`; follow `docs/DETERMINISTIC_WORKFLOWS.md`) |
| Data fetching + caching     | TanStack Query (`apps/web/src/lib/api/`)                                                                                                                                                                                   |
| Backend workflows           | Temporal.io-style state machines in `packages/workflows/`                                                                                                                                                                  |
| HTTP transport              | `apps/web/src/lib/api/client.ts:request<T>()` (single source)                                                                                                                                                              |

If you're tempted to put long-lived state in `useState` + `useEffect`, ask first: should this be an XState machine? If the state has multiple modes (idle / loading / error / submitting / etc.) and survives across mounts, the answer is usually yes.

If you're tempted to write a new API client function, **don't**: extend `apps/web/src/lib/api/<resource>.ts` instead. The compat shim at `apps/web/src/api-v1-compat.ts` is closed for new exports — it exists only to bridge v1-style names that the migrated XState machines were written against.

### 3. "Phase N" comments mean _deferred_, not done

`apps/web/src/` has a sprinkling of `Phase 1`, `Phase 3A`, `Phase 5` comments. **These are placeholders for work that has not happened yet.** If a screen looks rendered but the data wiring or behavior is missing, grep the file for `Phase` before assuming it's a bug. The backend half may also be deferred — an `issue-modal` posting to a route that doesn't exist yet, etc.

### 4. Quality gates that actually run for every PR

- `tsc --noEmit` (typecheck across all workspaces)
- `eslint . --max-warnings=0`
- `prettier --check`
- `npm run test` (vitest across all workspaces with tests)
- `vite build` (catches import + circular-dep errors)
- `node scripts/check-web-bundle-budget.mjs web` (gzip budget)
- Migration immutability check (`scripts/check-migrations-immutable.sh`)

What does _not_ run automatically:

- React-hooks rules (purity, exhaustive-deps) — many outstanding violations across `screens/mobile/`
- Playwright E2E
- Visual / a11y tests

If you fix one of those, do it as a focused PR.

### 5. Where canonical truth lives

In rough order of authority:

1. **Live code and checked-in deployment files** — `Dockerfile`, `docker-compose.*.yml`, `scripts/deploy.sh` + `scripts/verify-local.sh` (the repo runs ZERO GitHub Actions; `.github/workflows/` no longer exists), and `apps/api/src/routes/dispatch.ts` + the `apps/api/src/routes/` handler modules (the canonical endpoint registry; `server.ts` is HTTP+auth+middleware only).
2. [`CLAUDE.md`](./CLAUDE.md) — operating rules, deploy procedure, env management. Trust this over historical docs.
3. [`docs/adr/`](docs/adr/) — durable architectural decisions. Newer ADRs supersede older ones; the most recent is the truth.
4. [`DEPLOY_RUNBOOK.md`](DEPLOY_RUNBOOK.md) — deploy/migration contract.
5. [`docs/DETERMINISTIC_WORKFLOWS.md`](docs/DETERMINISTIC_WORKFLOWS.md) — the temporal.io-style backend contract.
6. Other `docs/*.md` — current. `docs/archived/*.md` — historical, may have drifted.
   - Clerk auth operations (find/inspect users, instance config-as-code, env keys) →
     [`docs/CLERK_CLI.md`](docs/CLERK_CLI.md) — use the agent-agnostic `clerk` CLI
     (`clerk api …`), not the dashboard, for anything that touches a Clerk resource.

If you change architecture, deployment, secrets layout, external services, or infrastructure, patch the relevant doc (mostly `CLAUDE.md`) in the same change.

### 6. Operating posture

- **Don't push directly to `main`.** Open a PR, wait for CI, merge.
- **Don't widen scope unprompted.** A bug fix doesn't need surrounding cleanup; a one-shot doesn't need a helper. Three similar lines beats a premature abstraction.
- **Don't add Phase-N placeholder comments to new code.** They're documentation debt. If something is deferred, link a tracking issue.
- **Don't reinvent primitives.** `apps/web/src/components/m/` already has Button, Avatar, Banner, Kpi, LargeHead, Pill, QuickAction, Section, TopBar, TapCard, FAB, AI primitives, etc. Extend, don't recreate.

## When in doubt

Open the live code, not the docs. Check the actual `Dockerfile` line that COPYs into the image, the actual compose-file `command:` for the web service, the actual route file in `apps/api/src/routes/`. Code is the spec.
