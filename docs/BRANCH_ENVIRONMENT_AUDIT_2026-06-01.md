# Branch and Environment Audit - 2026-06-01

> **Update (same day):** branches have since CONVERGED — `origin/main` ==
> `origin/dev` == `deploy-local` == `e34a1503`. The divergence numbers in the
> Branch Matrix below (78 ahead / 49 ahead / 31 ahead, separate demo
> identities, etc.) are **superseded**. Adopted model: trunk-ish, `main` is
> production truth and is being GitHub-branch-protected (PR + green `Quality`
>
> - no force-push), `demo` becomes an `APP_TIER=demo` environment deployed
>   from a chosen ref (`dev` now, `main`/release tag later) rather than a
>   long-lived code branch, and a green-`Quality` gate is being added to the
>   prod deploy script. The analysis below is retained as the rationale for
>   that decision.

## Bottom Line

Sitelayer currently has a reasonable environment model but a risky branch model.

The environment split makes sense:

- `prod`: real customers, production DB, production deploy discipline.
- `dev`: persistent internal scratch/integration environment.
- `demo`: public/prospect-facing sandbox with fake data, real demo auth, and a stable URL.
- `preview`: disposable PR/review apps.

The branch split does not scale cleanly in its current form. `demo` should not remain a long-lived code branch. Demo-specific behavior already belongs naturally in runtime config, seed data, feature flags, and `APP_TIER=demo`; keeping a separate `demo` code branch creates drift and forced cherry-picks for fixes that should be shared.

Recommended direction:

1. Keep `main` as the production source of truth.
2. Keep `dev` temporarily as the fast-moving integration branch while product discovery is moving this quickly.
3. Convert `demo` from "a branch with different code" into "an environment deployed from a chosen commit", usually the current `dev` commit now and eventually the current `main` or release tag.
4. Move toward trunk/GitHub Flow once the product stabilizes: short-lived feature branches, PR previews, `main` always deployable, and environments controlled by config/secrets/data rather than permanent environment branches.

## Snapshot

Audit time: 2026-06-01 after `git fetch --all --prune`.

Current local checkout:

- Branch: `dev-np`
- Tracks: `origin/dev`
- Head: `f01bd54f`
- Dirty state: no tracked-file modifications at audit start, but untracked `docs/steve-handoff/` files exist.

Branch protection:

- GitHub reports `main`, `dev`, and `demo` as `protected: false`.
- This is a release-risk issue. At minimum, `main` should require PR review and the `Quality` workflow before production deploys.

## Branch Matrix

| Branch/ref    | Head       | Current meaning                                                                                     | Relationship                                                                                       |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `origin/main` | `f68eb729` | Production source branch. Live prod is also on `f68eb72`.                                           | `origin/dev` has 78 commits not in `origin/main`; `origin/main` has 1 commit not in `origin/dev`.  |
| local `main`  | `8fa2fcc1` | Stale local branch.                                                                                 | Behind `origin/main` by 8.                                                                         |
| `origin/dev`  | `f01bd54f` | Fast-moving work-in-progress/integration branch and deploy source for `dev.sitelayer.sandolab.xyz`. | 31 commits ahead of `origin/demo`; 2 demo commits exist on `origin/demo` with separate identities. |
| local `dev`   | `733d6136` | Stale local branch.                                                                                 | Behind `origin/dev` by 74.                                                                         |
| `origin/demo` | `05b0b865` | Public demo deploy source branch.                                                                   | 49 commits ahead of `origin/main`, but missing 31 commits already on `origin/dev`.                 |
| local `demo`  | none       | No local branch exists.                                                                             | Remote only.                                                                                       |

Important branch facts:

- `origin/main` has one commit not present on `origin/dev` or `origin/demo`: `f68eb729 New Project: restore the "Start a job" chooser...`.
- `origin/dev` contains the broad current WIP: demo setup, capture, context handoff, admin/scenario work, RBAC, QBO pull, invites, etc.
- `origin/demo` contains the demo stack and latest demo repairs, but it is now missing the later RBAC/admin/QBO/invite work from `origin/dev`.
- The latest formula-evaluator demo fix exists on both `origin/dev` and `origin/demo` as equivalent patches with different commit identities.
- The current branch topology already forces duplicate/cherry-picked fixes. That is the failure mode to eliminate.

## Environment Matrix

| Environment  | URL                                           | Tier      | Data boundary                                 | Deploy source                      | Workflow                               | Runtime shape                                                                                              |
| ------------ | --------------------------------------------- | --------- | --------------------------------------------- | ---------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Production   | `https://sitelayer.sandolab.xyz`              | `prod`    | `sitelayer_prod`                              | `main` / exact quality-checked SHA | `.github/workflows/deploy-droplet.yml` | Full production image + `docker-compose.prod.yml`; backup, migrations, schema check, health verification.  |
| Dev          | `https://dev.sitelayer.sandolab.xyz`          | `dev`     | `sitelayer_dev`                               | `dev` branch                       | `.github/workflows/deploy-dev.yml`     | Preview droplet, `/app/previews/dev`, source-mounted watch-mode by default, worker enabled, persistent DB. |
| Demo         | `https://demo.preview.sitelayer.sandolab.xyz` | `demo`    | `sitelayer_demo`                              | `demo` branch                      | `.github/workflows/deploy-demo.yml`    | Same preview-droplet shape as dev, plus post-deploy demo seed and demo auth/email-link config.             |
| PR Preview   | `https://pr-N.preview.sitelayer.sandolab.xyz` | `preview` | `sitelayer_preview`, isolated schema per slug | PR head SHA                        | `.github/workflows/deploy-preview.yml` | Disposable per-PR stack, default dev/watch mode, optional prod-build mode.                                 |
| Main Preview | `https://main.preview.sitelayer.sandolab.xyz` | `preview` | `sitelayer_preview`, `main` schema/slug       | Intended to track `main`           | manual/legacy preview path             | Currently stale: live API reported build `16e5c2d` while prod is `f68eb72`.                                |

Production live check:

- `https://sitelayer.sandolab.xyz/api/version` returned `tier=prod`, `build_sha=f68eb72`.

Dev live check:

- `https://dev.sitelayer.sandolab.xyz/api/version` returned `tier=dev`, `build_sha=f01bd54f`.
- The corresponding `Deploy Dev` workflow completed successfully during the audit.

Demo live check:

- `https://demo.preview.sitelayer.sandolab.xyz/api/version` returned `tier=demo`, `build_sha=05b0b86`.
- Demo email-link endpoint returns `expires_in_seconds=86400`.

Main preview live check:

- `https://main.preview.sitelayer.sandolab.xyz/api/version` returned `tier=preview`, `build_sha=16e5c2d`.
- This is stale enough that it should either be restored as an automatic smoke target or removed from docs as an active signal.

## What Lives Where Today

### `main`

Purpose today:

- Production branch.
- `Quality` runs on PRs and pushes to `main`.
- Production deploy waits for successful `Quality` on `main` via `workflow_run`.
- Production deploy checks out the exact SHA validated by `Quality`.

What belongs here:

- Code intended for real customers.
- Demo-supporting code that is safely gated by `APP_TIER=demo`.
- Feature-flagged work that is safe to deploy disabled.

What does not belong here:

- Hardcoded demo data.
- Secrets.
- Incomplete code paths that can be reached in prod without a flag or tier gate.

Concern:

- Branch protection is currently absent, so the workflow design is better than the repo governance enforcing it.

### `dev`

Purpose today:

- Persistent internal integration and agent scratch environment.
- Tracks `origin/dev`.
- Uses `APP_TIER=dev` and `sitelayer_dev`.
- Supports non-prod behaviors like role switching/header fallback and destructive DB reset.

What belongs here:

- Current WIP that needs shared testing before production.
- Migration iteration before opening stable PRs.
- Internal workflow/integration testing.

Concern:

- It is currently carrying 78 commits not in `main`. That is fine for a short sprint, but it is not fine as a long-term release train unless someone is deliberately curating promotions from `dev` to `main`.
- If `dev` becomes "where everything goes first forever", it becomes a second trunk and production merges get larger and riskier.

### `demo`

Purpose today:

- Stable public/prospect-facing demo.
- Uses `APP_TIER=demo`, `sitelayer_demo`, seeded fake company data, Clerk test sign-in tokens, and 24-hour generated email links.

What belongs here:

- Environment-specific secrets and variables.
- `sitelayer_demo` DB.
- Demo seed/reseed workflow.
- Demo access-code and ticket TTL settings.
- Demo feature flags and allowed roles/personas.

What does not need a separate branch:

- `/api/demo/*` route code.
- `/demo` landing route code.
- noindex logic.
- demo email generator.
- seed scenario definitions.
- demo tier/config guards.

Those can all live in `main` safely because they are already structurally gated by `APP_TIER=demo` or by config/data.

Concern:

- `demo` is missing current `dev` work. That means the demo can lag the actual product and will keep requiring hotfix cherry-picks.
- A prospect demo branch should not be a place where code differs. It should differ by data, config, secrets, and flags.

## Does Three Separate Deploys Make Sense?

Three separate deployments can make sense. Three separate long-lived code branches usually do not.

The useful distinction is:

- Branches answer: "What code is this?"
- Environments answer: "Where is this code running, against which data/secrets/config?"

Right now `main`, `dev`, and `demo` are doing both jobs. That is the source of complexity.

Better split:

- Keep separate deployments/environments: prod, dev, demo, preview.
- Reduce long-lived branches: ideally `main` plus short-lived feature branches; temporarily `main` plus `dev` while discovery velocity is high.
- Make `demo` a deployment target selected from a ref, not an independent branch.

## Recommended Near-Term Operating Model

For the next product-proving phase, use this:

### Branches

- `main`: production truth. Must be protected.
- `dev`: temporary integration lane for WIP and agents. May be force-curated if needed, but should not be considered production history.
- feature/agent branches: short-lived, PR into `dev` or `main` depending on maturity.
- no permanent `demo` code branch after migration.

### Environments

- `prod`: auto/manual-gated deploy from protected `main` after `Quality`.
- `dev`: deploys from `dev`, fast watch-mode, persistent scratch data.
- `demo`: deploys from a selected ref, initially `dev` while sales/product demos need freshest work, later `main` or a release tag.
- `pr-N`: deploys from PR head SHA and cleans itself up.

### Demo Ref Policy

Pick one, explicitly:

1. Freshest demo, good for product proving: demo deploys from `dev` after smoke checks.
2. Stable demo, good for prospects: demo deploys from `main` or `demo-release-*` tag.
3. Manual override: demo deploy workflow accepts a `ref` and records the deployed SHA.

Current need sounds closest to option 1, with a path to option 2 once you have users relying on the link.

## Recommended Changes

### P0 - Stop The Bleeding

1. Protect `main`.
   - Require PRs.
   - Require `Quality`.
   - Disable force-pushes.
   - Keep production deploy tied to protected `main`.

2. Make `demo` deploy workflow independent from a `demo` branch.
   - Keep `.github/workflows/deploy-demo.yml`, but change it to deploy from an explicit `ref` input or from `dev` by default.
   - Keep `PREVIEW_SLUG=demo`, `PREVIEW_HOST=demo.preview.sitelayer.sandolab.xyz`, `PREVIEW_TIER=demo`, and `/app/previews/.env.demo.shared`.
   - Remove `push: branches: [demo]` or treat it as temporary only.

3. Merge/cherry-pick the current demo-only fixes into the chosen source branch.
   - The demo email-link and formula-evaluator fixes are already on `origin/dev`.
   - Ensure they land on `main` before deleting or freezing `demo`.

4. Add a lightweight `demo:smoke` command or workflow step.
   - POST `/api/demo/sign-in-link`.
   - Verify `expires_in_seconds >= 86400`.
   - Browser through `/demo` -> role -> `/desktop`.
   - Verify `/api/session` and `/api/bootstrap` are 200.

### P1 - Make Dev Less Ambiguous

5. Rename the concept in docs from "dev branch is future main" to "dev environment tracks an integration ref."
   - If `dev` is truly a release candidate, then it needs gates and promotion rules.
   - If `dev` is scratch/WIP, then do not promise it will merge wholesale.

6. Restore or retire `main.preview`.
   - If it matters, add an automated workflow that deploys `main.preview` from `main`.
   - If it does not matter, remove it from active environment docs.

7. Add branch drift reporting.
   - A scheduled workflow can report:
     - `origin/dev` ahead/behind `origin/main`
     - demo deployed SHA
     - prod deployed SHA
     - stale `main.preview`

### P2 - Scale-Up Model

8. Move toward trunk/GitHub Flow.
   - Work happens on short-lived branches.
   - PR previews exist for every reviewable branch.
   - `main` stays deployable.
   - Release risk is controlled by flags and environment config, not by long-lived divergent branches.

9. Use feature flags deliberately.
   - Incomplete work merges disabled.
   - Demo can enable certain non-prod features.
   - Flags get removed after rollout so they do not become hidden branches.

10. Promote immutable build artifacts for production-like staging.
    - For now, Sitelayer builds per deploy.
    - Later, build once, test once, deploy same artifact to staging/demo/prod with different env/secrets.

## Industry Pattern Check

The recommendation above is consistent with common SaaS practice:

- GitHub Flow keeps `main` as the deployable source of truth and uses short-lived branches/PRs.
- Trunk-based development pushes the same idea harder: small changes, short-lived branches, feature flags for incomplete work.
- Review apps/preview deployments are disposable PR environments, not stable product environments.
- Stable staging/demo environments are usually deployment targets with separate config, data, and secrets, not separate code branches.
- The Twelve-Factor config principle applies directly here: environment differences belong in env vars/config/backing services, not in branched code.

Sources:

- GitHub Flow: https://docs.github.com/en/get-started/using-github/github-flow
- GitHub Actions environments/deployment protection: https://docs.github.com/en/actions/reference/deployments-and-environments
- Trunk-based development, short-lived branches: https://trunkbaseddevelopment.com/short-lived-feature-branches/
- Trunk-based development, feature flags: https://trunkbaseddevelopment.com/feature-flags/
- Heroku Review Apps: https://devcenter.heroku.com/articles/github-integration-review-apps
- GitLab Review Apps: https://docs.gitlab.com/ci/review_apps/
- Vercel preview/custom environments: https://vercel.com/docs/deployments/git
- Twelve-Factor App config: https://12factor.net/config

## Decision

Recommended decision:

Keep demo as a persistent environment and DB. Stop using `demo` as a permanent code branch.

Concrete next state:

- `main` = production.
- `dev` = temporary integration branch/environment while product discovery is fast.
- `demo` = environment deployed from `dev` by default for now, manually overridable to any SHA/ref.
- Later: demo deploys from `main` or a release tag once stability matters more than newest functionality.

This keeps ease of deployment now while avoiding the long-term pain of three divergent histories.
