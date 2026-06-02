# Release Gates

## The verification gate (local, not CI)

The repo runs **zero GitHub Actions** — `.github/workflows/quality.yml` was
deleted on 2026-06-02 (the deploy workflows had already been removed in
`70b9584b`). The single verification authority is the **local gate**
`scripts/verify-local.sh` (`npm run verify`). Run it yourself before pushing;
`scripts/deploy.sh` runs it before it ships. It covers:

- shell syntax checks for `scripts/*.sh`
- lint + Prettier format check
- workspace typecheck
- workspace tests
- full build
- web bundle budget (`npm run web:bundle-budget`)
- fixture-mode web build
- Playwright fixture route smoke tests
- docker-compose integration + e2e checks (real Postgres 18 + booted API)

There is no PR CI and no status check. GitHub branch protection on `main`
(PR + review) is optional code-review hygiene only — it is no longer enforced
by any workflow, and the deploy never queries GitHub status.

## Production Deploys

> **DEPLOY MODEL UPDATED 2026-06-02.** Production deploys are now local-fleet
> via `scripts/deploy.sh prod` (→ `scripts/deploy-production-local.sh`), run
> from a fleet box. **The repo runs zero GitHub Actions** — the deploy
> workflows were removed in commit `70b9584b`, and `quality.yml` was deleted
> on 2026-06-02. The verification authority is `scripts/verify-local.sh`.

Production deploys run from the fleet via `scripts/deploy.sh prod`. There is no longer a GitHub Actions deploy job or `production` GitHub environment gate in the path.

Safety now depends on:

- **The local gate `scripts/verify-local.sh`, run by `scripts/deploy.sh prod` on the exact deploy SHA before the image is pushed.** The prod deploy runs the full gate locally (shell-syntax, migration-immutability, prettier, lint, typecheck, unit tests, the dockerfile-import guard, then `web:bundle-budget` after the build, plus the docker-compose integration/e2e checks) and aborts the deploy on failure. There is no `gh api` / GitHub-CI dependency; the break-glass override is `FORCE_DEPLOY_UNCHECKED=1`.
- **Optional branch protection on `main`** (PR + review, apply via `scripts/configure-github-protection.sh`) is code-review hygiene, not the deploy authority. With no GitHub Actions left there is no `Quality` status check to require; the deploy never queries any GitHub status.
