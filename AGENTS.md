# Agent guide for Sitelayer

This file is for AI agents (Claude, Codex, Gemini, anything) editing this repository. If you are a human, read [`CLAUDE.md`](./CLAUDE.md) first; it covers the same ground with more detail.

## Read this before editing anything

### 1. There is one web app: `apps/web-v2/`

`apps/web/` (v1) was deleted on 2026-05-05 (ADR 0003). If you see a stale doc or comment referencing `apps/web/`, the canonical answer is now `apps/web-v2/`. There is no rollback target.

The mobile shell at `apps/web-v2/src/views/m/` is the canonical UI. Steve's design lives there; everything else mounts under it.

### 2. State management contract

| Concern                     | Where it lives                                                    |
| --------------------------- | ----------------------------------------------------------------- |
| Long-lived UI orchestration | XState machines in `apps/web-v2/src/machines/` (5 machines today) |
| Data fetching + caching     | TanStack Query (`apps/web-v2/src/lib/api/`)                       |
| Backend workflows           | Temporal.io-style state machines in `packages/workflows/`         |
| HTTP transport              | `apps/web-v2/src/lib/api/client.ts:request<T>()` (single source)  |

If you're tempted to put long-lived state in `useState` + `useEffect`, ask first: should this be an XState machine? If the state has multiple modes (idle / loading / error / submitting / etc.) and survives across mounts, the answer is usually yes.

If you're tempted to write a new API client function, **don't**: extend `apps/web-v2/src/lib/api/<resource>.ts` instead. The compat shim at `apps/web-v2/src/api-v1-compat.ts` is closed for new exports — it exists only to bridge v1-style names that the migrated XState machines were written against.

### 3. "Phase N" comments mean _deferred_, not done

`apps/web-v2/src/` has a sprinkling of `Phase 1`, `Phase 3A`, `Phase 5` comments. **These are placeholders for work that has not happened yet.** If a screen looks rendered but the data wiring or behavior is missing, grep the file for `Phase` before assuming it's a bug. The backend half may also be deferred — an `issue-modal` posting to a route that doesn't exist yet, etc.

### 4. Quality gates that actually run for every PR

- `tsc --noEmit` (typecheck across all workspaces)
- `eslint . --max-warnings=0`
- `prettier --check`
- `npm run test` (vitest across all workspaces with tests)
- `vite build` (catches import + circular-dep errors)
- `node scripts/check-web-bundle-budget.mjs web-v2` (gzip budget)
- Migration immutability check (`scripts/check-migrations-immutable.sh`)

What does _not_ run automatically:

- React-hooks rules (purity, exhaustive-deps) — many outstanding violations across `views/m/`
- Playwright E2E
- Visual / a11y tests

If you fix one of those, do it as a focused PR.

### 5. Where canonical truth lives

In rough order of authority:

1. **Live code and checked-in deployment files** — `Dockerfile`, `docker-compose.*.yml`, `.github/workflows/`, `apps/api/src/server.ts` (the canonical endpoint list).
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
- **Don't reinvent primitives.** `apps/web-v2/src/components/m/` already has Button, Avatar, Banner, Kpi, LargeHead, Pill, QuickAction, Section, TopBar, TapCard, FAB, AI primitives, etc. Extend, don't recreate.

## When in doubt

Open the live code, not the docs. Check the actual `Dockerfile` line that COPYs into the image, the actual compose-file `command:` for the web service, the actual route file in `apps/api/src/routes/`. Code is the spec.
