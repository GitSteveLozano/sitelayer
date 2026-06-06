# ADR 0003 — Collapse to one web app at `apps/web/`

**Status:** accepted
**Date:** 2026-05-05
**Supersedes:** [0002](0002-web-rebuild.md)
**Superseded by:** —

## Context

[ADR 0002](0002-web-rebuild.md) split the web frontend into a legacy app and a replacement app so a hypothetical pilot customer ("L&A Operations") could keep using the legacy app while the mobile-first PWA rebuild landed. The cutover happened on 2026-05-01; ADR 0002 reserved a rollback path back to the legacy app for one release window per criterion #6.

In practice:

- The pilot customer never went live. Sitelayer has zero paying customers as of 2026-05-04.
- The legacy rollback path (`web-legacy` compose service + `WEB_BACKEND` Caddy env-toggle) was never exercised on prod.
- Two parallel frontends created persistent agent confusion: PR #229 + #231 added 1,700+ LOC of mobile design system to the retired side. PR #235 had to relocate it. The later `screens/<persona>/` vs `screens/mobile/` split was another version of the same parallel-structure problem.
- Every dependabot PR doubled in noise (one for each app). Every CI break played out twice.
- The only durable legacy artifacts that mattered were the 5 XState machines now in `apps/web/src/machines/`.

## Decision

**Keep one frontend at `apps/web/`. Delete the parallel app track entirely.**

Concretely:

1. The legacy frontend directory and all its contents removed.
2. `docker-compose.prod.yml` `web-legacy` rollback service removed.
3. `Caddyfile` `WEB_BACKEND` env-substitution removed; `reverse_proxy web:3000` is hard-coded.
4. `Dockerfile` only COPYs `apps/web/dist`.
5. `.github/dependabot.yml` tracks `/apps/web`.
6. `scripts/check-no-new-v1-files.sh` deleted (the CI guard becomes a no-op when there's no v1 to guard).
7. `eslint.config.mjs` v1 carve-outs removed.
8. Root `package.json` build chain, `dev:web` alias, `e2e` script, and `web:bundle-budget` all collapsed around the single web workspace.
9. `apps/web/src/api-v1-compat.ts` retained as a name-bridge shim — it exposes legacy-style function names (`apiGet`, `apiPost`, `getEstimatePushSnapshot`, etc.) so the migrated XState machines don't need a rewrite. The shim itself delegates to `lib/api/client.ts:request<T>()`. There is exactly **one HTTP client**.

The XState machines that came along: `bootstrap-refresh`, `offline-replay`, `project-selection`, `estimate-push`, `billing-review`. Three legacy-only view-glue machines (`day-confirmed`, `features`, `run-action`) stayed deleted.

## Why now (vs. waiting for a release boundary)

ADR 0002 said retirement waits "until the rollback grace period closes." The grace period was always conditional on a real customer needing rollback. With no customers:

- The cost of "the web app has a regression" → revert the offending PR, redeploy. Same as any normal bug fix.
- The benefit of "two parallel apps in tree" is zero, since there's no second user base to support.
- The cost of two parallel apps is ongoing: dependabot noise, CI duplication, agent confusion (PR #229 + #231 demonstrate this empirically), and dead code.

Net: collapse now.

## What's _not_ changing

- **Backend stays as-is.** `packages/workflows/` (the temporal.io-style state machines: `rental-billing`, `estimate-push`, `project-closeout`, `crew-schedule`, `time-review`, `rental`) is untouched. So is `apps/api/src/routes/`, `apps/worker/src/`, the `mutation_outbox` ledger, `sync_events`, and `docker/postgres/init/`.
- **Frontend state-management contract.** Per the architectural call: long-lived UI orchestration lives in **XState** (the 5 machines above plus screen-level coordination Steve adds). Data fetching/caching lives in **TanStack Query** (`apps/web/src/lib/api/`). Backend workflows are temporal.io-style. None of those layers changed in this retirement.

## Consequences

Positive:

- Single source of truth for "where does new web code go" (always `apps/web/`).
- One CI matrix, one dependabot stream, one bundle-budget config, one ESLint config block.
- ~19,000 LOC removed from the repo.
- The "v1 rollback flip" admin operation no longer exists, which means it can't be used incorrectly under stress.

Negative:

- No same-image rollback to the legacy frontend is possible. If a web regression ships, the path is `git revert <PR> && redeploy`. That's slower than flipping a Caddy env var, but it's the path every other deploy uses.
- Any future customer who arrives expecting the legacy flat-IA desktop UX gets the mobile-first PWA instead. That was already the cutover decision in ADR 0002; this ADR just removes the option to undo it.

## References

- PR #236 — atomic v1 retirement + XState machine migration
- PR #235 — earlier mobile-system migration from the retired app into the current app
- PR #233 — the no-new-v1-files CI guard (now removed because v1 is gone)
- ADR 0002 — the parallel-apps decision this supersedes
- `docs/DETERMINISTIC_WORKFLOWS.md` — the temporal.io-style backend contract that's unaffected
