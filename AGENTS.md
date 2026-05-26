# Agent guide for Sitelayer

This file is for AI agents (Claude, Codex, Gemini, anything) editing this repository. If you are a human, read [`CLAUDE.md`](./CLAUDE.md) first; it covers the same ground with more detail.

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
  as blockers instead of trying to recreate Taylor's setup.

## Read this before editing anything

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

1. **Live code and checked-in deployment files** — `Dockerfile`, `docker-compose.*.yml`, `.github/workflows/`, and `apps/api/src/routes/dispatch.ts` + the `apps/api/src/routes/` handler modules (the canonical endpoint registry; `server.ts` is HTTP+auth+middleware only).
2. [`CLAUDE.md`](./CLAUDE.md) — operating rules, deploy procedure, env management. Trust this over historical docs.
3. [`docs/adr/`](docs/adr/) — durable architectural decisions. Newer ADRs supersede older ones; the most recent is the truth.
4. [`DEPLOY_RUNBOOK.md`](DEPLOY_RUNBOOK.md) — deploy/migration contract.
5. [`docs/DETERMINISTIC_WORKFLOWS.md`](docs/DETERMINISTIC_WORKFLOWS.md) — the temporal.io-style backend contract.
6. Other `docs/*.md` — current. `docs/archived/*.md` — historical, may have drifted.

If you change architecture, deployment, secrets layout, external services, or infrastructure, patch the relevant doc (mostly `CLAUDE.md`) in the same change.

### 6. Operating posture

- **Don't push directly to `main`.** Open a PR, wait for CI, merge.
- **Don't widen scope unprompted.** A bug fix doesn't need surrounding cleanup; a one-shot doesn't need a helper. Three similar lines beats a premature abstraction.
- **Don't add Phase-N placeholder comments to new code.** They're documentation debt. If something is deferred, link a tracking issue.
- **Don't reinvent primitives.** `apps/web/src/components/m/` already has Button, Avatar, Banner, Kpi, LargeHead, Pill, QuickAction, Section, TopBar, TapCard, FAB, AI primitives, etc. Extend, don't recreate.

## When in doubt

Open the live code, not the docs. Check the actual `Dockerfile` line that COPYs into the image, the actual compose-file `command:` for the web service, the actual route file in `apps/api/src/routes/`. Code is the spec.
