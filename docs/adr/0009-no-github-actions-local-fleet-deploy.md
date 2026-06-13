# ADR 0009 — No GitHub Actions; local-fleet deploy with `verify-local.sh` as the single verification authority

**Status:** accepted
**Date:** 2026-06-13 (documents the deploy model adopted 2026-06-01/02)
**Supersedes:** —
**Superseded by:** —

## Context

SiteLayer originally deployed via GitHub Actions workflows
(`deploy-droplet.yml`, `deploy-dev.yml`, `deploy-demo.yml`, `quality.yml`, a
self-hosted preview runner). That created a CI dependency, secret-management in
GitHub, and a second source of truth for "is this SHA good." The operator's
standing model across repos is to deploy from the local fleet with a local
verification gate.

## Decision

**The repo runs ZERO GitHub Actions. Deploys are local-fleet via
`scripts/deploy.sh <prod|dev|demo>`, and the single verification authority is
`scripts/verify-local.sh` (`npm run verify`).**

Concretely:

1. **`.github/workflows/` is gone.** The deploy workflows were removed in
   `70b9584b`; `quality.yml` was deleted 2026-06-02. Only non-workflow
   `.github/` files remain (CODEOWNERS, templates). Nothing in the pipeline
   queries GitHub Actions/`gh api`.
2. **`scripts/deploy.sh <tier>` from a fleet box** is the deploy path: prod
   builds an immutable registry image, SSHes (flock-locked) to the droplet, takes
   a pre-migration `pg_dump`, migrates, swaps containers, health-checks, and
   writes `.last_*_deployed_sha` (which rollback reads). dev/demo deploy
   source-mounted via `deploy-preview.sh`. No ad-hoc `docker compose up -d`.
3. **`scripts/verify-local.sh` is the gate** — static (shell-syntax,
   lock-sync, migration-immutability, prettier, lint, typecheck), unit tests,
   build, bundle-budget, dockerfile-import guard, and the docker-compose
   DB-backed integration suite. e2e + visregress are an opt-in `--full` /
   `VERIFY_INCLUDE_VISUAL` level (resource-heavy). `deploy.sh` runs it before
   pushing the image.
4. **Land-time enforcement is the repo-tracked pre-push hook**
   (`.githooks/pre-push`, two-path drift-proof install): pushing to `dev`/`main`
   runs `npm run verify` and blocks on failure (bypass: `--no-verify`). Two
   deploy lines: `dev` = churn (auto-deploys), `main` = promoted behind a gated
   `dev → main` promotion. Post-deploy detection = `smoke-tier.sh` +
   `render-synthetic.sh` (authenticated MOUNT synthetic).

## Consequences

**Positive:** no CI vendor dependency or GitHub-secret management; one local
gate any contributor (human or agent) can run identically; the gate runs on the
exact deploy SHA before the image is pushed; break-glass is explicit
(`FORCE_DEPLOY_UNCHECKED=1`).

**Negative:** no hosted PR CI — verification is the contributor's responsibility,
enforced only at the integration point (the pre-push hook) and at deploy time.
The hook install must stay healthy (it self-checks and has a backstop shim).
GitHub branch protection on `main` is optional code-review hygiene, not a deploy
requirement.

## References

- `docs/RELEASE_GATES.md` — the promotion model + land-time enforcement.
- `CLAUDE.md` — "Deploy procedure" + "Production Change Rules".
- `scripts/verify-local.sh`, `scripts/deploy.sh`, `.githooks/pre-push`,
  `scripts/fleet-auto-deploy.sh`, `scripts/render-synthetic.sh`.
