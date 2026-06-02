# Sitelayer

Construction operations platform: blueprint takeoff, estimation, crew scheduling, and QBO sync.

## Collaborator Workstation Override

If this checkout lives under `~/projects/collaborator-system/`, treat the
machine as a collaborator Mac, not Taylor's operator workstation. In that mode:

- do not require Mesh, control-plane, Tailscale, Bitbucket, browser-bridge, or
  Taylor's private credentials;
- do not add Mesh planning notes or upsert Mesh runtime dependencies unless
  Taylor explicitly assigned an infra/deploy task;
- use this repo, `AGENTS.md`, and `docs/ONBOARDING_DEVELOPER.md` as the local
  source of truth;
- report missing GitHub, Docker, browser-profile, Clerk, or production access
  as blockers instead of trying to recreate Taylor's setup.

## ⚠️ Architecture at a glance

**One web app: `apps/web/`.** The old parallel frontend track was removed on 2026-05-05 (ADR 0003). New screens, primitives, and machines all go under `apps/web/src/`.

**State management:**

- **Frontend orchestration** lives in **XState** machines under `apps/web/src/machines/`. Real exemplars to copy: `project-lifecycle.ts`, `estimate-push.ts`, `time-review.ts`, `crew-schedule.ts`, `billing-review.ts`, `field-event.ts`. These own long-lived UI state (offline queue, role/company switching, multi-step approval flows). Follow `docs/DETERMINISTIC_WORKFLOWS.md` for the reducer shape.
- **Frontend data fetching/caching** lives in **TanStack Query** (`apps/web/src/lib/api/`). Resource-shaped hooks (`useProjects`, `useClockIn`, `useEstimatePush`, etc.).
- **Backend workflows** are **temporal.io-style** deterministic state machines in `packages/workflows/` (rental-billing, estimate-push, project-closeout, crew-schedule, time-review, labor-payroll, project-lifecycle, field-event, rental, daily-log, notification, shipment, damage-charge-settlement, rental-request-approval, qbo-sync-run, scaffold-ops-approval). See `docs/DETERMINISTIC_WORKFLOWS.md` and the "Workflow Inventory" section below.
- **Single HTTP client** = `apps/web/src/lib/api/client.ts:request<T>()`. `api-v1-compat.ts` is a name-bridge for the migrated XState machines and delegates to the same `request<T>()` underneath.

**Routing topology (read before adding a reachable route).** The canonical runtime shell is `apps/web/src/screens/mobile-shell.tsx` (`MobileShell`), mounted at `App.tsx`'s `/*` route via `routes/workspace.tsx`. `MobileShell` carries its OWN inline `<Routes>` table, including the `projects/:projectId/*` and `rentals/*` catchalls. To add a new reachable mobile route, add it inside **`mobile-shell.tsx` before those catchalls** (otherwise a catchall swallows it); a full-screen/specialized route instead mounts directly in `App.tsx` (e.g. `/financial/*`, `/more`) or in `more.tsx` / `financial.tsx`. **`routes/{projects,rentals,schedule,home,time,log,crew}.tsx` are legacy/dead — never mounted under the shell (and being removed). Do NOT add routes there.**

Where new code goes:

- **New screen** → `apps/web/src/screens/mobile/<name>.tsx`, then wire its route into `mobile-shell.tsx` (before the catchalls). For a specialized full-screen route, extend the relevant feature folder under `apps/web/src/screens/` and mount it directly in `App.tsx`/`more.tsx`/`financial.tsx`.
- **New primitive** → `apps/web/src/components/m/` (lowercase, e.g. `button.tsx`, `kpi.tsx`).
- **New durable UI state machine** → `apps/web/src/machines/<name>.ts`, following the patterns in the existing exemplars (`project-lifecycle.ts`, `estimate-push.ts`, `time-review.ts`, `crew-schedule.ts`, `billing-review.ts`, `field-event.ts`) and `docs/DETERMINISTIC_WORKFLOWS.md`.
- **New backend workflow** → `packages/workflows/<name>.ts` following the rules in `docs/DETERMINISTIC_WORKFLOWS.md`.
- **New API route** → `apps/api/src/routes/<name>.ts`.

Mechanical proof of the single-app invariant:

- `Dockerfile` only `COPY`s `apps/web/dist`.
- `docker-compose.prod.yml`, `.preview.yml`, `.yml` all run `@sitelayer/web`.
- Root `package.json` build chain enumerates `@sitelayer/web` only.
- `.github/dependabot.yml` tracks `apps/web/` only.

## Agent skills

This repo uses repo-local agent docs to make imported skills explicit and repeatable. When a root `SKILL.md` exists, treat it as the project-local workflow skill for this repository.

### Issue tracker

Agent workflow issues use: Mesh orchestrated tasks. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage roles are represented through the tracker mapping in `docs/agents/triage-labels.md`.

### Domain docs

Domain language lives in `CONTEXT.md` when present; durable architectural decisions live in `docs/adr/`; project-specific reading order lives in `docs/agents/domain.md`.

## Agent Coordination Source of Truth

**Last reconciled:** 2026-05-22

**Mesh project:** `sitelayer` / project ID `282`

The historical task chain `sitelayer-deploy-reconcile-20260423` is no longer
present in mesh — pilot-onboarding state has moved past it. Use
[`CRITICAL_PATH.md`](./CRITICAL_PATH.md) and the project's open health-emitter
tasks in mesh as the live source of truth for what's still required before
pilot launch.

This repo has historical planning docs that drift from the current deployment state. Use this order of authority:

1. Live code and checked-in deployment files.
2. Mesh planning/runtime records for project `sitelayer`.
3. `DEPLOY_RUNBOOK.md` (deploy/migration contract, locked down 2026-04-29 ahead of pilot).
4. `DEPLOYMENT.md` and `INFRASTRUCTURE_READY.md`.
5. Historical docs in `docs/` and older planning notes.

When an agent changes architecture, deployment, secrets layout, external services, or infrastructure:

- Add a Mesh planning note with `project=sitelayer`.
- Upsert affected Mesh runtime dependencies.
- Patch the relevant repo doc in the same turn.
- Do not rely on old prose in historical docs if it disagrees with live code.

Current Mesh runtime dependencies recorded for `sitelayer` as of 2026-04-24:

- `postgres/sitelayer-db`
- `env_file/production-env`
- `docker_container/production-compose-stack`
- `port/public-http`
- `port/preview-ssh-restricted`
- `port/droplet-public-3000-followup`
- `build_cmd/production-docker-build`
- `docker_container/tiered-object-storage`
- `env_file/app-tier-isolation`
- `postgres/sitelayer-preview-db`
- `env_file/preview-shared-env`
- `docker_container/preview-router-traefik`
- `docker_container/preview-main-stack`
- `port/preview-http-https`
- `build_cmd/preview-docker-build`

These are deployment verification/runtime records. Treat production-critical rows as required evidence when changing infra, deploy, storage, auth, or observability.

> **STALE 2026-06-01 — mesh runtime-dep ROW upsert tracked in mesh task
> `#174882` (project `282`).** The repo prose + deploy scripts are now fully
> reconciled to the local-fleet model (PR #468): deploys are local-fleet via
> `scripts/deploy.sh` with a LOCAL verification gate
> (`scripts/verify-local.sh`) run by the deploy path, and
> `env_file/production-env` is the droplet-rendered `/app/sitelayer/.env`
> (reused each deploy). **The repo now runs ZERO GitHub Actions** —
> `.github/workflows/quality.yml` was deleted (2026-06-02); the deploy
> workflows were already removed in `70b9584b`. Nothing in the pipeline
> queries GitHub Actions; the single verification authority is
> `scripts/verify-local.sh`. The 2026-04-24 `project_runtime_deps` rows above
> (and the preview rows below) still encode the old GitHub-Actions +
> self-hosted-runner deploy topology and need an operator-mode mesh upsert —
> the exact per-row changes are enumerated in mesh task `#174882` (the
> row-write tool is not in the scoped agent session; do NOT fabricate
> replacement rows here). NOTE: `docker_container/preview-router-traefik` is
> NOT stale — preview/dev/demo edge is still Traefik; only the PROD edge moved
> to Caddy. Until the rows are upserted, treat the GitHub-Actions/runner
> framing in them as historical, not current evidence.

Preview state is documented in this repo and Mesh runtime dependencies. Runtime-dep rows were reconciled on 2026-04-24 for (see STALE note above):

- `postgres/sitelayer-preview-db`
- `env_file/preview-shared-env`
- `docker_container/preview-router-traefik`
- `docker_container/preview-main-stack`
- `port/preview-http-https`
- `build_cmd/preview-docker-build`

Preview/dev/demo automation (2026-06-01): these stacks deploy from the fleet
via `scripts/deploy.sh dev|demo` → `scripts/deploy-preview.sh` on the preview
droplet (source-mounted watch-mode), NOT a self-hosted GitHub Actions runner.
The historical `sitelayer-preview` self-hosted runner is no longer part of any
deploy path now that the Actions deploy workflows are removed.

## Operating Rules (post-MVP, operate mode)

Sitelayer has shipped MVP. The agent's job in this repo is now to _keep it
running_ and add narrow features without breaking the live customer paths
(rental invoicing, blueprint takeoffs, QBO sync). Read these before
deploying, touching env, or extending the QBO integration. Each rule is
paired with _why_ it exists (often a real footgun) and _how to apply_ it.

### Deploy procedure

> **DEPLOY MODEL UPDATED 2026-06-02.** Deploys are now local-fleet via
> `scripts/deploy.sh <prod|dev|demo>`, run from a fleet box (e.g.
> taylor-pc-ubuntu) — NOT GitHub Actions. **The repo now runs ZERO GitHub
> Actions.** The deploy workflows (`deploy-droplet.yml`, `deploy-dev.yml`,
> `deploy-demo.yml`, `deploy-preview.yml`, plus `preview-gc.yml` /
> `registry-gc.yml`) were removed in commit `70b9584b`, and the last
> remaining workflow, `.github/workflows/quality.yml`, was deleted on
> 2026-06-02. `.github/workflows/` no longer exists; only non-workflow files
> (`CODEOWNERS`, `ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`) remain under
> `.github/`. Nothing in the pipeline touches GitHub Actions.
>
> **Adopted operating model (2026-06-02):** `main` is production truth. The
> single verification authority is **`scripts/verify-local.sh`** (also
> `npm run verify`) — there is no CI gate. It is run **locally by the deploy
> path**: `scripts/deploy.sh prod` runs the **standard** gate (shell-syntax,
> migration-immutability, prettier, lint, typecheck, unit tests,
> dockerfile-import guard, then `web:bundle-budget` after the build, plus the
> docker-compose DB-backed **integration** suite; the Playwright **e2e** suite
> is an opt-in `--full` level — `npm run verify:full` on a quiet box — NOT part
> of the deploy gate) BEFORE pushing the image, and the
> fleet auto-deploy watcher (`scripts/fleet-auto-deploy.sh` → `deploy.sh
dev|demo`) runs it for the dev/demo tiers. GitHub Actions is NOT the deploy
> authority (NHL model). There is no `gh api` / CI-status dependency; the
> break-glass override is `FORCE_DEPLOY_UNCHECKED=1`. GitHub branch protection
> on `main` (PR + review) is optional code-review hygiene, not a deploy
> requirement, and is no longer enforced by any status check. `demo` is an
> `APP_TIER=demo` environment deployed from a chosen ref (currently `dev`,
> later `main` or a release tag), not a long-lived code branch.
>
> **Land-time gating is enforced by the repo-tracked pre-push hook**
> (`.githooks/pre-push`, install once per clone via
> `scripts/install-git-hooks.sh` / `npm run hooks:install`): pushing to
> `dev`/`main` runs the standard `npm run verify` gate and blocks on failure
> (bypass: `git push --no-verify`); after a dev/demo deploy the watcher runs
> `scripts/smoke-tier.sh` as detection. Details in
> [`docs/RELEASE_GATES.md`](./docs/RELEASE_GATES.md).

1. **The deploy path is `scripts/deploy.sh <prod|dev|demo>` from the
   fleet — no GitHub Actions, no ad-hoc SSH `docker compose up -d`.**
   _Why:_ for prod, `deploy.sh prod` execs `scripts/deploy-production-local.sh`,
   which BuildKit-cache-builds the image, pushes it to the DO registry
   (`registry.digitalocean.com/sitelayer/sitelayer:<git-sha>` + `:main`),
   then SSHes (flock-locked `/tmp/sitelayer-production-deploy.lock`) to the
   prod droplet to check out the matching SHA, pull the exact image, take a
   pre-migration `pg_dump` backup, run `migrate-db.sh` + `check-db-schema.sh`,
   swap containers, health-check, and write `.last_previous_deployed_sha` /
   `.last_successful_deployed_sha` (which `scripts/rollback-droplet.sh`
   reads). A manual `docker compose up -d` on the droplet skips the SHA
   markers and breaks the rollback drill. _How to apply:_ commit + push the
   SHA to an origin branch first (the droplet fetches it from GitHub), then
   `scripts/deploy.sh prod`. For rollback, `sudo TARGET_SHA=... bash
scripts/rollback-droplet.sh` on the droplet — never edit a migration to
   "fix forward in place". `SKIP_MIGRATIONS=1` does a code-only deploy.

2. **Migrations in `docker/postgres/init/*.sql` are immutable once
   committed.** _Why:_ they're checksummed and tracked in
   `schema_migrations`; editing an already-applied file makes the next
   deploy fail the checksum gate. _How to apply:_ schema corrections always
   land as a new file (next sequential prefix). `002_tier_origin.sql` is
   the precedent — additive, never destructive.

3. **When restarting a single container, re-export `GIT_SHA` /
   `APP_BUILD_SHA` first; otherwise re-run `scripts/deploy.sh prod`.**
   _Why:_ `docker compose -f docker-compose.prod.yml restart api` loses the
   build-sha env var, so the next health check sees a mismatched commit
   and rollback can't tell which image is actually running. _How to
   apply:_ `GIT_SHA=$(cat .last_successful_deployed_sha) docker compose -f
docker-compose.prod.yml up -d <service>`. Caddy binds 80/443; 3000/3001
   are private only — never expose them publicly.

4. **The persistent dev (`dev.sitelayer.sandolab.xyz`) and demo
   (`demo.preview.sitelayer.sandolab.xyz`) environments deploy via
   `scripts/deploy.sh dev` / `scripts/deploy.sh demo` to the preview
   droplet in source-mounted watch-mode (`deploy-preview.sh`, tsx + vite
   HMR — no image build).** _Why:_ PR previews share `sitelayer_preview`
   and get an ephemeral schema, which is the wrong shape for iterating on a
   migration (immutable in `main`) or running a persistent demo/agent
   sandbox. The dev stack targets the dedicated `sitelayer_dev` database
   against its `public` schema, with `scripts/reset-dev-db.sh` as the
   "rebuild from scratch" lever; demo targets `sitelayer_demo` and re-runs
   the idempotent demo seed on every deploy. _How to apply:_ work on `dev`
   for in-flight schema design; once a migration file is right, open a PR
   against `main` (the SHA must be on an origin branch before deploy so the
   droplet can fetch it). `demo` is now an environment, not a code branch —
   pick the ref you deploy from (`dev` today). See
   [`docs/DEV_ENVIRONMENT.md`](./docs/DEV_ENVIRONMENT.md).

### Env management

1. **The `APP_TIER` startup guard is load-bearing — never bypass it.**
   _Why:_ `APP_TIER=prod` rejects boot if `DATABASE_URL` or
   `DO_SPACES_BUCKET` don't match the prod-tier name. A single copy-pasted
   `.env.dev` line into prod would otherwise silently corrupt customer
   data; the guard is what turns that into a noisy startup failure. _How
   to apply:_ set `APP_TIER` _first_ when provisioning, and match every
   `*_URL` / `*_BUCKET` to the tier name. The `tier_origin` column on new
   tables is the row-level analog — keep tagging writes.

2. **Prod runtime secrets live in `/app/sitelayer/.env` on the prod
   droplet (mode `600`), rendered by `scripts/render-production-env.mjs`
   from `ops/env/production.env.json` — never in any committed file or
   shell history.** _Why:_ rotation is the only operational lever for a
   leaked key, and under the local-fleet model the prod deploy
   (`deploy-production-local.sh`) deliberately **reuses** the existing
   droplet `.env` rather than re-rendering it on every deploy (the script
   aborts if `/app/sitelayer/.env` is missing). So the rendered `.env` on
   the droplet IS the live source; `production.env.json` defines the
   name/scope manifest, and `render-production-env.mjs` reads values from
   the process env to produce the file (one-time seed / explicit re-render).
   _How to apply:_ to add a secret, add its entry to
   `ops/env/production.env.json`, then re-render `/app/sitelayer/.env` on
   the droplet (or edit it in place for an existing value) and bounce the
   affected container. **Never commit secrets;** `.env.example` documents
   _names only_. Preview/dev/demo env lives at
   `/app/previews/.env.{shared,dev.shared,demo.shared}` on the preview
   droplet, not a copy of prod values.

3. **Any `QBO_LIVE_*` flag flip needs a worker restart and a sandbox
   smoke first — not a full deploy.** _Why:_ `QBO_LIVE_RENTAL_INVOICE=1`
   and `QBO_LIVE_ESTIMATE_PUSH=1` only take effect when the worker
   re-reads its env. The worker drains `mutation_outbox` and
   `sync_events`; flipping the flag on a stale process queues writes that
   never reach Intuit until the bounce. _How to apply:_ run
   `scripts/qbo-sandbox-smoke.sh` first (Intuit sandbox tokens expire
   ~60min, provision fresh). Then update the env via the workflow and
   `docker compose -f docker-compose.prod.yml up -d worker` to recreate
   with the new env.

### QBO sync conventions

1. **Mutations go through `mutation_outbox` with stable idempotency
   keys — don't write your own retry loop.** _Why:_ the worker claims rows
   with `FOR UPDATE SKIP LOCKED`, increments `attempt_count`, and
   reschedules via `next_attempt_at`. Adding caller-side retries
   duplicates pushes to QBO and miscounts attempts. _How to apply:_
   enqueue with a deterministic key like `rental_billing_run:post:<id>`.
   Inspect queue health via `/api/system/mutation-outbox` and
   `/api/system/sync-events`. Never call the QBO API directly from a
   request handler.

2. **Webhook entity types pass through unknown handlers — the row is the
   audit trail, not the dispatch.** _Why:_ `mapQboEntityType()` normalizes
   Invoice / Estimate / etc. into the sitelayer taxonomy. Unrecognized
   types still create `sync_events` rows (so we don't drop signal) but no
   handler runs until code is added. A stalled sync usually means a
   missing handler, not a dropped webhook. _How to apply:_
   `/api/webhooks/qbo` is rate-limit-exempt and verifies the
   `intuit-signature` HMAC against `QBO_WEBHOOK_VERIFIER`. Triage starts
   at `/api/system/sync-events?status=pending` — look at `entity_type`
   distribution.

3. **`QBO_STATE_SECRET` and `QBO_WEBHOOK_VERIFIER` are operational, not
   developer-convenience values.** _Why:_ one signs the OAuth round-trip
   nonce, the other authenticates inbound notifications. Rotating either
   without coordinating with the Intuit Developer dashboard breaks new
   connects or drops webhook acks. _How to apply:_ rotate by editing
   `/app/sitelayer/.env` on the prod droplet (or re-render from
   `ops/env/production.env.json` via `scripts/render-production-env.mjs`),
   then update the verifier in the Intuit dashboard _before_ the worker
   restart (`docker compose -f docker-compose.prod.yml up -d worker`) picks
   up the new value. (There is no GitHub Actions production env in the
   deploy path — the droplet `.env` is the live source.) Webhooks queued
   during the gap replay safely thanks to idempotency keys.

### Blueprint storage hygiene

1. **DO Spaces is the source of truth; local FS fallback requires the
   `sitelayer-blueprint-backup.timer` to be live.** _Why:_
   `ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD=1` exists for the
   degraded-Spaces case but routes uploads to host disk, where a droplet
   loss equals data loss without the off-host timer copying to the
   preview droplet. _How to apply:_ default to Spaces. Before enabling
   local fallback, verify `systemctl list-timers | grep blueprint` shows
   the unit active. Spaces versioning is on; there's no manual GC and no
   retention policy — blueprints are kept indefinitely.

2. **Uploads stream through the multipart path with a hard cap; never
   widen the JSON body limit to "fix" a large blueprint.** _Why:_
   `MAX_BLUEPRINT_UPLOAD_BYTES` (default 200MB) gates the streaming
   multipart endpoint. The 20MB JSON body cap is for API payloads and
   must stay where it is — raising it opens a memory-exhaustion path.
   _How to apply:_ PDFs go via `POST /api/blueprints` multipart with the
   `blueprint_file` part. Soft-delete via `deleted_at`; lineage of
   replacements via `replaces_blueprint_document_id`. The DB
   `storage_path` is opaque (`<companyId>/<blueprintId>/<filename>`), not
   a host path.

3. **Blueprint contents are user-supplied PDFs — sitelayer does not
   scan, redact, or scrub. Treat them as untrusted blobs containing
   PII.** _Why:_ construction takeoff PDFs legitimately contain customer
   addresses and contract terms; there's no server-side PII detection.
   Access control is the only protection. _How to apply:_ Clerk JWT auth
   and row-level company-id filtering are load-bearing — never log
   blueprint contents, never include them in error reports, never
   broaden the presigned-URL TTL beyond Spaces' 15-minute default.
   `BLUEPRINT_DOWNLOAD_PRESIGNED=1` requires Spaces CORS validated for
   the web app origin first.

4. **Blueprint-vision live mode is opt-in via two env vars.** _Why:_
   `POST /api/projects/:id/takeoff-drafts/capture` (`kind=blueprint_vision`)
   calls Claude Opus on every drawing page; an accidentally-set key plus
   a wired multipart upload would otherwise rack up Anthropic spend on
   the first request. The dispatcher checks `BLUEPRINT_VISION_MODE=live`
   AND a non-empty `ANTHROPIC_API_KEY` together — either missing falls
   back to the deterministic dry-run stub. _How to apply:_ set both env
   vars in `/app/sitelayer/.env` on the prod droplet (manifest entry in
   `ops/env/production.env.json`; never commit the key; `.env.example` only
   documents placeholders), and verify live behaviour
   against a single sheet PDF before flipping the mode for the fleet.
   The live path requires the multipart form (`blueprint_file` part) so
   the PDF streams straight into Spaces; the JSON-body variant of the
   endpoint stays dry-run.

### Incident runbooks

When something is on fire in production, the playbooks live under
`docs/`. The index is [`docs/RUNBOOK_INDEX.md`](./docs/RUNBOOK_INDEX.md).
Quick links to the rule each runbook gestures at:

- QBO sync stalled / `CircuitOpenError` → [`docs/RUNBOOK_QBO_CIRCUIT.md`](./docs/RUNBOOK_QBO_CIRCUIT.md) (paired with QBO sync conventions #1).
- Notifications not arriving → [`docs/RUNBOOK_NOTIFICATION_BACKLOG.md`](./docs/RUNBOOK_NOTIFICATION_BACKLOG.md).
- API 503s / pool exhaustion → [`docs/RUNBOOK_CONNECTION_POOL.md`](./docs/RUNBOOK_CONNECTION_POOL.md).
- Blueprint upload 500s → [`docs/RUNBOOK_SPACES_UPLOAD.md`](./docs/RUNBOOK_SPACES_UPLOAD.md) (paired with blueprint storage hygiene #1).
- After any incident → fill [`docs/POSTMORTEM_TEMPLATE.md`](./docs/POSTMORTEM_TEMPLATE.md) and link it from the relevant runbook.

Broader on-call orientation (DB down, Clerk outage, Cloudflare, cert
renewal, compromised cred) stays in [`docs/INCIDENT_RESPONSE.md`](./docs/INCIDENT_RESPONSE.md).

## Local/preview role testing

The substrate ships a dev-only auth-bypass so QA can exercise RBAC paths
without standing up a Clerk org. It is structurally impossible to
activate in production — both the SPA and the API enforce the gate
independently.

**SPA side (`apps/web`).** When `VITE_CLERK_PUBLISHABLE_KEY` is empty
and the build is not `MODE === 'production'`, a small `<RoleSwitcher />`
panel (`apps/web/src/components/dev/RoleSwitcher.tsx`) renders in the
bottom-right. Tapping a role writes `localStorage['sitelayer.act-as'] =
e2e-<role>` and reloads the page. From that point on, every outbound
request from `apps/web/src/lib/api/client.ts:request<T>()` (and
`buildAuthHeaders`) carries `x-sitelayer-act-as: e2e-<role>`. Once a
Clerk publishable key is wired, `isClerkConfigured()` flips true, the
panel un-mounts, and the header stops travelling.

**API side (`apps/api`).** `apps/api/src/auth.ts:resolveActAsOverride`
reads the header and, when `appConfig.tier !== 'prod'`, overrides every
other user-id resolution path (Clerk JWT, `x-sitelayer-user-id`,
`ACTIVE_USER_ID`). Company resolution is unchanged — it still uses
`x-sitelayer-company-slug` (default `ACTIVE_COMPANY_SLUG`) — and the
RBAC role is still read from `company_memberships` on every request. In
`prod` the header is ignored and a `[auth] ignoring x-sitelayer-act-as
in prod` warning fires so operators can spot misconfigured clients.

**To use locally:**

1. In `.env`, leave both `CLERK_JWT_KEY=` and
   `VITE_CLERK_PUBLISHABLE_KEY=` empty.
2. `npm run dev` (or `npm run dev:web` + `npm run dev:api`).
3. Open the SPA — the dev role-switcher appears in the bottom-right.
4. Click a role to swap identities; the page reloads with the new
   `x-sitelayer-act-as` header on every API call.

The five canonical IDs are `e2e-admin`, `e2e-foreman`, `e2e-office`,
`e2e-member`, `e2e-bookkeeper`. Provision matching rows in
`company_memberships` (a tier-gated seed migration is the natural follow-on)
so the API has a role to read.

**Never active in prod.** The API guard (`tier !== 'prod'`) and the
Vite `MODE !== 'production'` dead-code branch in `App.tsx` are
redundant on purpose — either alone is sufficient to block the bypass,
and both have unit-test coverage (`apps/api/src/auth.test.ts`,
`apps/web/src/components/dev/RoleSwitcher.test.tsx`).

## Current Infrastructure Snapshot

**Verified with `doctl` and production smoke checks on 2026-04-25.** (Schema has since advanced past migration 136, 2026-06-01; the droplet / managed-Postgres / Spaces topology below is unchanged. **Deploy-path rows updated 2026-06-01: deploys are now local-fleet via `scripts/deploy.sh`, NOT GitHub Actions — see Deploy procedure above.**)

| Resource                         | Current State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production droplet               | `sitelayer`, ID `566798325`, Ubuntu 22.04, Toronto `tor1`, 4 vCPU, 8GB RAM, public IPv4 `165.245.230.3`                                                                                                                                                                                                                                                                                                                                                                                                                |
| Reserved production IP           | `159.203.51.158`, assigned to droplet `566798325`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Preview droplet                  | `sitelayer-preview`, ID `566806040`, Ubuntu 22.04, Toronto `tor1`, 2 vCPU, 4GB RAM, reserved IPv4 `159.203.53.218`                                                                                                                                                                                                                                                                                                                                                                                                     |
| Managed Postgres                 | `sitelayer-db`, ID `9948c96b-b6b6-45ad-adf7-d20e4c206c66`, Postgres 18, `db-s-1vcpu-1gb`, Toronto `tor1`, online                                                                                                                                                                                                                                                                                                                                                                                                       |
| Managed Postgres databases       | `defaultdb`, `sitelayer_prod`, `sitelayer_preview`, `sitelayer_dev`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Managed Postgres trusted sources | Droplet `566798325` (`sitelayer`) and droplet `566806040` (`sitelayer-preview`)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Production deploy path           | Local-fleet (2026-06-01): `scripts/deploy.sh prod` → `scripts/deploy-production-local.sh` from a fleet box — BuildKit-cached image build, push to DO registry (`:<git-sha>` + `:main`), flock-locked SSH to the prod droplet (`sitelayer@165.245.230.3` / reserved `159.203.51.158`) to checkout the SHA, pull, `pg_dump` backup, `migrate-db.sh` + `check-db-schema.sh`, container swap, health check, write `.last_*_deployed_sha`. Runtime `.env` REUSED at `/app/sitelayer/.env` (mode `600`). NOT GitHub Actions. |
| Preview deploy path              | `docker-compose.preview.yml` behind Traefik on `sitelayer-preview` (`159.203.53.218`); per-PR isolated `sitelayer_<slug>` schema in `sitelayer_preview`; shared env at `/app/previews/.env.shared`. Deployed by running `scripts/deploy-preview.sh` on the preview droplet (the Actions preview workflow was removed in `70b9584b`).                                                                                                                                                                                   |
| Dev deploy path                  | `scripts/deploy.sh dev` from the fleet → `deploy-preview.sh` on the preview droplet with `PREVIEW_TIER=dev`, source-mounted watch-mode; shared env at `/app/previews/.env.dev.shared`; deploys from the `dev` branch SHA; URL `https://dev.sitelayer.sandolab.xyz`; backed by dedicated `sitelayer_dev` DB. (`demo` is the same shape via `scripts/deploy.sh demo` against `sitelayer_demo`, re-seeded each deploy.)                                                                                                   |
| Public edge                      | Containerized Caddy on ports 80/443; automatic Let's Encrypt TLS for `sitelayer.sandolab.xyz`; HTTP redirects to HTTPS                                                                                                                                                                                                                                                                                                                                                                                                 |
| Backups                          | DO managed Postgres automatic backups exist; logical Postgres backup, Postgres off-host copy, blueprint-volume fallback copy, restore-drill, and timer-monitor timers are active                                                                                                                                                                                                                                                                                                                                       |
| Object storage                   | DO Spaces bucket `sitelayer-blueprints-prod` in `tor1`, versioning enabled, scoped prod read/write key in `/app/sitelayer/.env` on the droplet (rendered from the `ops/env/production.env.json` manifest)                                                                                                                                                                                                                                                                                                              |
| Container registry               | DO Container Registry `sitelayer` in `tor1`; production deploy promotes `registry.digitalocean.com/sitelayer/sitelayer:<git-sha>`                                                                                                                                                                                                                                                                                                                                                                                      |
| Optional integrations            | QBO credentials can stay blank until live sync validation; Sentry can stay blank but is wired for api/worker/web when DSNs are present. Prod API boot requires auth config, `API_METRICS_TOKEN`, Spaces credentials, and `DATABASE_URL`                                                                                                                                                                                                                                                                                |

Security note: the deploy user is in the Docker group. That avoids root SSH but Docker access is root-equivalent. Treat `DEPLOY_SSH_KEY` as production-root-equivalent.

Database migrations use `scripts/migrate-db.sh`; schema readiness uses `scripts/check-db-schema.sh`. Production deploy builds and pushes an immutable registry image, pulls that exact tag on the droplet, takes a pre-migration logical backup, then runs both before replacing containers. The runner records checksums in `schema_migrations`; add new SQL files instead of editing applied migrations. For local Docker verification without exposing Postgres on the host, run with `PSQL_DOCKER_NETWORK=sitelayer_default DATABASE_URL=postgres://sitelayer:sitelayer@db:5432/sitelayer`.

## Architecture Overview

Three-layer architecture designed to decouple external integrations (QBO, Clerk) from core domain logic:

```
Layer 1: Source Connectors
  └─ QBO OAuth integration, sync state tracking

Layer 2: Normalized Operational Model
  └─ Domain types, business logic, accounting mapping

Layer 3: Derived Insight & Workflow UI
  └─ React SPA, background job processor
```

### Tech Stack

| Component           | Technology                                                 | Notes                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Backend**         | Node.js (plain http module) + Postgres                     | No framework; minimal HTTP server                                                                                                                                                                                                                                  |
| **Frontend**        | React 19 + Vite SPA                                        | Client-side only; no SSR                                                                                                                                                                                                                                           |
| **Worker**          | Node.js background tasks                                   | Postgres-backed leased queue; no Hatchet yet                                                                                                                                                                                                                       |
| **Monorepo**        | npm workspaces                                             | apps: api, web, worker; packages: config, domain, logger, queue, workflows, capture-schema, capture-catalog, pipe-blueprint, pipe-roomplan, pipe-drone, pipe-photogrammetry                                                                                        |
| **Database**        | Postgres (pg driver)                                       | Direct parameterized SQL in the per-feature handler modules under `apps/api/src/routes/` (dispatched via `routes/dispatch.ts`), not in `server.ts`; no ORM                                                                                                         |
| **Auth**            | Clerk wired in SPA + JWT verification in API; gated by env | `apps/web/src/App.tsx` runs SignIn/SignUp; `apps/api/src/auth.ts` verifies Clerk JWTs when `CLERK_JWT_KEY` is set. Header fallback to `ACTIVE_USER_ID=demo-user` is still active until `AUTH_ALLOW_HEADER_FALLBACK=0` and `CLERK_JWT_KEY` are configured per tier. |
| **File Storage**    | Dual-mode shipped: local FS or DigitalOcean Spaces         | `apps/api/src/storage.ts` auto-selects `S3Storage` when `DO_SPACES_BUCKET/KEY/SECRET` are set, otherwise local FS at `BLUEPRINT_STORAGE_ROOT`. Default region `tor1`.                                                                                              |
| **QBO Integration** | OAuth + REST API (direct HTTP)                             | Connector layer; sync state in `integration_mappings` table                                                                                                                                                                                                        |
| **Observability**   | Sentry v10 + Pino                                          | Trace propagation through API/worker; web Sentry and web-vitals are idle/lazy loaded; request-scoped JSON logs via `@sitelayer/logger`                                                                                                                             |

## Project Structure

```
sitelayer/
├── apps/
│   ├── api/                 # Backend HTTP server (apps/api/src/server.ts)
│   ├── web/                 # Frontend React SPA (apps/web/src/App.tsx)
│   └── worker/              # Background job processor (apps/worker/src/worker.ts)
├── packages/
│   ├── config/              # Tier/env loading and deployment safety checks
│   ├── domain/              # Shared types, business math, constants
│   ├── logger/              # Pino logger with request and Sentry trace context
│   ├── queue/               # Shared Postgres queue claiming/apply helpers
│   ├── workflows/           # Deterministic workflow reducers + Zod schemas (see docs/DETERMINISTIC_WORKFLOWS.md)
│   ├── capture-schema/      # Unified TakeoffResult / TakeoffGeometry types shared by every capture pipeline
│   ├── capture-catalog/     # Service-item / MasterFormat code catalog used to classify captured quantities
│   ├── pipe-blueprint/      # Blueprint PDF → quantities via Claude Opus vision (live behind BLUEPRINT_VISION_MODE=live)
│   ├── pipe-roomplan/       # Apple RoomPlan CapturedRoom JSON → takeoff measurements
│   ├── pipe-drone/          # Drone imagery (NodeODM client + sidecar) → roof/footprint/sitework quantities
│   └── pipe-photogrammetry/ # Phone-video/Luma + labeled-mesh → surface measurements
├── docker/
│   └── postgres/init/       # Schema initialization
└── docs/                    # Architecture, requirements, findings
```

## Core Components

### Backend (apps/api/src/server.ts)

- **HTTP Server**: Plain Node.js `http` module; no framework overhead. `server.ts` owns HTTP, auth, and middleware; it does not contain the route table.
- **Routing**: `server.ts` hands each request to `apps/api/src/routes/dispatch.ts`, which dispatches to the ~75 per-feature handler modules in `apps/api/src/routes/` (~150 endpoints). CORS handling for frontend/worker origins.
- **Database**: Direct parameterized pg client queries inside those handler modules; no ORM
- **Dependencies**: `pg`, `@sentry/node`, `@sitelayer/config`, `@sitelayer/domain`, `@sitelayer/logger`, `@sitelayer/queue`

**Endpoints** (partial sample — the canonical registry is `apps/api/src/routes/dispatch.ts` plus the ~75 handler modules in `apps/api/src/routes/` (~150 endpoints total). `server.ts` is HTTP + auth + middleware only; it does not enumerate routes. Don't treat the list below as exhaustive):

System / observability:

- GET `/health` (note: no `/api` prefix — what Caddy probes), GET `/api/version`
- GET `/api/metrics` — Prometheus format, gated by `API_METRICS_TOKEN`
- GET `/api/features`, GET `/api/spec`, GET `/api/session`
- GET `/api/audit-events`
- GET `/api/debug/traces/:traceId` — Sentry trace fetch, gated by `DEBUG_TRACE_TOKEN`

Handler-module routes not in the legacy sample above (illustrative, not exhaustive — see `routes/dispatch.ts`): `routes/ai-chat.ts` (AI chat assist), `routes/dispatch-lanes.ts` (rental dispatch lanes), `routes/worker-issues.ts` (field issue submissions).

Companies / auth:

- GET/POST `/api/companies`
- POST `/api/companies/:id/memberships`
- POST `/api/webhooks/clerk` — Svix-signed Clerk webhook

Bootstrap / projects:

- GET `/api/bootstrap` — projects and seed data for current company
- POST `/api/projects`, PATCH `/api/projects/:id`
- GET `/api/projects/:id/summary`, POST `/api/projects/:id/closeout`

Blueprints / takeoff:

- POST `/api/projects/:id/blueprints` — upload; accepts streaming `multipart/form-data` (`blueprint_file` + metadata fields) or legacy base64 JSON (`file_contents_base64`)
- GET `/api/projects/:id/blueprints`, GET `/api/blueprints/:id/file`
- PATCH/DELETE `/api/blueprints/:id`, POST `/api/blueprints/:id/versions`
- POST `/api/projects/:id/takeoff/measurement` — append one polygon
- POST `/api/projects/:id/takeoff/measurements` — replace set
- GET/PATCH/DELETE `/api/takeoff/measurements/:id`
- POST `/api/projects/:id/takeoff-drafts/capture` — run a capture pipeline (`kind` = blueprint_vision | roomplan | drone | photogrammetry); returns a review-required `TakeoffResult` draft
- POST `/api/projects/:id/takeoff-drafts/:draftId/promote` — promote selected captured quantities into committed `takeoff_measurements`

3D takeoff preview: there IS a working three.js renderer — `apps/web/src/screens/projects/takeoff-3d-scene.tsx` + the `buildTakeoffPreviewScene` builder in `apps/web/src/lib/takeoff/geometry-3d.ts` (lazy `vendor-three` chunk). Live at `/projects/:id/takeoff-preview`, public demo at `/demo/takeoff-preview-3d`. The four capture pipelines live in `packages/pipe-*` on the shared `packages/capture-schema` types. See `docs/BLUEPRINT_TO_3D_PREVIEW.md` and `docs/MULTI_DRAFT_TAKEOFF_SPEC.md`. Not built: a scaffold _designer_, and captured geometry isn't yet fed into the renderer (only manual blueprint polygons are).

Estimation:

- POST `/api/projects/:id/estimate/recompute`
- GET `/api/projects/:id/estimate/scope-vs-bid`
- POST `/api/projects/:id/estimate/push-qbo`
- GET `/api/projects/:id/estimate/forecast-hours`

Material bills:

- GET/POST `/api/projects/:id/material-bills`
- PATCH/DELETE `/api/material-bills/:id`

Reference data CRUD: customers, workers, divisions, service-items, pricing-profiles, bonus-rules, labor-entries, schedules, rentals.

Time tracking (clock):

- POST `/api/clock/in`, POST `/api/clock/out`
- GET `/api/clock/timeline`

Analytics:

- GET `/api/analytics`, `/api/analytics/history`, `/api/analytics/divisions`, `/api/analytics/service-item-productivity`

QBO integration:

- GET `/api/integrations/qbo/auth`, GET `/api/integrations/qbo/callback`
- GET/POST `/api/integrations/qbo`, POST `/api/integrations/qbo/sync`
- POST `/api/integrations/qbo/sync/material-bills` — push material bills to QBO
- GET `/api/integrations/qbo/mappings`, POST `/api/integrations/qbo/mappings`
- PATCH/DELETE `/api/integrations/qbo/mappings/:id`

Rental inventory + billing workflow (see `docs/DETERMINISTIC_WORKFLOWS.md`):

- GET/POST/PATCH/DELETE `/api/inventory-items`, `/api/inventory-locations`, `/api/inventory-movements`
- GET/POST/PATCH/DELETE `/api/projects/:id/rental-contracts`, `/api/job-rental-lines`
- POST `/api/rental-contracts/:id/billing-runs/preview`, GET/POST `/api/rental-contracts/:id/billing-runs`
- GET `/api/rental-billing-runs?state=...` — company-scoped list (entry surface for the headless review UI)
- GET `/api/rental-billing-runs/:id` — returns `WorkflowSnapshot { state, state_version, context, next_events }`
- POST `/api/rental-billing-runs/:id/events` — `{ event, state_version }` applies the pure reducer in one tx; 409 on stale `state_version` or illegal transition

Sync queue inspection:

- GET `/api/sync/status`, `/api/sync/events`, `/api/sync/outbox`
- POST `/api/sync/process` — manual drain trigger

**Environment Variables**:

```
APP_TIER=local|dev|preview|prod          # Tier marker; startup guard enforced
FEATURE_FLAGS=read-prod-ro,qbo-live,...  # See DEPLOYMENT.md → Tier Isolation
DATABASE_URL_PROD_RO=...                 # Read-only prod pool (only for read-prod-ro flag)
PORT=3001
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer
ACTIVE_COMPANY_SLUG=la-operations        # Hardcoded tenant demo
ACTIVE_USER_ID=demo-user                 # Hardcoded user
QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI
QBO_ENVIRONMENT=sandbox|production
BLUEPRINT_STORAGE_ROOT=/app/storage/blueprints
BLUEPRINT_VISION_MODE=dry-run|live   # blueprint takeoff dispatcher mode; live also needs ANTHROPIC_API_KEY
VOICE_TO_LOG_MODE=dry-run|live       # worker voice-to-log narrative; live also needs ANTHROPIC_API_KEY (else deterministic stub)
VOICE_TO_LOG_MODEL=claude-haiku-4-5-20251001  # optional override for the voice-to-log model
ANTHROPIC_API_KEY=<set-outside-git>  # Claude key for blueprint vision + voice-to-log; placeholder in .env.example only
ALLOWED_ORIGINS=http://localhost:5173,...
AI_CHAT_ENABLED=                     # Single gate for the in-app operator AI chat (see below); unset + no MESH_API_URL = OFF
MESH_API_URL=                        # Operator's private mesh API (Tailnet-only, e.g. http://mesh-hetzner:8713); also the implicit AI-chat enable signal
```

**In-app AI chat feature gate.** The operator-context chat widget's only
response path is a hand-off to the operator's _private_ mesh
(`MESH_API_URL`, reachable only inside Taylor's Tailnet) plus the
`SITELAYER_CHAT_WEBHOOK_TOKEN` callback. A deployment with no mesh access
(a fresh owner, any non-operator instance) has neither, so the chat is
feature-flaggable OFF behind a single gate — `isAiChatEnabled()` in
`apps/api/src/mesh-dispatcher.ts`:

- `AI_CHAT_ENABLED` is the explicit override (`1/true/on/yes` forces ON,
  `0/false/off/no` forces OFF even with `MESH_API_URL` set).
- When `AI_CHAT_ENABLED` is unset, a non-empty `MESH_API_URL` is the
  implicit enable signal (preserves the operator's own deployment).

When disabled, `POST /api/ai/chat` returns a calm, structured
`200 {"status":"disabled","ai_chat_enabled":false}` — no staged audit row,
no mesh dispatch, no repeated 503/error logs — and the web widget hides its
composer (it reads `ai_chat_enabled` off `GET /api/features`). So a new
owner with no mesh access gets a clean app, not error noise. Set
`MESH_API_URL` (or `AI_CHAT_ENABLED=1`) to preserve the prior behavior.

**Tier isolation.** The API refuses to boot if `APP_TIER` disagrees with `DATABASE_URL` (e.g. `APP_TIER=dev` pointing at `sitelayer_prod`) or with `DO_SPACES_BUCKET`. Full rules + feature-flag semantics live in `DEPLOYMENT.md` → Tier Isolation. The web UI shows a colored ribbon reflecting the tier; absence of the ribbon means production. Claude Desktop / MCP agents must never be handed prod credentials.

### Frontend (apps/web/src/App.tsx)

- **React 19 SPA**: No Next.js, no SSR; pure client-side
- **Build**: Vite dev server @ `0.0.0.0:3000` during dev
- **State**: IndexedDB for offline-first (recent addition)
- **UI Components**: Inline SVG polygon annotation overlay over browser PDF/image preview
- **Storage**: LocalStorage for drafts, IndexedDB for offline queue

**Key Views**:

- Projects dashboard
- Blueprint upload + PDF viewer
- Polygon annotation layer
- Estimate preview
- Integration status

### Domain Layer (packages/domain/src/index.ts)

Shared type definitions and business logic:

```typescript
export interface Company { id, slug, name, created_at }
export interface Division { id, name, rate_standard, rate_overtime, ... }
export interface Project { id, name, customer_id, divisions, created_at, ... }
export interface Takeoff { id, description, quantity, division_id, ... }
export interface Estimate { id, project_id, line_items, total_labor, total_material, ... }
export interface Worker { id, name, email, ... }
export interface LabourEntry { id, worker_id, project_id, hours, rate, ... }
export const DEFAULT_BONUS_RULE = { min_revenue, bonus_percentage, ... }
export const LA_TEMPLATE = { divisions: [...], items: [...] } // PreLoaded LA Operations template
export const calculateMargin = (revenue, cost) => (revenue - cost) / revenue
export const calculateProjectCost = (takeoffs, divisions) => ...
export const calculateBonusPayout = (revenue, cost, rule) => ...
export const normalizePolygonGeometry = (geometry) => ... // validates 0-100 board-space polygons
export const calculateTakeoffQuantity = (points, multiplier) => ...
```

Takeoff geometry is intentionally shared between API and web. The web uses it for live polygon quantity/centroid display; the API uses it to validate and normalize polygon geometry before writing `takeoff_measurements`.

### Cross-cutting middleware

Three concerns wired into every API request, implemented as discrete modules in `apps/api/src/`:

- **Rate limiting** (`rate-limit.ts`) — per-user and per-IP token bucket. Configurable via `RATE_LIMIT_PER_USER_PER_MIN` / `RATE_LIMIT_PER_IP_PER_MIN`; some routes (health, metrics, OAuth callbacks) are exempted via `isRateLimitExempt`.
- **Version guard** (`version-guard.ts`) — optimistic concurrency on PATCH paths via `assertVersion`. Clients send the row's current `version` and the server rejects with 409 on stale writes. Used for projects, blueprints, takeoff measurements, etc.
- **Catalog enforcement** (`catalog.ts`) — guards estimate/labor writes against the per-company curated `service_item_divisions` cross-reference (set up by migration `011_service_item_xref_backfill.sql`).
- **LWW conflict resolution** (`lww.ts`) — last-writer-wins via `updated_at` for offline-queue replays from the SPA. Migration `012_takeoff_measurements_updated_at.sql` adds the column + index that this relies on.

### Queue Package (packages/queue/src/index.ts)

Shared Postgres queue lease implementation used by both API-triggered sync and the background worker:

- Claims `mutation_outbox` and `sync_events` with `FOR UPDATE SKIP LOCKED`.
- Uses short processing leases through `next_attempt_at` so stale work can be retried.
- Wraps claim/apply/update in one transaction and rolls back on failure.
- Has unit coverage in `packages/queue/src/index.test.ts`; do not fork this SQL back into app code.

### Worker (apps/worker/src/worker.ts)

Background job processor:

- Calls `@sitelayer/queue` for the shared Postgres queue lease/transaction behavior.
- Marks simulated local queue work as `applied`. The QBO material-bill push path is now exercised in CI by `apps/api/src/qbo-material-bill-sync.test.ts` against a localhost HTTP mock; before flipping the `qbo-live` flag in prod, run `scripts/qbo-sandbox-smoke.sh` against a real QBO sandbox.

### Workflow Inventory

Each deterministic workflow has a registered reducer in `packages/workflows/src/` (see `docs/DETERMINISTIC_WORKFLOWS.md` for the design rules). Canonical, more-detailed table lives there; this is the at-a-glance summary.

| Workflow                   | Status                                                                                                                                                                                                                                                                                                                           | Schema | States                                                                                                       | Side effects                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `rental_billing_run`       | Live in API + worker; event log enabled in both human and worker paths                                                                                                                                                                                                                                                           | v1     | generated, approved, posting, posted, failed, voided                                                         | `post_qbo_invoice`                                        |
| `estimate_push`            | Live in API + worker (stub QBO push until `qbo-estimate-push.ts` ships and `QBO_LIVE_ESTIMATE_PUSH=1`)                                                                                                                                                                                                                           | v1     | drafted, reviewed, approved, posting, posted, failed, voided                                                 | `post_qbo_estimate`                                       |
| `crew_schedule`            | Live in API + web (XState wires `routes/schedules.ts` confirmation through the reducer)                                                                                                                                                                                                                                          | v1     | draft, confirmed                                                                                             | none                                                      |
| `project_closeout`         | Shipped — GET `/api/projects/:id/closeout` snapshot added in #293                                                                                                                                                                                                                                                                | v1     | active, completed                                                                                            | none                                                      |
| `time_review_run`          | Live in API + web (`useTimeReview` XState added in #294); worker emits `lock_labor_entries` and chains to `generate_labor_payroll_run` after APPROVE                                                                                                                                                                             | v1     | pending, approved, rejected                                                                                  | `lock_labor_entries`                                      |
| `labor_payroll_run`        | Live in API + worker (stub QBO TimeActivity push unless `QBO_LIVE_LABOR_PAYROLL=1`); financial hub list/detail screens shipped in #285/#292                                                                                                                                                                                      | v1     | generated, approved, posting, posted, failed, voided                                                         | `post_qbo_time_activities`                                |
| `project_lifecycle`        | Live in API + web (`useProjectLifecycle` XState mounted on project detail in #276/#281)                                                                                                                                                                                                                                          | v1     | draft, estimating, sent, accepted, declined, in_progress, done, archived                                     | `notify_foreman_assignment`                               |
| `field_event`              | Live in API + worker; "Flag a problem" → foreman triage → estimator escalation                                                                                                                                                                                                                                                   | v1     | open, resolved, escalated, dismissed                                                                         | `notify_worker_resolution`, `notify_estimator_escalation` |
| `rental`                   | Live in API (partial): `routes/rentals.ts` now dispatches the RETURN and CLOSE transitions through the reducer + `workflow_event_log` (`applyRentalWorkflowTransition`); replay sweep wired. Phase 2 still pending = worker cadence path (INVOICE_QUEUED / INVOICE_POSTED). The `rental.ts` file header comment is itself stale. | v1     | active, returned, invoiced_pending, closed                                                                   | none                                                      |
| `daily_log`                | Live in API; SUBMIT through reducer + workflow_event_log + idempotency key (migration 082)                                                                                                                                                                                                                                       | v1     | draft, submitted                                                                                             | none                                                      |
| `notification`             | Live in worker; runner routes terminal transitions through reducer; procedural backoff stays in `next_attempt_at` (migration 081)                                                                                                                                                                                                | v1     | pending, hydrating, sending, sent, voided, failed_clerk_not_found, failed_clerk_unreachable, failed_provider | send via email / SMS / web-push channel adapters          |
| `shipment`                 | Live in API; estimate → fulfillment workflow with reducer + event log                                                                                                                                                                                                                                                            | v1     | planned, picking, shipped, delivered, returning, closed, voided                                              | none                                                      |
| `damage_charge_settlement` | Live in API; damage/loss/late-return billing workflow                                                                                                                                                                                                                                                                            | v1     | open, invoiced, waived                                                                                       | `post_qbo_damage_charge` (optional)                       |
| `rental_request_approval`  | Live in API; operator-side approval queue for portal rental_requests submissions                                                                                                                                                                                                                                                 | v1     | pending, approved, declined                                                                                  | none                                                      |
| `qbo_sync_run`             | Live in API; wraps every full QBO sync attempt with START_SYNC → SYNC_SUCCEEDED/FAILED dispatched through the reducer (migration 077)                                                                                                                                                                                            | v1     | pending, syncing, succeeded, failed, retrying                                                                | `run_qbo_sync`                                            |
| `scaffold_ops_approval`    | Live in API; BOM approve/supersede via POST /api/boms/:id/events (legacy /approve alias retained for one release)                                                                                                                                                                                                                | v1     | draft, approved, superseded                                                                                  | none                                                      |

### Database Schema

**Core Tables** (canonical source: `docker/postgres/init/*.sql`):

- `companies` — multi-tenant root
- `company_memberships` — Clerk user → company role (`admin|foreman|office|member|bookkeeper`; canonical union: `packages/domain/src/roles.ts:COMPANY_ROLES`); auth identity lives here, not a separate users table
- `customers` — per-company customer roster
- `projects` — construction projects
- `blueprint_documents` — uploaded PDF/image documents with storage path (local FS or DO Spaces key) and revision lineage
- `takeoff_drafts` — per-project measurement drafts (multi-draft takeoff); each draft owns its own measurements + estimate and may declare a capture pipeline `source` (`manual` / `blueprint_vision` / `photogrammetry` / `drone`). Schema in `066_takeoff_drafts.sql`, NOT NULL lock in `068_takeoff_drafts_not_null.sql`, capture-pipeline columns added by `069_takeoff_capture_artifacts.sql`.
- `takeoff_capture_artifacts` — one row per uploaded capture input (PDF, CapturedRoom JSON, labeled mesh, drone sidecar) tied to a draft. Allows multiple artifacts per draft without bloating `takeoff_drafts`. Schema in `069_takeoff_capture_artifacts.sql`.
- `takeoff_measurements` — polygon/manual measurements with persisted geometry; `draft_id` is NOT NULL post-#270
- `estimate_lines` — per-project estimate line items (no separate `estimates` parent table); `draft_id` threaded through recompute/scope-vs-bid/PDF
- `service_items`, `service_item_divisions`, `divisions`, `pricing_profiles`, `bonus_rules` — reference data
- `project_pricing_overrides`, `customer_pricing_overrides`, `company_pricing_overrides` — per-scope service-item rate overrides feeding the pricing chain resolver (`project → customer → company → QBO item rate → service_items.default_rate`). Each row carries its own `unit` so an override can flip the billing unit (e.g. negotiated "per hour" vs catalog default "per sqft"). Schema in `071_pricing_overrides.sql`.
- `workers`, `labor_entries`, `crew_schedules`, `clock_events` — crew + time tracking
- `labor_payroll_runs` — payroll batches materialized after `time_review_run` APPROVE locks `labor_entries`. Walks the same `generated → approved → posting → posted | failed → voided` pipeline as `rental_billing_runs`; QBO push translates each covered `labor_entry` into a `TimeActivity`. Schema in `051_labor_payroll_runs.sql`.
- `material_bills`, `rentals` — material spend and rental ledger per project
- `integration_connections` — QBO/etc. OAuth tokens, refresh state, webhook secrets
- `integration_mappings` — external refs per `(provider, entity_type)` (customer/project/item)
- `mutation_outbox` — outbound writes queued for external systems (worker drains)
- `sync_events` — directional sync ledger with status, attempts, applied_at, error. Both queue tables are leased in-place via `FOR UPDATE SKIP LOCKED` (`packages/queue/src/index.ts`); there is no separate `queue_leases` table.
- `audit_events` — append-only audit trail (also surfaced via `GET /api/audit-events`)
- `notifications` — per-user/per-company notification ledger

**Source of Truth Rules**:

- **QBO Authoritative**: Customer, division, service item definitions
- **Sitelayer Authoritative**: Measurements, schedules, labor entries, costing

## Architectural Decisions

### 1. **No Framework (Plain Node.js HTTP)**

**Decision**: Use only Node.js core `http` module; no Express/Fastify/Hono.

**Rationale**:

- Minimal startup overhead for containerized deployment
- Direct control over request handling
- Easier to reason about CORS, auth middleware
- Can add routing/middleware incrementally as complexity grows

**Tradeoff**: Manual routing, middleware composition, no built-in validation.

**Assessment**: ✅ **Appropriate for MVP**. Fine up to ~50 endpoints. Beyond that, consider Fastify (lightweight, TypeScript-first, similar to raw Node but with convenient abstractions).

### 2. **React SPA (No Next.js, No SSR)**

**Decision**: Pure client-side React 19 with Vite bundler.

**Rationale**:

- Construction crews use this on-site with intermittent connectivity
- Offline-first priority (IndexedDB queue for sync when online)
- Simple deployment (static build artifacts)
- Avoids Node.js server overhead in field environments

**Tradeoff**: No server-side rendering, SEO not applicable, larger JS bundle.

**Assessment**: ✅ **Correct for this use case**. On-site/offline requirement rules out server-side rendering. Next.js would add complexity without benefit.

### 3. **Direct SQL in Server.ts**

**Decision**: All database queries written as string SQL directly in handler functions.

**Rationale**:

- Transparent, reviewable queries
- No ORM initialization overhead
- Type-safe via TypeScript if using pg client correctly
- Easier to profile and debug

**Tradeoff**: verbose; no query builder. (SQL-injection is mitigated — all queries are parameterized; that's enforced, not optional.)

**Recommendation**: **Keep raw parameterized SQL. Do NOT introduce an ORM (Prisma/Drizzle).** This codebase deliberately relies on patterns ORMs fight: `FOR UPDATE SKIP LOCKED` (the `@sitelayer/queue` lease), `SET LOCAL app.company_id` (RLS GUC), closeout/analytics CTEs, optimistic `version`/`state_version` guards, and `withMutationTx` transaction control. An ORM would force constant `$queryRaw` escapes (no benefit) **and** want to own migrations — replacing the locked-down, checksummed, immutable forward-only SQL migration discipline (`docker/postgres/init`, `DEPLOY_RUNBOOK`) is a safety regression, not an upgrade. "Unsustainable past N queries" is not true for this style. If compile-time type-safety ever becomes a real pain, the only thing worth evaluating is a **SQL-first type generator (PgTyped / pg-to-ts)** that types your existing SQL without touching migrations or RLS — never an ORM.

### 4. **Monorepo with npm Workspaces**

**Decision**: Single repository with apps (api, web, worker) and packages (domain).

**Rationale**:

- Shared domain types across backend, frontend, worker
- Single deploy pipeline
- Coordinated schema + API + UI changes

**Assessment**: ✅ **Correct for this team size**. npm workspaces is lightweight; no need for Nx/Turbo at pilot stage.

### 5. **IndexedDB for Offline-First**

**Decision**: LocalStorage + IndexedDB queue for offline capture, sync when online.

**Rationale**:

- Construction sites have unreliable connectivity
- Allow crews to capture measurements offline
- Sync queue when connection restored

**Assessment**: ✅ **Good for field operations**. Correctly prioritizes offline UX.

## Technology Research & Alternatives

### Backend Framework

**Current**: Plain Node.js http module  
**Verdict**: ✅ OK for MVP; plan migration to Fastify/Hono before 500+ endpoints

| Framework   | Upside                                                      | Downside                               | Fit for Sitelayer                        |
| ----------- | ----------------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| **Fastify** | Lightweight, TypeScript-first, schema validation, streaming | Smaller ecosystem than Express         | ✅ Best choice for post-pilot            |
| **Hono**    | Minimal footprint, edge-first, great types                  | Very new; less mature                  | 🟡 Alternative if edge deployment needed |
| **Express** | Largest ecosystem, mature                                   | Heavy middleware pattern; bloated      | ❌ Avoid; contradicts minimal approach   |
| **Nest.js** | Full framework, dependency injection                        | Opinionated; adds layer of indirection | ❌ Overkill for this domain              |

**Recommendation**: If you must pick a framework now, choose **Fastify**. It fills the gap between raw Node and Express without the bloat. But plain http is defensible for the next 3 months.

### Frontend Framework

**Current**: React 19 + Vite  
**Verdict**: ✅ Correct choice; no change needed

| Framework    | Upside                                  | Downside                       | Fit for Sitelayer                 |
| ------------ | --------------------------------------- | ------------------------------ | --------------------------------- |
| **React 19** | Latest hooks, stable, largest ecosystem | Largest bundle size            | ✅ Good choice                    |
| **Svelte**   | Smallest bundle, great ergonomics       | Smaller ecosystem              | 🟡 Viable if bundle size critical |
| **Solid.js** | Fine-grained reactivity, small          | Still young; smaller community | 🟡 Not worth risk                 |
| **Vue 3**    | Balanced, good for forms                | Smaller US community           | 🟡 OK but React better for team   |

**Recommendation**: Stay with React. It's the safe, productive choice. Vite is already excellent.

### Database ORM / Query Layer

**Current**: Direct pg client, raw parameterized SQL  
**Verdict**: ✅ **Correct for this codebase. Stay here.**

| Tool                        | Fit for Sitelayer                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Raw parameterized pg**    | ✅ Current. Transparent; full control over RLS GUC, `FOR UPDATE SKIP LOCKED`, CTEs, tx boundaries. Stay here.                               |
| **PgTyped / pg-to-ts**      | 🟡 The ONLY thing worth considering — generates TS types _from_ your existing SQL/schema. Adds compile-time safety, touches nothing else.   |
| **Prisma / Drizzle (ORMs)** | ❌ No. They want to own migrations (vs the locked-down immutable SQL discipline) and fight RLS / SKIP LOCKED / CTEs → constant `$queryRaw`. |

**Recommendation**: **Do not migrate to an ORM.** The raw-SQL approach is the right fit — it's what makes RLS, the lease queue, and the deterministic-workflow transactions tractable. If query type-safety becomes a real, measured pain, evaluate a SQL-first type generator (PgTyped) only. An ORM here is a regression.

### Authentication

**Current**: Clerk JWT verification in API, Clerk React provider in web, local fixture fallback for development.
**Verdict**: ✅ **Implemented for production; validate first-customer org/membership mapping during pilot setup**

| Solution          | Upside                            | Downside                             | Fit for Sitelayer                   |
| ----------------- | --------------------------------- | ------------------------------------ | ----------------------------------- |
| **Clerk**         | Multi-tenant orgs, RBAC, webhooks | Per-action pricing (~$0.02 per user) | ✅ Matches requirements             |
| **Auth0**         | Mature, flexible rules            | Higher pricing than Clerk            | 🟡 More expensive                   |
| **Supabase Auth** | Open-source, free tier exists     | Limited multi-tenant features        | 🟡 OK for single-tenant MVP         |
| **NextAuth.js**   | Self-hosted, flexible             | OAuth provider setup overhead        | 🟡 Consider if avoiding third-party |

**Recommendation**: Keep Clerk for pilot auth and organization mapping. `CLERK_SECRET_KEY` is reserved for future Clerk Backend API calls; the current request path verifies `CLERK_JWT_KEY`.

### File Storage

**Current**: DigitalOcean Spaces is enabled for production (`sitelayer-blueprints-prod`) with the local `blueprint_storage` volume retained as a dev/preview/emergency fallback.
**Verdict**: ✅ **Object storage is live; remaining pilot risk is upload/download size, not storage durability**

| Service                 | Upside                               | Downside                                | Cost     | Fit                  |
| ----------------------- | ------------------------------------ | --------------------------------------- | -------- | -------------------- |
| **DigitalOcean Spaces** | $5/mo, 250GB included, S3-compatible | Smaller ecosystem                       | $5-15/mo | ✅ Current choice    |
| **AWS S3**              | Industry standard, mature            | Per-request pricing, more complex setup | $10+/mo  | 🟡 Overkill for MVP  |
| **Supabase Storage**    | Built on S3, PostgreSQL-native       | Different S3 endpoint                   | ~$10/mo  | 🟡 Adds dependency   |
| **Cloudinary**          | Image optimization built-in          | Per-request pricing, vendor lock-in     | $10+/mo  | ❌ Overkill for PDFs |

**Recommendation**: Keep DigitalOcean Spaces as the production object store. Streaming multipart upload (`apps/api/src/blueprint-upload.ts`, busboy + `@aws-sdk/lib-storage`) and presigned download URLs (`@aws-sdk/s3-request-presigner`) ship today; 30–80MB construction PDFs no longer flow through the JSON body limit.

### Background Jobs

**Current**: Inline worker.ts backed by `mutation_outbox` and `sync_events` leases.  
**Verdict**: 🟡 **OK for pilot simulation; live QBO connector still needs validation**

| Solution             | Upside                                | Downside                             | Cost     | Fit                  |
| -------------------- | ------------------------------------- | ------------------------------------ | -------- | -------------------- |
| **Hatchet**          | Purpose-built for workflows, no infra | Additional hosted/service dependency | Varies   | 🟡 Future option     |
| **Bull** (Redis)     | Lightweight, mature                   | Need Redis instance                  | $0-15/mo | 🟡 Works, adds Redis |
| **Postgres pg-boss** | No external dep, uses your DB         | Less mature than Bull, slower        | $0       | 🟡 Simpler for MVP   |
| **Temporal.io**      | Enterprise-grade, durable             | Significant overhead, learning curve | $0 (OSS) | ❌ Too much for MVP  |

**Recommendation**: Keep the current Postgres-backed queue for pilot unless sync complexity grows. Revisit pg-boss or Hatchet after live QBO behavior is known.

### Monitoring & Observability

**Current**: Sentry (v10, OpenTelemetry-native) across `api`, `worker`, and `web`; Pino JSON logs stamped with `trace_id` / `span_id` / `request_id` via AsyncLocalStorage.
**Verdict**: ✅ **Live as of 2026-04-24.** Prod defaults to `tracesSampleRate=0.1`; local/dev/preview default to `1.0`. Revisit sampling once volume justifies tuning.

**What is wired:**

- `apps/api/src/instrument.ts` and `apps/worker/src/instrument.ts` are imported first and enable `httpIntegration`, `nativeNodeFetchIntegration`, `postgresIntegration`, and `contextLinesIntegration`. HTTP server spans and `pg` query spans are automatic.
- Every request gets a UUID `x-request-id` (echoed in response headers and error bodies), attached to the active Sentry scope and to an AsyncLocalStorage slot consumed by `@sitelayer/logger`.
- `recordSyncEvent` and `recordMutationOutbox` persist `sentry_trace`, `sentry_baggage`, and `request_id` on every enqueue (migration `005_trace_propagation.sql`). The worker calls `Sentry.continueTrace()` on each applied row so the queue hop shows up as a child span of the originating HTTP request.
- Web SDK ships `reactRouterV7BrowserTracingIntegration` + `replayIntegration` (masks text, inputs, and media) only after the lazy Sentry chunk loads. `main.tsx` uses a local React error boundary that reports through the lazy Sentry facade and also handles stale chunk reload recovery after deploys. Offline-queue replay emits an `offline_queue.replay` span with depth/replayed/dropped/conflict counts when Sentry is loaded.

**Agent trace lookup:** `GET /api/debug/traces/:traceId` (or `?by=request_id`) — Bearer `DEBUG_TRACE_TOKEN`, tier-gated against prod unless `DEBUG_ALLOW_PROD=1`, rate-limited. Proxies Sentry's `events-trace` API and joins local `mutation_outbox` and `sync_events` rows matching the trace or request id.

**Required env for full trace tooling** (see `.env.example`): `SENTRY_DSN`, optional `SENTRY_WORKER_DSN`, build-time `VITE_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_AUTH_TOKEN`, `DEBUG_TRACE_TOKEN`. Trace sample rate defaults to `0.1` in prod and `1.0` elsewhere; on-error replay `1.0`; session replay `0.1`.

## Pending Infrastructure & Setup

### Phase 1 — Environment & Secrets (DONE; snapshot in `INFRASTRUCTURE_READY.md`)

- [x] Domain (`sandolab.xyz` registered + DNS for prod and preview)
- [x] DigitalOcean Spaces — `sitelayer-blueprints-prod` provisioned in `tor1`, versioning enabled, scoped prod key wired
- [x] DigitalOcean Container Registry — `sitelayer` Starter registry in `tor1` for immutable runtime images
- [x] DigitalOcean managed Postgres 18 (`sitelayer_prod`, `sitelayer_preview`, `sitelayer_dev`)
- [x] Clerk app + OAuth credentials (env vars wired; enforcement gated on `CLERK_JWT_KEY` + `AUTH_ALLOW_HEADER_FALLBACK`)
- [x] `.env.example` scaffold; prod runtime source of truth is `/app/sitelayer/.env` (mode `600`) on the droplet, rendered by `scripts/render-production-env.mjs` from the `ops/env/production.env.json` manifest and reused across local-fleet deploys
- [x] Docker Compose: api + web + postgres + worker + MinIO (local), prod and preview variants

### Phase 2 — Initial Deployment (DONE)

- [x] Build and promote immutable runtime image (api, web, worker commands share one image)
- [x] Postgres schema migration runner (`scripts/migrate-db.sh`) + schema checker (`scripts/check-db-schema.sh`)
- [x] Seed data (LA Operations template via `seedCompanyDefaults` in `apps/api/src/onboarding.ts`)
- [x] Sentry wired across api/web/worker with trace propagation
- [x] Logical backup, Postgres off-host copy, blueprint-volume fallback copy, restore-drill, and timer-monitor timers running with Postgres 18 tooling
- [ ] QBO OAuth flow validated end-to-end against sandbox (`scripts/qbo-sandbox-smoke.sh` exists; needs real creds)
- [x] Blueprint uploads stream multipart through the API into Spaces (`MAX_BLUEPRINT_UPLOAD_BYTES`, default 200MB); legacy base64 JSON still accepted as a fallback for already-queued offline mutations

### Phase 3 — Pilot Customer Onboarding

- [x] Cut over to enforced Clerk auth in prod (`AUTH_ALLOW_HEADER_FALLBACK=0`, `CLERK_JWT_KEY` set)
- [x] Inject `DO_SPACES_KEY/SECRET` into prod tier so storage flips off the local volume
- [ ] Provision first pilot company + memberships via `/api/companies` + `/api/companies/:id/memberships`
- [ ] Train on crew scheduling + labor entry
- [ ] Daily QBO sync running clean
- [ ] Weekly business review

## Migration Roadmap (Post-Pilot)

**When**: After first customer completes 2-4 week pilot

1. **(No ORM migration.)** Raw parameterized SQL stays — see "Database ORM / Query Layer" above. If query type-safety becomes a measured pain, evaluate a SQL-first type generator (PgTyped) only; do not adopt Prisma/Drizzle.
2. **Clerk Auth** (1 week)
   - Replace hardcoded demo user
   - Per-company isolation
   - RBAC for crew vs. admin
3. **Sentry + Axiom** (3 days)
   - Error tracking
   - Structured logging
4. **Hatchet Evaluation** (1 week research)
   - Assess QBO sync reliability with pg-boss
   - Plan migration if needed
5. **Fastify Migration** (2 weeks, optional)
   - Only if endpoint count > 200 and code smell
   - Low priority; raw Node.js still fine

## Open Questions

1. **PDF Processing**: How are blueprints being processed today? (cropped, rotated, stored)
   - [ ] Investigate PDF.js + canvas rendering pipeline
   - [ ] Determine if ImageMagick/Ghostscript needed server-side

2. **QBO Sync Strategy**: Append-only events or full-sync nightly?
   - Current: Sketch includes bidirectional sync (estimate → invoice)
   - Need to decide: pull customer/items nightly, or push estimates as drafted?

3. **Multi-tenancy Row Security**: RLS policies in Postgres or app-level filtering?
   - Current: `ACTIVE_COMPANY_SLUG` env var (hardcoded demo)
   - Post-pilot: Need to implement per-user company isolation

## Decisions

### 5. Deterministic Workflows — Pure Reducers, Headless UI, Workflow Package (2026-04-28)

**Question (resolved):** How do we model multi-step business processes (rental billing, future estimate-push approval, ...) without scattering `if (status === 'foo')` across the codebase?

**Decision:** Every multi-step process is a deterministic state machine. Pure reducer + state version + headless UI + outbox-driven side effects. Documented in `docs/DETERMINISTIC_WORKFLOWS.md`.

**Mechanics:**

- Workflow definitions live in `packages/workflows/`. Each workflow exports state types, event types, snapshot type, pure transition function `(snapshot, event) → next_snapshot`, and a `nextEvents(state)` selector that the API uses to populate `WorkflowSnapshot.next_events`.
- API endpoints expose two routes per workflow: `GET /…/:id` returns a `WorkflowSnapshot { state, state_version, context, next_events }`, `POST /…/:id/events` takes `{ event, state_version }`, applies the reducer in one tx with optimistic version check, persists `state_version + 1`, and emits any side-effect intent (e.g. QBO push) into `mutation_outbox` with a stable per-entity idempotency key.
- Workers drain dedicated outbox mutation_types via `processRentalBillingInvoicePush(client, push)` etc. (added to `@sitelayer/queue`), check the entity's external-id field for idempotency before calling external APIs, and emit `*_SUCCEEDED` / `*_FAILED` events back through the same reducer.
- Frontend renders `state` + `context` + `next_events` straight from the snapshot. XState wraps **only** UI state (loading / submitting / showingError / outOfSync), never mirrors business state. 409s reload the fresh snapshot.
- Event request bodies are validated by Zod schemas exported from `@sitelayer/workflows` (e.g. `parseRentalBillingEventRequest`).

**Why this shape (not status toggles or Temporal-from-day-one):**

- Pure reducers are easy to reason about, test in isolation, and replay — the same transition table will move to Temporal activities when timers/retries justify it.
- Headless UI means a screen never accidentally invents new business states (e.g. an "approved-locally-pending-server" state that doesn't exist on the backend). The component is a thin renderer.
- One outbox row per workflow event keeps retries safe: stable idempotency_key per run id (not per state_version) so RETRY_POST replays upsert the same row.

**Scope:**

- First (and currently only) workflow: `rental_billing_runs`. States: `generated → approved → posting → posted | failed → voided`. Events: `APPROVE`, `POST_REQUESTED`, `POST_SUCCEEDED`, `POST_FAILED`, `RETRY_POST`, `VOID`. `POST_SUCCEEDED`/`POST_FAILED` are worker-only — rejected at the human event endpoint.
- Worker activates real QBO Invoice push when `QBO_LIVE_RENTAL_INVOICE=1`; otherwise a stub returns synthetic ids so dev/preview/fixtures still exercise the deterministic plumbing.
- Future workflows that fit this pattern: estimate push approval, schedule confirmation, blueprint review.

### 4. Offline Sync Conflict Resolution — Last-Write-Wins + Diagnostic Toast (2026-04-24)

**Question (resolved):** What if crew edits a measurement both online and offline?

**Decision:** Last-write-wins on the server, with a diagnostic toast on the offline client to surface that its local edit was discarded.

**Mechanics:**

- Each queued offline mutation captures a `client_updated_at` ISO timestamp at enqueue time (`OfflineMutation.clientUpdatedAt` in `apps/web/src/api.ts`).
- On replay the frontend sends `If-Unmodified-Since: <client_updated_at>` to the API.
- API endpoints for measurement updates (currently `PATCH /api/takeoff/measurements/:id`) consult the row's `updated_at`. If the server is strictly newer than the header, return `409` with the authoritative server value. Otherwise apply the write and bump `updated_at = now()`.
- On `409`, `replayOfflineMutations` drops the queued mutation and shows: "A newer change for {entity} was synced from another device — your local edit was discarded."

**Why LWW (not manual resolution):**

- Construction crews are mostly editing measurement quantities and notes; the cost of a lost local edit is small compared to UI complexity of a merge picker.
- LWW preserves the offline-first UX: queued writes either land or get discarded with a visible breadcrumb, never silently re-queue forever.
- The toast + Sentry breadcrumb (`offline_queue: lww conflict ...`) gives Taylor visibility into how often this fires; if the rate goes up we can revisit.

**Scope:**

- `takeoff_measurements` is the only entity wired through the LWW path today (its `updated_at` column was added in `012_takeoff_measurements_updated_at.sql`).
- Other entities (rentals, labor entries, estimate lines) still rely on optimistic-version `expected_version` checks. Those return `409` too but without an `If-Unmodified-Since`-driven toast; the offline replayer drops them on any 4xx as before.

**Tests:** `apps/api/src/lww.test.ts` covers parse, comparison, and the two-write race scenario.

## References

- **Domain Model**: See `packages/domain/src/index.ts`
- **Deployment**: See `DEPLOYMENT.md`, `INFRASTRUCTURE_READY.md`, `DEPLOY_RUNBOOK.md`
- **QBO Integration**: See `docs/QBO_EXTRACTION_CANONICAL_REFERENCE.md`
- **ADRs**: See `docs/adr/` (current architectural decisions)
- **Historical reference (pre-pilot)**: `docs/archived/` — requirements/product/architecture snapshots from 2026-04-23..25, kept for archaeology only
