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

Main branch protection should require the `Quality / validate` status check. A repo admin can apply the source-controlled default with:

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

- **Branch protection on `main`** requiring the `Quality / validate` status check before merge (apply via `scripts/configure-github-protection.sh`), plus PR + no force-push per the adopted model.
- **A green-`Quality` check for the exact deploy SHA before running the prod deploy.** A follow-on agent is adding this as an automated gate inside `scripts/deploy-production-local.sh`; until it lands, the human/agent running the deploy MUST confirm `Quality` is green for that SHA manually.
