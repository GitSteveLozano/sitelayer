# Sitelayer Deployment Strategy

> Status: living strategy + handoff artifact. Last verified against the repo on
> 2026-06-02 at `main == dev == d3d870e1`, 0 open PRs, 0 GitHub Actions.
> This document is decisive on purpose: it names the mechanism, size, and cost
> for each recommendation so a successor can act without re-deriving the system.
>
> **Framing correction (this revision).** An earlier draft implied the control
> plane is "one personal laptop" and partly justified the cloud move on
> _resource limits_. Both are wrong and are corrected throughout: the control
> plane runs on a **real multi-machine Tailscale fleet** with serious compute
> (off-site authority `mesh-hetzner` plus ~6 local machines, a healthy 66.5 GB
> fleet Postgres — roughly $10k/mo to rent the equivalent). The cloud-migration
> and handoff drivers are **developer coordination, shared/non-personal control,
> and clean ownership transfer — not capacity.** The only genuine product-hosting
> _sizing_ item is the deliberately-tiny customer-facing DO managed Postgres
> (`db-s-1vcpu-1gb`, ~$15/mo to bump), which is a cost choice decoupled from the
> fleet's capacity. Multi-tenancy invariants now live in
> [`docs/MULTI_TENANCY.md`](./MULTI_TENANCY.md).

---

## Progress tracker

This batch (`integrate/strategy-exec`) landed the operation-readiness slice of
this strategy: it fixes the single biggest risk in §1 (single-tenant worker) and
the surrounding scale/security/governance hardening. The table below records what
is **done** in this batch vs. what is **groundwork** the operator still provisions.

| Item                                              | Status         | Where                                                                                      |
| ------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| Worker multi-tenant drain (single-tenant sweep)   | ✅ done        | `apps/worker/src/{companies,worker}.ts`                                                    |
| Per-company QBO-live flag (fail-safe dry-run)     | ✅ done        | migration `144_company_qbo_live.sql`, `apps/worker/src/qbo-live.ts`                        |
| `asset_deployments` RLS (ENABLE + FORCE + policy) | ✅ done        | migration `145_asset_deployments_rls.sql`                                                  |
| RLS forced-coverage blocking audit gate           | ✅ done        | `apps/api/src/routes/rls-force-audit.ts` (`RLS_PHASE3_FAIL_ON_LEAK`)                       |
| RLS gap closure (forced-coverage + allowlist)     | ✅ done        | mig `145` + `rls-force-audit.ts` ratchet — see `docs/MULTI_TENANCY.md`                     |
| Single-tenant sweep (no `ACTIVE_COMPANY_SLUG`)    | ✅ done        | worker drains all companies; slug is now an optional override only                         |
| Generic / multi-company onboarding                | 🟡 in progress | `apps/api/src/routes/companies.ts` (admin-gated create), `routes/invites.ts` invites       |
| Multi-tenancy invariants reference                | ✅ done        | `docs/MULTI_TENANCY.md` (RLS GUC, membership boundary, per-company operation/billing)      |
| Pre-push governance hook                          | ✅ done        | `.githooks/pre-push`, `scripts/install-git-hooks.sh`                                       |
| Post-deploy smoke (tier-aware)                    | ✅ done        | `scripts/smoke-tier.sh`, `npm run smoke:dev/demo`                                          |
| Company-create gate (platform-admin by default)   | ✅ done        | `apps/api/src/routes/companies.ts`                                                         |
| Per-company rate limit                            | ✅ done        | `apps/api/src/rate-limit.ts`                                                               |
| Mesh AI-chat feature flag (off unless configured) | ✅ done        | `apps/api/src/mesh-dispatcher.ts`, `routes/ai-chat.ts`                                     |
| Doc reconcile (e2e/README, PITR/DR, UptimeRobot)  | ✅ done        | `e2e/README.md`, `docs/DR_RESTORE.md`, `docs/UPTIME_ROBOT_MONITORS.md`                     |
| Terraform IaC skeleton                            | ⏳ groundwork  | `infra/terraform/*` — operator runs `terraform import` + `apply`                           |
| E2E runner (script + systemd unit)                | ⏳ groundwork  | `scripts/e2e-runner.sh`, `ops/systemd/sitelayer-e2e-runner.*` — runs on a quiet fleet node |
| Ops-VM migration runbook                          | ⏳ groundwork  | `docs/OPS_VM_MIGRATION.md` — operator executes the cutover                                 |

### ⚠️ Operator actions required at PROD deploy

These are **intentional fail-safe defaults**. Without the operator action, the
relevant feature stays in its safe (off / dry-run / gated) posture.

- **(a) QBO go-live for `la-operations`.** The worker now drains every company,
  but every company starts in **dry-run** (synthetic ids, no Intuit POST). To
  keep `la-operations` live on QBO you must do **both**: set its
  `integration_connections.qbo_live_enabled = true` **and** set the cluster-wide
  `QBO_LIVE_*` env (the kill switch). `live = QBO_LIVE_*=1 AND
qbo_live_enabled=true`; either off keeps the company in dry-run. This is
  deliberate — no company goes live by accident.
- **(b) Open company signup.** `POST /api/companies` is now **platform-admin
  gated by default**. Set `ALLOW_OPEN_COMPANY_SIGNUP=1` only if you want to keep
  the historical self-serve company-creation flow open.
- **(c) AI chat.** The in-app operator AI chat is **disabled** unless mesh access
  is configured: set `MESH_API_URL` (and `AI_CHAT_ENABLED`). With `MESH_API_URL`
  unset the chat widget reports disabled and the route is inert.

---

## 1. Executive summary

**What we have.** Sitelayer is a multi-tenant construction SaaS on DigitalOcean
(2 droplets, 1 _tiny_ managed Postgres cluster, Spaces, Container Registry, with
Cloudflare DNS and Clerk auth). It runs a 4-tier ladder — **prod / dev / demo /
PR-preview**. The build, verification, and deploy plane runs today on **the
operator's private Tailscale fleet** — a real multi-machine control plane (an
off-site authority `mesh-hetzner` plus ~6 local machines: `taylor-pc`,
`minisforum`, `system76`, `alienware`, `beelink`, …), with serious compute
(~$10k/mo to rent the equivalent) and a healthy 66.5 GB fleet Postgres. It is
**not** a resource constraint. The deploy commands run from `taylor-pc` today,
but that is a _placement_ choice on a private network, not a capacity ceiling.
There are **zero GitHub Actions** (`quality.yml` deleted; deploy workflows removed
in `70b9584b`). The single quality authority is `scripts/verify-local.sh`, run
locally by the deploy path. Prod ships via an immutable image (BuildKit → DO
Container Registry → flock-locked SSH → `pg_dump` backup → checksummed migrations →
health check → rollback markers); dev/demo/preview run source-mounted watch-mode on
a shared 2 vCPU/4 GB droplet.

**Where it's going.** Three forces converge: (a) prove the product with **many
construction companies** (multi-tenant), (b) move the control point to a **shared,
non-personal home** so a team can operate it, (c) **hand off** to a new owner (the
repo is already `GitSteveLozano/sitelayer`). The blocker is **not** compute and
**not** the fleet's capacity — it is **access, ownership, and coordination**:
multiple developers cannot all join the operator's private Tailnet and SSH the
fleet to deploy, and a new owner cannot inherit personal machines. The fix is to
put the deploy authority on a **shared, non-personal control point** — that can be
**another fleet node or a small cloud VM**; the point is "not one person's personal
box," not "more power."

**The single biggest risk — now closed.** The historical top risk was the
**single-tenant background worker**: it hardwired `ACTIVE_COMPANY_SLUG ?? 'la-operations'`
and every drain ran `where company_id = $1` for that one company, so selling to a
second company would have left their entire money-movement path (QBO sync, rental
invoicing, estimate push, payroll) silently dead — rows queued in `mutation_outbox`
and never drained. **This batch landed the single-tenant sweep:** the worker now
drains **all** companies (`apps/worker/src/companies.ts` → per-company GUC drain),
the QBO-live gate is **per-company** (mig `144`), `asset_deployments` RLS is
enabled-and-forced (mig `145`), and the RLS forced-coverage audit is a **blocking
gate**. Tenant _data_ isolation (RLS) was already solid; tenant _operation_ now is
too. The
remaining multi-company work is onboarding/billing polish (§5), not a correctness
hole. See [`docs/MULTI_TENANCY.md`](./MULTI_TENANCY.md) for the invariants.

---

## 2. Current-state architecture

### 2.1 The fleet ↔ DigitalOcean boundary

- **The fleet owns the control plane.** The control plane is the operator's
  multi-machine Tailscale fleet — `mesh-hetzner` (off-site authority) plus ~6 local
  machines (`taylor-pc`, `minisforum`, `system76`, `alienware`, `beelink`, …),
  serious compute and a 66.5 GB fleet Postgres. The Sitelayer deploy commands run
  from **`taylor-pc` today** (one node of that fleet): it (a) **builds** the prod
  image (host compile of `npm run build`, then `docker buildx --target runtime --push`,
  `deploy-production-local.sh`), (b) runs the **verification gate**
  (`scripts/verify-local.sh`), (c) is the current **deploy initiator** — manual
  `scripts/deploy.sh` plus a **user-level systemd timer** for dev/demo only
  (`ops/systemd/sitelayer-auto-deploy.timer`, every 2 min; prod is _refused_,
  `fleet-auto-deploy.sh:174`), and (d) holds the doctl creds + SSH keys + build cache.
  Running this on `taylor-pc` is incidental placement on a private network, not a
  capacity limit — any fleet node (or a small shared VM) can host it; the reason to
  _move_ it is access/ownership, not compute (§6, §7).
- **DigitalOcean hosts, stores, routes.** 2 droplets run the containers; managed
  Postgres 18 cluster `sitelayer-db` (`db-s-1vcpu-1gb`) stores all 4 tier databases;
  DO Container Registry `sitelayer` holds prod images; DO Spaces
  `sitelayer-blueprints-prod` holds blueprint PDFs. Caddy (prod) / Traefik (preview)
  run _on the droplets_; DO only supplies the network and reserved IPs. DNS is
  Cloudflare; auth is Clerk.

### 2.2 The 4 tiers

| Tier        | URL                                   | Droplet             | Database (cluster `sitelayer-db`)                        | Edge    | Deploy mechanism                                                       |
| ----------- | ------------------------------------- | ------------------- | -------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| **prod**    | `sitelayer.sandolab.xyz`              | prod `566798325`    | `sitelayer_prod` (public schema)                         | Caddy   | **Immutable image**, manual `deploy.sh prod`, flock-locked SSH swap    |
| **dev**     | `dev.sitelayer.sandolab.xyz`          | preview `566806040` | `sitelayer_dev` (public schema)                          | Traefik | Source-mounted watch-mode; manual `deploy.sh dev` **or** auto-watcher  |
| **demo**    | `demo.preview.sitelayer.sandolab.xyz` | preview `566806040` | `sitelayer_demo` (public schema)                         | Traefik | Watch-mode + idempotent `seed:demo` each deploy; tracks `origin/dev`   |
| **preview** | `pr-N.preview.sitelayer.sandolab.xyz` | preview `566806040` | `sitelayer_preview` (per-slug schema `sitelayer_<slug>`) | Traefik | Watch-mode, ephemeral, self-reaping (`deploy-preview.sh`) — **manual** |

Both dev and demo track `origin/dev` (`AUTODEPLOY_DEFAULT_BRANCH=dev`). PR previews
isolate per-slug via `PGOPTIONS` search_path and self-reap on PR close. The single
preview droplet (2 vCPU/4 GB, Traefik on one router) hosts **dev + demo + every PR
preview** and is also the off-host backup target (`10.118.0.2`).

### 2.3 Builds

Prod is a **thin packaging image** — the app is compiled on the fleet host; the
Dockerfile only `npm ci --omit=dev` + COPYs the prebuilt `dist`. Tagged
`registry.digitalocean.com/sitelayer/sitelayer:<git-sha>` and `:main`, GC keeps
`:main` + `:buildcache` + newest 10 SHA tags. The **web bundle budget gate**
(`check-web-bundle-budget.mjs`: 160 KB gz initial JS / 110 KB eager-chunk / 72 KB
m-chunk) runs inside the build stage. dev/demo/preview do **no image build** —
`node:20-alpine` with source bind-mounted, `rsync --delete` + `tsx` watch + Vite HMR.

### 2.4 The local verify gate — the single quality authority

`scripts/verify-local.sh` (replaces the deleted `quality.yml`), three levels:

- **fast** — static + build + unit (~2889 cases across ~285 files). Quick iteration.
- **standard** _(DEFAULT / prod gate)_ — fast **+ docker-postgres integration**
  (isolated `postgres:18`, auto-free-port, migrations applied, real API booted).
  Deterministic and reliable.
- **full** — standard **+ Playwright e2e** (full app stack + real browser).

**e2e is opt-in** because it flakes (`browser/page-closed`) when it runs on
`taylor-pc` — not because that box is weak, but because it is **busy** running the
mesh control plane, the browser-bridge, and other fleet workloads, which steals
CPU/scheduling from Playwright. It is deterministic on any **quieter fleet node**.
This is the central testing gap (§4) — a placement problem, not a hardware one.
Migrations are **forward-only, immutable, checksum-ledgered**
(`migrate-db.sh`: editing an applied migration aborts the next deploy with exit 3);
they live in `docker/postgres/init/` (147 files, numbered to `143_*`).

### 2.5 The push / auto-deploy model (and where the gate actually runs)

- **prod**: `deploy.sh prod` → `verify-local.sh` **standard** before the build; aborts
  on failure. Break-glass `FORCE_DEPLOY_UNCHECKED=1`. e2e is **not** run.
- **dev/demo (manual)**: `deploy.sh dev|demo` defaults to `VERIFY_LEVEL=fast` — **no
  integration, no e2e**.
- **dev/demo (auto)**: the 2-min watcher runs `SKIP_VERIFY=1 bash deploy.sh <tier>`
  (`fleet-auto-deploy.sh:221`) — **no gate at all**. The header justifies this as "SHA
  already gated at land time," but **no land-time enforcement exists**: `.git/hooks/`
  is empty (samples only), there are no required status checks, no second reviewer.

**Net:** a push to `origin/dev` auto-ships to both dev **and** the prospect-facing demo
within ~2 min with zero verification. Failed-SHA backoff stops a retry-storm, but only
_after_ a broken SHA already deployed.

---

## 3. Push-to-main/dev governance + branch/preview model

**Today:** solo trunk-ish. `main == dev == 98be2519`, one human author (two name
spellings), squash-merged self-authored PRs, no enforced gate. `configure-github-
protection.sh` exists but is unapplied; `main`/`dev`/`demo` are all `protected:false`.

### Recommended go-forward (the governance ladder)

**Stage A — solo, now (do this week):**

1. **Repo-tracked pre-push hook** (the missing land-time enforcement). Install via
   `core.hooksPath` (so it is versioned, not a stray `.git/hooks` file): pushes to
   `dev`/`main` run `npm run verify` **standard** (static + build + unit +
   integration). Bypassable with `--no-verify` for emergencies. **This makes the
   watcher's "already gated at land time" assumption true instead of aspirational.**
   Keep e2e _out_ of the hook — it belongs on the async runner (§4).
2. Keep `main == dev` trunk-ish and keep the 2-min watcher; the hook now guards the
   land that the watcher trusts.

**Stage B — small team (weeks):** formalize `main = production truth`, `dev = a
_temporary_ integration lane` with a documented `dev → main` promotion ritual
(per `BRANCH_ENVIRONMENT_AUDIT_2026-06-01`). **Restore PR-N preview auto-deploy** —
lost with the Actions removal, now manual-only (`PREVIEW_DEPLOYMENTS.md:131`). Give
the watcher a `preview` mode (or a tiny fleet script triggered on PR open) so the
"preview every reviewable branch" leg of trunk-flow works again.

**Stage C — handoff / team-scale (couple months):** apply GitHub branch protection on
`main` via `configure-github-protection.sh` (PR + 1 review, no force-push). **Keep
`required_status_checks: null`** — there is no hosted check to require, and setting one
without it wedges every PR. Move to GitHub-Flow: short-lived feature branch → PR →
auto preview → squash to `main`; `main` always deployable; demo deploys from `main`
or a release tag rather than `dev`.

> Branch protection's value is **review discipline for a team/handoff, not
> regression-catching** — that is §4's job. Apply it when a second engineer joins,
> not before.

---

## 4. Testing & regression enforcement — closing the e2e gap

**The gap, stated precisely.** e2e is opt-in `--full` and wired into **no** automated
path. dev/demo auto-deploys run nothing; manual dev/demo run `fast`; prod runs
`standard` (integration) but **never e2e**. The 10 Playwright specs in `e2e/tests/`
(admin project lifecycle, estimate push, time→payroll, closeout rollup, rental
billing, foreman field event + smokes) drive the deterministic-workflow surfaces
end-to-end through the real SPA — **this is the navigation/role-flow regression net,
and it currently runs nowhere automatically.** `e2e/README.md:48` still claims the
suite "executes via the local gate's e2e step" — that invariant is now false.

### The options

- **A — dedicated quiet always-on e2e runner** _(primary recommendation)_.
- **B — post-deploy smoke against the live dev/demo tier** (cheapest, do in parallel).
- **C — nightly full-gate + replay-sweep cron** (belt-and-suspenders).
- **D — pre-push hook** (the §3 land-time enforcement; standard, not e2e).
- E — GitHub branch protection (review discipline; not regression-catching).

### Primary recommendation: **Option A — a dedicated quiet e2e runner**

Stand up an `install-e2e-runner-systemd.sh` timer (mirror the proven
`install-replay-sweep-systemd.sh` pattern — the fleet already runs 7 such timers) on a
**quiet box that does not flake**. The fleet has the capacity already: pick a
**quieter fleet node** (one of `minisforum` / `system76` / `alienware` / `beelink`
— anything that is _not_ `taylor-pc`, which is busy with the mesh control plane and
browser-bridge). A rented droplet (the preview droplet off-hours, or a $6/mo
throwaway) is a fine fallback but **not required** — this is about giving Playwright
an idle scheduler, which the fleet already has in spades. It checks out `origin/dev`
(and `origin/main`), runs `npm run verify:full` (e2e is deterministic on an idle
box), and on failure emits to **Sentry + the existing Pushover route**. Cadence:
hourly or per-`dev`-advance.

**Why A is the primary:** it restores _exactly_ the net CI used to run, but
**decouples flakiness from the deploy gate** so e2e can never block a ship. It uses an
already-accepted operational pattern (systemd timers on the fleet/droplets) and needs
no GitHub Actions. The other options are complements, not substitutes:

- **Do B in the same week** (highest ROI for lowest cost): add the missing
  `demo:smoke`/`dev:smoke` npm script (the `BRANCH_ENVIRONMENT_AUDIT` P0 #4 spec —
  `POST /api/demo/sign-in-link`, `/demo → role → desktop`, `/api/session` + `/bootstrap` 200) and run `verify-prod-deploy.sh`-style checks at the **tail of every
  `fleet-auto-deploy.sh` deploy** (it already runs for prod, not dev/demo). This
  catches "auto-shipped a broken SHA to demo prospects" within ~2 min. Also **actually
  provision the 3 documented UptimeRobot monitors** (`UPTIME_ROBOT_MONITORS.md` — still
  references the deleted `deploy-droplet.yml`; fix that doc).
- **C** folds the existing daily prod `replay-workflow-sweep.sh` alert into the same
  channel and adds one nightly `verify:full` on the Option-A box — catches drift on
  no-deploy days.

**Result:** the deterministic net (unit + integration) gates every land via the §3
hook; the navigation/e2e net runs async on a quiet box and alerts loudly; live tiers
get a post-deploy smoke. No gate is ever blocked by browser flake.

---

## 5. Scaling to many construction companies

**Data isolation = ready. Operation = multi-tenant (this batch). The only sizing
item is the deliberately-tiny customer-facing DB — a cost choice, not a fleet limit.**

### What's solid

- **RLS is enabled + forced** on ~74 company-scoped tables (`066` policies, `073`/`085`/
  `101` enable/force). Prod connects as a **non-owner `NOBYPASSRLS` role** so FORCE
  applies (`DEPLOY_RUNBOOK.md:307`). Every request binds `app.company_id` via
  `SET LOCAL` (`withMutationTx`/`withCompanyClient`).
- **The real boundary is membership:** `getCompany()` (`server.ts:408`) requires a
  `company_memberships` row for the resolved Clerk user. The act-as bypass is
  structurally prod-disabled. Cross-tenant access needs both a valid identity **and** a
  membership in the target company.

### The blockers (status — the correctness holes are closed this batch)

1. **#1 — single-tenant worker → ✅ closed (single-tenant sweep).** The drain now
   iterates **all** companies (`apps/worker/src/companies.ts`'s `listActiveCompanies`,
   GUC set per claimed row's `company_id`) — exactly how the notification drain already
   works cross-tenant. `ACTIVE_COMPANY_SLUG` survives only as an **optional override**
   for single-company deploys. Companies beyond `la-operations` now drain their
   QBO/billing/payroll queues.
2. **#2 — per-company QBO live → ✅ closed.** The go-live gate moved off the global
   `QBO_LIVE_*` process env onto a **per-company** flag
   (`integration_connections.qbo_live_enabled`, migration `144`); live now requires
   `QBO_LIVE_*=1 AND qbo_live_enabled=true` so you **can** stage company #2 in dry-run
   while #1 is live. The cluster-wide `QBO_LIVE_*` remains as a kill switch.
3. **RLS gaps → ✅ closed.** (a) `asset_deployments` now has a `company_isolation`
   policy + ENABLE/FORCE (migration `145_asset_deployments_rls.sql`). (b) The
   permissive-when-NULL hazard (a bare `pool.query` that forgets the GUC) is now caught
   by a **blocking gate**: `apps/api/src/routes/rls-force-audit.ts` runs in the
   `verify-local.sh` integration stage with `RLS_PHASE3_FAIL_ON_LEAK=1` and an
   **allowlist ratchet** — any new forced-coverage leak fails the deploy. Invariants and
   the ratchet are documented in [`docs/MULTI_TENANCY.md`](./MULTI_TENANCY.md).

### Capacity & cost trajectory

The one genuine sizing item is the **deliberately-tiny customer-facing
`db-s-1vcpu-1gb` managed Postgres (~22 usable connections)** holding prod + dev +
preview + demo on **one node**. Prod API pool = 16 + worker = 4 ≈ 20 — already at
budget _before_ non-prod connections from the same cluster compete. This is a
**cost choice on the product-hosting footprint**, fully decoupled from the fleet's
capacity: the build/verify/e2e plane runs on the multi-machine fleet, which can host
the prod image build, multiple environments, and the async e2e runner with room to
spare. Bumping the customer DB is cheap and on-demand; nothing here is a fleet limit.

| Tenant count     | Action                                                                                                                                                      | Cost    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **1–3 light**    | Fine today once dev/preview/demo are moved off the prod DB (worker is already multi-tenant)                                                                 | —       |
| **~5–15 active** | Resize the customer DB to `db-s-2vcpu-4gb` (≈97 conns) at `> 18` used / `> 70%` CPU sustained 1h; add PgBouncer transaction-mode pooler                     | +$15/mo |
| **~15–40**       | 4 GB+ customer DB; consider a 2nd / per-tenant worker; Clerk Pro (`>80` orgs / `>40k` MAU)                                                                  | +$25/mo |
| **~50+**         | The single-droplet + single-DB **product hosting** topology benefits from a managed cloud service (horizontal API, dedicated worker, pooled/partitioned DB) |

**Also before scale:** per-company rate limits now exist (`rate-limit.ts`); still add
a Spaces **retention/quota** policy (blueprints are retained indefinitely in one
bucket; 250 GB included). **Onboarding (in progress):** `POST /api/companies` is now
**platform-admin gated by default** (`platform_admins` / `PLATFORM_SUPERADMIN_CLERK_IDS`,
with an `ALLOW_OPEN_COMPANY_SIGNUP=1` escape hatch) — the self-serve "any authed user
becomes admin" hole is closed. The remaining work is a **generic, repeatable
multi-company onboarding flow** (admin-driven company create + email-token invites
via `134_company_invites` / `routes/invites.ts`, which already make crew onboarding
low-friction by email, not Clerk user_id) so each new construction company is a
turn-key, documented step rather than a bespoke one.

---

## 6. Cloud migration (couple-months horizon)

> **The driver is developer coordination + clean handoff — not compute.** The fleet
> has ample capacity (§1, §2.1, §5). What it does **not** have is a way for multiple
> developers to operate it without each joining the operator's private Tailnet and
> SSH-ing personal machines, or a way for a new owner to inherit it. The move is about
> a **shared, non-personal control point** and an auditable, access-controlled deploy
> surface — _not_ "more power."

### Move the deploy authority OFF `taylor-pc` — the concrete near-term target

This is the **deploy-authority-off-`taylor-pc`** move, and it is about a **shared,
non-personal control point**, not capacity. The target can be **another fleet node**
or a **small cloud VM** — the requirement is "not one person's personal box that a
teammate can't reach and a successor can't inherit," not "a bigger machine."

**Recommendation: a small dedicated always-on "deploy/ops" control point** — either a
quieter **fleet node** dedicated to this role, or a $6–12/mo DO droplet in the **same
account and region** — running `scripts/deploy.sh`, `scripts/verify-local.sh`, and the
auto-deploy systemd timer, with a **dedicated deploy SSH key + dedicated git deploy
token** (not Taylor's personal creds). A small cloud VM is often the cleaner pick
**because it is reachable and inheritable without the private Tailnet**, which is the
whole point — not because it is faster.

**Why this and not the alternatives:**

- It **breaks the personal-machine + private-network dependency immediately with zero
  rewrite** — the scripts already run unprivileged via SSH + doctl. Smallest
  reversible step. (Reachability/ownership win, not a performance win.)
- **Not** managed PaaS (App Platform / Render / Fly) as the _first_ move: it would
  require re-platforming the multi-container Caddy + api + web + worker stack, the
  on-droplet migrate/backup/health choreography, and the per-tier preview-schema model
  — too large for the couple-months horizon. It is a legitimate _end-state_ once the
  product stabilizes.
- **On "no GitHub Actions":** that decision was about not depending on GitHub's deploy
  **orchestration**, not a blanket ban on any hosted runner. For a **team and a
  handoff**, the cleanest form is a **minimal** Actions workflow (`checkout → npm ci →
npm run verify → deploy.sh`, secrets in GitHub Environments) so every developer
  deploys through the **same shared, access-controlled surface** — and the new owner
  controls the deploy authority via the repo they already own
  (`GitSteveLozano/sitelayer`), with audit history and **no personal machine to
  inherit**. This is the coordination/ownership win, not a compute one; keep
  `verify-local.sh` as the single gate _definition_ regardless of where it runs.

### IaC / reproducibility

There is **zero IaC** (no `.tf`/Pulumi/bicep). All DO resources were hand-provisioned
via doctl and documented only in prose (`INFRASTRUCTURE_READY.md`). Author a
**Terraform module** for the DO footprint (2 droplets, managed PG + per-tier
databases/roles, Spaces incl. off-region, registry, both firewalls, reserved IPs, VPC;
`cloudflare` provider for DNS), and a `make bootstrap` one-command stand-up that
renders `ops/env/production.env.json` as the env manifest. This gives a successor a
reproducible stand-up and a disaster-rebuild path that today is tribal knowledge.

### Observability / on-call / backup gaps

- **DB / RPO conflict:** `DR_RESTORE.md` and `COST_AND_LIMITS.md` claim "7-day PITR on
  every plan," but DO does **not** allow a standby on `db-s-1vcpu-1gb`; the real
  recovery path is daily logical `pg_dump` ≈ **24h RPO**. Either upsize to a plan that
  supports a standby + true PITR (+$15/mo) **or correct the docs** so on-call isn't
  misled. Split prod off the shared cluster regardless.
- **Backup co-location:** off-host dumps go to the preview droplet (same DO account,
  same `tor1` region). The only off-region copy is an optional daily
  `pg_dump → Spaces(nyc3)` timer that is **not auto-enabled**. Provision it.
- **Gaps to close:** no log aggregation (`docker compose logs` on the droplet only),
  no DB-metrics dashboard/alerting beyond Sentry, no app-side DB circuit breaker
  (`INCIDENT_RESPONSE` §2 flags this), paging is UptimeRobot → Pushover to one person.

---

## 7. Handoff plan — de-risk every Taylor-personal dependency

Ordered checklist. The product is `GitSteveLozano/sitelayer` already — **the repo
owner (Steve) ≠ the infra owner (Taylor)**, which is itself the core hazard. The
hazard is **access and ownership, not capacity**: the fleet is powerful, but it is
_personal_ — a teammate can't reach it without joining the private Tailnet, and a
successor can't inherit personal machines. Every item below replaces a Taylor-personal
dependency with a **shared, transferable** one.

**P0 — break the personal-machine and personal-network dependencies:**

1. Move the **deploy authority + auto-deploy watcher** off `taylor-pc` onto the
   **shared, non-personal control point** (§6 — a dedicated fleet node or a small cloud
   VM, whichever is more reachable/inheritable for the team) with dedicated keys/tokens.
   This is about reachability and ownership, not a faster box.
2. **Decouple the in-app AI chat from private mesh.** `apps/api/src/mesh-dispatcher.ts`
   - `routes/ai-chat.ts` read `MESH_API_URL` (`http://mesh-hetzner:8713`, reachable
     only inside Taylor's Tailnet) + `SITELAYER_CHAT_WEBHOOK_TOKEN`. Without them the
     widget returns `ok:false`/503. Make it cleanly **feature-flaggable OFF** for a new
     owner, or re-point it at a product-owned service. Remove the Tailscale assumption
     from on-call runbooks (`INCIDENT_RESPONSE`/`UPTIME_ROBOT` assume SSH "via
     Tailscale").
3. **Transfer DigitalOcean account ownership** — droplets, DB, Spaces, registry,
   firewalls, reserved IPs, doctl token. Today it is one personal DO account.

**P1 — re-home identity, secrets, and domain:**

4. Re-home **Clerk** app to a product-owned org; move **Sentry** org off `sandolabs`.
5. **Rotate ALL secrets** during transfer per `SECRET_ROTATION.md` (`DATABASE_URL`,
   `CLERK_*`, `QBO_*`, `DO_SPACES_*`, deploy SSH key, `DIGITALOCEAN_ACCESS_TOKEN`,
   `API_METRICS_TOKEN`). Prod env is a hand-maintained on-droplet `/app/sitelayer/.env`
   (mode 600, rendered from `production.env.json`) — there is no managed secret store.
6. **Decide the product domain.** `sandolab.xyz` is Taylor's personal lab domain on his
   Cloudflare Registrar; Clerk/QBO redirect URIs, `ALLOWED_ORIGINS`, Caddy, and `VITE_*`
   are all hardcoded to `*.sandolab.xyz` and need re-issue/rebuild.

**P2 — governance + documentation:**

7. Confirm `GitSteveLozano/sitelayer` admin + update `CODEOWNERS`.
8. Write a single canonical **OWNERSHIP & HANDOFF** doc naming the authoritative
   source-of-truth docs (`CLAUDE.md`, `DEPLOY_RUNBOOK.md`, `DR_RESTORE.md`,
   `SECRET_ROTATION.md`, `INCIDENT_RESPONSE.md`) and marking the many dated planning
   docs as historical.

---

## 8. Phased roadmap

> **The former #1 priority — fix the single-tenant worker (§5 blocker #1) — is
> ✅ done this batch** (single-tenant sweep: the worker drains all companies). That
> was the one item gating "sell to a second company," and it was a code change, not an
> infra project. The remaining roadmap is parallelizable; none of it is blocked on
> fleet capacity.

### NOW (this week — solo, ~1–2 days of work)

1. ✅ **Worker drains all companies** (single-tenant sweep) — _done this batch_;
   `ACTIVE_COMPANY_SLUG` is now an optional override only.
2. **Pre-push hook** running `npm run verify` standard on `dev`/`main` pushes
   (`core.hooksPath`, `--no-verify` bypass) — makes land-time gating real.
3. **Post-deploy smoke** at the tail of `fleet-auto-deploy.sh` for dev/demo + the new
   `demo:smoke` script; **provision the 3 UptimeRobot monitors** and fix that doc.
4. **Stand up the dedicated quiet e2e runner** (Option A) on a **quieter fleet node**
   (not `taylor-pc`); a rented droplet is an optional fallback, not required. Nightly
   `verify:full` → Sentry + Pushover.

### SCALE (multi-company — weeks)

1. ✅ **Per-company QBO live flag** (mig `144`, off the global env) so #2 can run
   dry-run while #1 is live — _done this batch_.
2. **Move dev/preview/demo off the prod DB**; resize the **customer DB** to
   `db-s-2vcpu-4gb` (+$15, a product-hosting cost choice — not a fleet limit) at `>18`
   conns / `>70%` CPU; add a PgBouncer transaction-mode pooler.
3. ✅ **RLS gaps closed:** `asset_deployments` policy + ENABLE/FORCE (mig `145`); RLS
   forced-coverage audit is a **blocking gate** (`rls-force-audit.ts`,
   `RLS_PHASE3_FAIL_ON_LEAK=1` + allowlist ratchet) — _done this batch_; invariants in
   `docs/MULTI_TENANCY.md`.
4. ✅ **Per-company rate limits** (`rate-limit.ts`) — _done_; still add a **Spaces
   retention/quota** policy.
5. ✅ **`POST /api/companies` gated** behind `platform_admins` (escape hatch
   `ALLOW_OPEN_COMPANY_SIGNUP=1`) — _done_. **In progress:** the generic, repeatable
   multi-company onboarding flow (admin-create + email-invite, `routes/invites.ts`).

### CLOUD (couple months) — driver: developer coordination + clean handoff, not compute

1. **Move the deploy authority + watcher onto the shared, non-personal control point**
   (a quieter fleet node or a small cloud VM — whichever is most reachable/inheritable
   for the team) **or** a minimal GitHub Actions deploy workflow (secrets in GitHub
   Environments) — off `taylor-pc`. The reason is access/ownership for a team, not more
   power.
2. **Terraform the DO + Cloudflare footprint** + `make bootstrap` one-command stand-up.
3. **Reconcile the PITR claim:** upsize to a standby-capable plan **or** correct the
   docs to the true ~24h RPO; auto-enable the off-region Spaces backup.
4. **Observability:** log aggregation, DB-metrics dashboard + alert on
   `pg_stat_activity > 70%` of cap, the missing app-side DB circuit breaker, a real
   pager rotation.

### HANDOFF

1. Execute the §7 checklist in order: **P0** (shared control point + mesh-chat
   decouple + DO account transfer) → **P1** (Clerk/Sentry re-home, rotate all secrets,
   product domain) → **P2** (GitHub admin/CODEOWNERS, the OWNERSHIP & HANDOFF doc).
2. Confirm a successor can **deploy prod and run the full gate without `taylor-pc` and
   without Taylor's private Tailnet** — that is the definition of "handed off." The
   blocker was always access/ownership, never the fleet's capacity.
