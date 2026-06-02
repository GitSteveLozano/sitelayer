# Sharing & Deploy — the single clear path

The one map for **sharing the app** and **deploying it**. It synthesizes the
deeper docs (linked inline); when this doc and live code/scripts disagree, the
**code wins**. Start here, then drill into:
[`DEV_ENVIRONMENT.md`](./DEV_ENVIRONMENT.md),
[`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md),
[`PREVIEW_DEPLOYMENTS.md`](./PREVIEW_DEPLOYMENTS.md),
[`../DEPLOY_RUNBOOK.md`](../DEPLOY_RUNBOOK.md).

## 1. The four tiers at a glance

| Tier        | URL                                                     | Database             | Who it's for                          | Lifecycle                                                           |
| ----------- | ------------------------------------------------------- | -------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| **prod**    | `sitelayer.sandolab.xyz`                                | `sitelayer_prod`     | Real customers                        | Permanent. **Manual deploy only**, gated.                           |
| **dev**     | `dev.sitelayer.sandolab.xyz`                            | `sitelayer_dev`      | Internal collaborators, agents, QA    | Permanent. Tracks `dev`; RoleSwitcher (no Clerk).                   |
| **demo**    | `demo.preview.sitelayer.sandolab.xyz`                   | `sitelayer_demo`     | External prospects (Clerk-ON sign-in) | Permanent. Tracks a chosen ref (`dev` today). Reseeded each deploy. |
| **preview** | `main.preview…` / `pr-N.preview.sitelayer.sandolab.xyz` | `sitelayer_preview`† | PR smoke / "does my migration apply"  | `main` smoke is permanent; `pr-N` dropped on close.                 |

† Each preview slug owns an isolated schema `sitelayer_<slug>` inside the shared
`sitelayer_preview` DB. Demo data is **fake and disposable**.

## 2. I want to give someone access

**Internal collaborator / QA (no account needed)** → send the **dev** URL
`https://dev.sitelayer.sandolab.xyz`. Dev is Clerk-free: the in-app
`<RoleSwitcher />` lets them swap roles with no sign-in, and the API honors the
`x-sitelayer-act-as` header (because `tier !== 'prod'`). Nothing to provision per
person. See [`DEV_ENVIRONMENT.md`](./DEV_ENVIRONMENT.md).

**External prospect (real sign-in, polished)** → send a **demo** magic-link.
From the repo, with the shared access code set:

```bash
DEMO_ACCESS_CODE=<shared-code> npm run demo:email -- --role owner --name "Steve"
```

This prints an email body containing a one-click Clerk **sign-in token** (24h
TTL — shorter env values are clamped back up to 24h) **plus** a durable fallback
(`…/demo` + access code + chosen role) so a stale ticket never needs a developer
to rescue the demo. `--role` is one of `owner | estimator | foreman | crew`. The
mint requires `--access-code` or the `DEMO_ACCESS_CODE` env, and is gated by the
`DEMO_ACCESS_CODE` enforced at the edge. **Demo data is fake and reseeded on
every demo deploy** — say so to the prospect. See
[`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md).

> Never send the **prod** URL for evaluation — it has real customer data and no
> throwaway accounts.

## 3. How deploy works now

Deploy is **local-fleet, not GitHub Actions** — the repo runs **zero GitHub
Actions** now (the Actions deploy workflows were removed in `70b9584`, and the
last workflow `.github/workflows/quality.yml` was deleted on 2026-06-02). One
entrypoint, run from a fleet box:

```bash
scripts/deploy.sh <prod|dev|demo>
```

- **`dev` / `demo`** → SSH to the preview droplet (`sitelayer@159.203.53.218`)
  and run `scripts/deploy-preview.sh` in **source-mounted watch-mode** (tsx +
  vite HMR, **no image build**) — the droplet git-checks-out the SHA and changes
  propagate in seconds. `demo` additionally runs the idempotent demo seed
  (`ON CONFLICT DO NOTHING`) so the fake data is refreshed each deploy. HEAD must
  be pushed to an origin branch first.
- **`prod`** → delegates to `scripts/deploy-production-local.sh`: cached image
  build → push to the DO registry → flock-locked SSH to the prod droplet
  (`pg_dump` backup → `migrate-db.sh` → `check-db-schema.sh` → container swap →
  health check). **Manual and gated** — see [`../DEPLOY_RUNBOOK.md`](../DEPLOY_RUNBOOK.md)
  and CLAUDE.md "Deploy procedure".

**Auto-deploy watcher (NEW).** A fleet watcher keeps **dev** and **demo** current
as `origin/dev` advances: it polls the desired SHA
(`git ls-remote origin refs/heads/dev`), compares against each tier's live SHA
(`/api/version` → `build_sha`), and runs `scripts/deploy.sh dev|demo` when they
drift. **Prod stays manual and gated** — the watcher never touches it. The
watcher script + systemd unit and its runbook live in
[`AUTO_DEPLOY.md`](./AUTO_DEPLOY.md) (companion slice).

**The verification gate.** There is **no CI gate** — the single verification
authority is the local script:

```bash
npm run verify           # = bash scripts/verify-local.sh
```

`scripts/verify-local.sh` is what `scripts/deploy.sh` runs before it ships an
image: `deploy.sh prod` runs the **full** gate (shell-syntax,
migration-immutability, prettier, lint, typecheck, unit tests, the
dockerfile-import guard, the post-build bundle-budget, and the docker-compose
integration/e2e checks), and the fleet auto-deploy watcher runs it for the
dev/demo tiers. Run it yourself before pushing. Nothing in this path queries
GitHub Actions.

## 4. Pre-share checklist

Before you send an external link, confirm:

- [ ] **Right SHA.** dev/demo is on the intended commit:
      `curl -s https://dev.sitelayer.sandolab.xyz/api/version` (compare
      `build_sha` to `git ls-remote origin refs/heads/dev`); same for the demo
      host.
- [ ] **Least-priv demo DB role.** The demo `DATABASE_URL` uses
      `sitelayer_demo_app`, **not `doadmin`** (shared-cluster blast-radius). See
      [`DEMO_ENVIRONMENT.md` → Database story](./DEMO_ENVIRONMENT.md#database-story).
- [ ] **Demo sign-in env present.** `CLERK_SECRET_KEY` (test instance),
      `DEMO_APP_ORIGIN`, `DEMO_ACCESS_CODE`, and `DEMO_SIGN_IN_TOKEN_TTL_SECONDS`
      are set in `/app/previews/.env.demo.shared` — otherwise the magic-link
      mint fails.
- [ ] **Ribbon shows the right tier.** dev shows the orange
      "DEV DATA — not real customers"; demo shows "DEMO — sample data, public
      showcase". A prod-looking ribbon means you're about to share the wrong host.
- [ ] **Access code set.** `DEMO_ACCESS_CODE` is configured (env + edge) so the
      durable `/demo` fallback works and crawlers are kept out.

## 5. Pointers / source-of-truth order

1. **Live code + scripts** — `scripts/deploy.sh`, `scripts/deploy-preview.sh`,
   `scripts/deploy-production-local.sh`, `scripts/demo-email.ts`,
   `packages/config/src/index.ts` (tier guard + ribbons), `/api/version`.
2. **This doc** — the map / decision guide.
3. **Deeper docs** — [`DEV_ENVIRONMENT.md`](./DEV_ENVIRONMENT.md),
   [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md),
   [`PREVIEW_DEPLOYMENTS.md`](./PREVIEW_DEPLOYMENTS.md),
   [`AUTO_DEPLOY.md`](./AUTO_DEPLOY.md), [`../DEPLOY_RUNBOOK.md`](../DEPLOY_RUNBOOK.md),
   and CLAUDE.md "Deploy procedure".
