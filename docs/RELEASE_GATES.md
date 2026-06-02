# Release Gates

## The promotion model (dev = churn, main = promoted)

Two deploy lines, deliberately separated so prospects + customers stay OFF the
raw agent churn while `dev` remains a free playground:

- **`dev` = the agent churn / integration line.** Heavy agent iteration lands
  here continuously (frequent code + DB-migration churn). It is **auto-everything**:
  the `dev` tier auto-follows the `dev` branch (`docs/AUTO_DEPLOY.md`) and per-PR
  **previews are ephemeral**, so churn is cheap and disposable. Nothing
  customer- or prospect-facing watches `dev`.
- **`main` = the PROMOTED line.** Code reaches `main` only via a **deliberate,
  gated `dev → main` promotion** — the operator (or the gate) promotes when `dev`
  is good. The promotion is gated by:
  1. the repo-tracked **pre-push standard gate** (`.githooks/pre-push` →
     `npm run verify`) at land time — it **blocks** a push to `dev`/`main` that
     fails (see "Land-time enforcement" below), and
  2. the **post-deploy smoke** (`scripts/smoke-tier.sh`) that confirms the
     promoted SHA is actually serving (detection, see below).
- **demo + prod deploy from `main`.** The prospect-facing **demo** tier
  fast-follows `main` (`AUTODEPLOY_BRANCH_DEMO=main` in
  `scripts/fleet-auto-deploy.sh`), and the customer-facing **prod** tier ships
  from `main` via `scripts/deploy.sh prod`. Both ride the promoted line; neither
  ever sees the `dev` churn line.

```
dev branch ──(agent churn, auto-deploy dev tier, ephemeral PR previews)
   │
   │  deliberate gated promotion: pre-push standard gate + post-deploy smoke
   ▼
main branch ──▶ demo tier (prospects)   +   prod (customers)
```

This is what keeps prospects + customers off the raw churn while keeping `dev` a
free playground for the heavy agent-iteration loop.

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
- docker-compose DB-backed integration checks (real Postgres 18 + booted API) — in the default/standard gate
- Playwright e2e (full app stack + browser) — opt-in `--full` level (`npm run verify:full`); resource-heavy, run on a quiet box, NOT in the deploy gate

There is no PR CI and no status check. GitHub branch protection on `main`
(PR + review) is optional code-review hygiene only — it is no longer enforced
by any workflow, and the deploy never queries GitHub status.

## Land-time enforcement: the pre-push gate hook

The dev/demo auto-deploy watcher (`scripts/fleet-auto-deploy.sh`) ships an
already-gated `origin/dev` SHA with `SKIP_VERIFY=1`, on the premise that the SHA
was gated **at land time** (its dedicated checkout has no `node_modules` to
re-run the gate, and re-gating is redundant). That premise is now **enforced**,
not assumed:

- **`.githooks/pre-push`** (repo-tracked, installed via `core.hooksPath` — NOT a
  stray `.git/hooks` file) runs the **standard** gate (`npm run verify` =
  `static + build + unit + docker-postgres integration`) and **blocks the push**
  when you push to `dev` or `main`. Pushing any other branch (feature branches,
  tags) is not gated — the gate runs at the integration point. **e2e is
  deliberately out of the hook** (the standard level excludes it); the Playwright
  e2e suite runs on the async runner / `npm run verify:full` on a quiet box.
- **Install it once per clone:** `scripts/install-git-hooks.sh` (or
  `npm run hooks:install`) sets `git config core.hooksPath .githooks`
  (idempotent). `--check` reports state; `--uninstall` reverts it.
- **Bypass (emergency only):** the standard `git push --no-verify`.

The hook's ref-selection logic is unit-tested
(`apps/api/src/prepush-hook.test.ts`).

## Post-deploy smoke for dev/demo

After a **successful** dev/demo deploy, the watcher runs
**`scripts/smoke-tier.sh <host> [sha]`** (also `npm run smoke:dev` /
`npm run smoke:demo`) against the live host. It mirrors the prod smoke
(`scripts/verify-prod-deploy.sh`) but targets the public dev/demo hosts over real
DNS/TLS and does NOT inspect docker/compose state (the preview droplet runs
source-mounted watch-mode). Checks:

- `GET /health` → 200
- `GET /api/version` → 200 and `build_sha` matches the just-deployed SHA
- `GET /api/session`, `GET /api/bootstrap` → 200 (a `401` there is accepted as
  "alive but Clerk-gated", which is the demo tier's normal posture)
- demo tier only: `POST /api/demo/sign-in-link` mints when `DEMO_ACCESS_CODE` is
  set; if unset the check skips gracefully (it still confirms the route is wired,
  i.e. not a 404).

The smoke is **detection, not a gate**: a failure is logged loudly and recorded,
but does NOT crash the watcher or mark the deploy failed (the deploy already
happened). The smoke is unit-tested against a localhost mock
(`apps/api/src/smoke-tier.test.ts`).

## Production Deploys

> **DEPLOY MODEL UPDATED 2026-06-02.** Production deploys are now local-fleet
> via `scripts/deploy.sh prod` (→ `scripts/deploy-production-local.sh`), run
> from a fleet box. **The repo runs zero GitHub Actions** — the deploy
> workflows were removed in commit `70b9584b`, and `quality.yml` was deleted
> on 2026-06-02. The verification authority is `scripts/verify-local.sh`.

Production deploys run from the fleet via `scripts/deploy.sh prod`. There is no longer a GitHub Actions deploy job or `production` GitHub environment gate in the path.

Safety now depends on:

- **The local gate `scripts/verify-local.sh`, run by `scripts/deploy.sh prod` on the exact deploy SHA before the image is pushed.** The prod deploy runs the **standard** gate locally (shell-syntax, migration-immutability, prettier, lint, typecheck, unit tests, the dockerfile-import guard, then `web:bundle-budget` after the build, plus the docker-compose DB-backed **integration** suite) and aborts the deploy on failure. The Playwright **e2e** suite is an opt-in `--full` level (`npm run verify:full`) for a quiet/dedicated box — it is resource-heavy and deliberately not part of the deploy gate. There is no `gh api` / GitHub-CI dependency; the break-glass override is `FORCE_DEPLOY_UNCHECKED=1`.
- **Optional branch protection on `main`** (PR + review, apply via `scripts/configure-github-protection.sh`) is code-review hygiene, not the deploy authority. With no GitHub Actions left there is no `Quality` status check to require; the deploy never queries any GitHub status.
