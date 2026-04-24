# Release Gates

## Pull Requests

`.github/workflows/quality.yml` runs on PRs and pushes to `main`:

- shell syntax checks for `scripts/*.sh`
- workspace typecheck
- workspace tests
- full build
- fixture-mode web build
- Playwright fixture route smoke tests

Main branch protection should require the `Quality / validate` status check. A repo admin can apply the source-controlled default with:

```bash
OWNER_REPO=GitSteveLozano/sitelayer scripts/configure-github-protection.sh
```

## Production Deploys

`.github/workflows/deploy-droplet.yml` targets the GitHub `production` environment. Configure that environment in GitHub with required reviewers to turn production deploys into an approval-gated workflow.
