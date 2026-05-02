# Agent guide for Sitelayer

This file is for AI agents (Claude, Codex, Gemini, anything) editing this repository. If you are a human, read [`CLAUDE.md`](./CLAUDE.md) first; it covers the same ground in more detail.

## Read this before editing anything

### 1. The web app you want is `apps/web-v2/`, not `apps/web/`

Production traffic was cut over to `apps/web-v2/` in [PR #139](https://github.com/GitSteveLozano/sitelayer/pull/139) on 2026-05-01.

- Live in prod, dev, preview, and gh-pages: `apps/web-v2/` ([source](apps/web-v2/src)).
- Retired, kept only as the rollback target during the post-cutover release window: `apps/web/` ([retirement notice](apps/web/RETIRED.md)).

If you find yourself reading or editing files under `apps/web/` thinking you're touching the live app, stop. The patterns are different on purpose — v2 is mobile-first PWA with a 5-tab IA, v1 is desktop-first form/table. See [`docs/adr/0002-web-v2-rebuild.md`](docs/adr/0002-web-v2-rebuild.md).

### 2. "Phase N" comments mean **deferred**, not done

`apps/web-v2/src/` is full of comments like `Phase 1`, `Phase 1D.4`, `Phase 3A`, `Phase 5`. **These are placeholders for work that has not happened yet.** A few representative traps:

- [`apps/web-v2/src/screens/projects/takeoff-hub.tsx`](apps/web-v2/src/screens/projects/takeoff-hub.tsx) renders eight cards labelled `Phase 3A` through `Phase 3H`. The cards are stub UI, not partial implementations.
- [`apps/web-v2/src/components/ai/WhyThis.tsx`](apps/web-v2/src/components/ai/WhyThis.tsx) is a Phase-5 shell.
- [`apps/web-v2/src/screens/foreman/daily-log.tsx`](apps/web-v2/src/screens/foreman/daily-log.tsx) lists "AI-drafted narrative", "Weather", "Issues" — all Phase 5.

If a screen looks rendered but the data wiring or behavior is missing, search the file for `Phase` before assuming it's a bug. The backend half may also be deferred (e.g. issue-modal posts to an endpoint that doesn't exist yet).

### 3. Quality gates that actually run for v2

Today, on every PR:

- `tsc --noEmit` (typecheck — `apps/web-v2/tsconfig.json`)
- `eslint . --max-warnings=0` (root config; React-hooks/restricted-syntax rules are scoped to v1 only — see [Open lint debt](#open-lint-debt))
- `prettier --check`
- `vite build` (catches transitive import + circular-dep errors)
- `vitest run` for `apps/web-v2/src/**/*.test.{ts,tsx}` ([smoke tests](apps/web-v2/src/__tests__/routes-load.test.ts))
- `node scripts/check-web-bundle-budget.mjs web-v2` (initial-eager-JS gzip budget)

What does **not** run for v2 yet:

- React-hooks rules (purity, exhaustive-deps) — there are ~140 outstanding violations
- `no-restricted-syntax` rules forbidding raw `<button>`/`<input>`/`<select>`/`<textarea>` — there are ~80 outstanding violations and several need primitives that don't exist yet
- Component-level tests (no jsdom env wired)
- Playwright E2E (`npm run e2e` targets v1 only)

If you fix one of these, please do it as a focused PR, not a side effect of a feature.

### 4. Where canonical truth lives

In rough order of authority:

1. **Live code and checked-in deployment files** — `Dockerfile`, `docker-compose.*.yml`, `.github/workflows/`, `apps/api/src/server.ts` (the canonical endpoint list).
2. **`CLAUDE.md`** — operating rules, current snapshot, deploy procedure, env management, QBO/blueprint discipline. Trust this over historical docs.
3. **`docs/adr/`** — ADRs. ADR 0002 is the v2 rebuild plan and the source of truth for cutover criteria, phasing, and what's intentionally deferred.
4. **`docs/DEPLOY_RUNBOOK.md`** — deploy/migration contract.
5. **Other `docs/*.md`** — historical, may have drifted.

If you change architecture, deployment, secrets layout, external services, or infrastructure, patch the relevant doc (mostly `CLAUDE.md`) in the same change.

### 5. Operating posture

- **Don't push directly to `main`.** Open a PR. Branch protection isn't enforced yet, but acting like it is keeps the history readable.
- **Don't widen scope unprompted.** A bug fix doesn't need surrounding cleanup; a one-shot doesn't need a helper. Three similar lines beats a premature abstraction.
- **Don't add Phase-N comments.** They're documentation debt — the polish-PR queue post-cutover is mostly cleaning these up. If something is deferred, link a follow-up issue.

## Open lint debt (non-blocking, but real)

When time comes to make v2's lint config match v1's strictness:

- `eslint-plugin-react-hooks` recommended rules: ~140 v2 violations, mostly `react-hooks/purity` (`Date.now()` calls in render) and `react-hooks/exhaustive-deps`. Will need real refactoring.
- `no-restricted-syntax` for raw HTML form elements: ~80 v2 violations. Some can be replaced with `MobileButton`; others need primitives (`Chip`, `Select`, `Textarea`) that don't exist in `apps/web-v2/src/components/mobile/` yet.
- The `vendor-sentry must be lazy-loaded` budget rule is currently disabled for v2. Re-enable in `scripts/check-web-bundle-budget.mjs` when Phase 5 lazy-loads the Sentry SDK in v2 (see `apps/web-v2/src/instrument.ts`).

## When in doubt

Ask. Better to leave one task unfinished than to merge a v2 PR that introduces 50 more "polish:" follow-ups.
