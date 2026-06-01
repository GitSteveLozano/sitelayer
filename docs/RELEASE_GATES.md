# Release Gates

## Pull Requests

`.github/workflows/quality.yml` runs on PRs and pushes to `main`:

- shell syntax checks for `scripts/*.sh`
- lint + Prettier format check
- workspace typecheck
- workspace tests
- full build
- web bundle budget (`npm run web:bundle-budget`)
- fixture-mode web build
- Playwright fixture route smoke tests

`quality.yml` is optional PR CI only — it is not a deploy gate, and nothing in the deploy path queries its status. Main branch protection requiring the `Quality / validate` status check is optional PR hygiene (PR + review before merge), not a deploy requirement. A repo admin who wants that hygiene can apply the source-controlled default with:

```bash
OWNER_REPO=GitSteveLozano/sitelayer scripts/configure-github-protection.sh
```

## Production Deploys

> **DEPLOY MODEL UPDATED 2026-06-01.** Production deploys are now local-fleet
> via `scripts/deploy.sh prod` (→ `scripts/deploy-production-local.sh`), run
> from a fleet box. The GitHub Actions deploy workflows were removed in
> commit `70b9584b`. `quality.yml` remains the passive CI net.

Production deploys run from the fleet via `scripts/deploy.sh prod`. There is no longer a GitHub Actions deploy job or `production` GitHub environment gate in the path.

Safety now depends on:

- **A local Quality gate inside `scripts/deploy-production-local.sh`, run on the exact deploy SHA before the image is pushed.** This has LANDED — the prod deploy itself runs the gate locally (shell-syntax, migration-immutability, prettier, lint, typecheck, unit tests, the dockerfile-import guard, then `web:bundle-budget` after the build) and aborts the deploy on failure. There is no `gh api` / GitHub-CI dependency; the break-glass override is `FORCE_DEPLOY_UNCHECKED=1`.
- **Optional branch protection on `main`** (PR + review, optionally requiring the `Quality / validate` status check, apply via `scripts/configure-github-protection.sh`) is code-review hygiene, not the deploy authority. The deploy no longer queries any GitHub status, so a green `Quality` check is not a prerequisite for the prod deploy.
