# Sitelayer Preview Deployments

**Status:** Preview droplet, Traefik routing, fleet-driven deploy scripts (`scripts/deploy.sh dev|demo` → `scripts/deploy-preview.sh`), TTL cleanup timer, and `main` smoke preview are live. **Per-PR previews now use an ephemeral local Postgres container** (one throwaway `postgres:18-alpine` per stack); dev/demo still default to the managed cluster behind the `PREVIEW_DB_BACKEND` flag. See [Database Backend (`PREVIEW_DB_BACKEND`)](#database-backend-preview_db_backend).
**Last updated:** 2026-06-02

> **Related:** The persistent dev environment (`dev.sitelayer.sandolab.xyz`,
> backed by the dedicated `sitelayer_dev` database, tracking the `dev` branch)
> reuses the preview droplet + Traefik, but is documented
> separately in [`docs/DEV_ENVIRONMENT.md`](./DEV_ENVIRONMENT.md). It deploys via
> `scripts/deploy.sh dev` from the fleet → `scripts/deploy-preview.sh` with
> `PREVIEW_TIER=dev`, which skips per-slug schema isolation.

## Goal

Run branch/PR preview environments on a separate DigitalOcean droplet without risking production. Previews should make UI review easy while keeping production secrets, production data, and the production droplet isolated.

## Recommendation

Use the provisioned `sitelayer-preview` droplet in `tor1`.

The current `s-2vcpu-4gb` size is appropriate for the short term. It successfully built and ran the monorepo preview stack on 2026-04-23. Keep deploy concurrency serialized; if Docker builds or several concurrent previews create memory pressure, resize CPU/RAM upward before splitting hosts.

Do not create a second managed Postgres cluster yet. Use the existing `sitelayer-db` cluster with separate preview/dev databases and non-production users.

## Provisioned Preview Infrastructure

| Resource              | Value                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Droplet               | `sitelayer-preview`                                                                                                                                                                                                            |
| Droplet ID            | `566806040`                                                                                                                                                                                                                    |
| Region                | Toronto `tor1`                                                                                                                                                                                                                 |
| Size                  | `s-2vcpu-4gb`                                                                                                                                                                                                                  |
| RAM / CPU / disk      | 4GB RAM, 2 vCPU, 80GB disk                                                                                                                                                                                                     |
| Droplet public IPv4   | `137.184.169.208`                                                                                                                                                                                                              |
| Reserved IPv4 for DNS | `159.203.53.218`                                                                                                                                                                                                               |
| Private IPv4          | `10.118.0.2`                                                                                                                                                                                                                   |
| Firewall              | `sitelayer-preview`, ID `7a8f443e-cd74-4867-af8a-118559f33561`                                                                                                                                                                 |
| Firewall inbound      | SSH `22` from `50.71.113.46/32` and prod droplet `566798325`; HTTP `80` public; HTTPS `443` public                                                                                                                             |
| Firewall outbound     | TCP/UDP egress plus ICMP egress to `0.0.0.0/0` for package installs, Docker pulls, ACME, and update checks                                                                                                                     |
| Router                | Traefik v3 at `/opt/sitelayer-preview-router`, Docker network `sitelayer-preview-router`                                                                                                                                       |
| Shared env            | `/app/previews/.env.shared`, owner `sitelayer:sitelayer`, mode `600`                                                                                                                                                           |
| Shared preview DB     | `sitelayer_preview` on managed cluster `sitelayer-db`, user `sitelayer_preview_app`, per-preview schemas such as `sitelayer_pr_42`                                                                                             |
| Deploy driver         | Fleet-driven: `scripts/deploy.sh dev\|demo` (run from a fleet box such as taylor-pc-ubuntu) → `scripts/deploy-preview.sh` on the preview droplet. The self-hosted `sitelayer-preview` GitHub runner was removed in `70b9584b`. |
| TTL cleanup           | `sitelayer-preview-prune.timer`, daily, 14-day default, installed by `scripts/setup-preview-host.sh` / `scripts/install-preview-prune-systemd.sh`                                                                              |
| Smoke preview         | `https://main.preview.sitelayer.sandolab.xyz`                                                                                                                                                                                  |

The firewall does not expose public preview app ports such as `3000`. Traefik should be the only public ingress path.

## Verified Smoke Test

Verified on 2026-04-23:

- `https://main.preview.sitelayer.sandolab.xyz/health` returns API JSON over a valid TLS certificate.
- `HEAD /health` returns `200`.
- `https://main.preview.sitelayer.sandolab.xyz/api/bootstrap` reads seeded data from `sitelayer_preview`.
- `https://main.preview.sitelayer.sandolab.xyz/` serves the Vite app.

## Routing Model

Use a host-level reverse proxy on the preview droplet, preferably Traefik because it can route Docker containers by labels.

Public DNS:

```text
preview.sitelayer.sandolab.xyz     A  159.203.53.218
*.preview.sitelayer.sandolab.xyz   A  159.203.53.218
```

In the Cloudflare `sandolab.xyz` zone, the record names are `preview.sitelayer` and `*.preview.sitelayer`.

Example preview URLs:

```text
https://pr-42.preview.sitelayer.sandolab.xyz
https://feature-qbo-ui.preview.sitelayer.sandolab.xyz
```

Each branch/PR gets its own Docker Compose project:

```text
COMPOSE_PROJECT_NAME=sitelayer-pr-42
/app/previews/pr-42
/app/previews/pr-42/.env
```

The matching database schema keeps underscores, for example `sitelayer_pr_42`.

The preview stack should not publish arbitrary host ports. Traefik owns ports `80` and `443`; app containers stay on Docker networks.

## Compose Shape

Production uses `docker-compose.prod.yml` with its own Caddy edge container for automatic TLS. Preview uses `docker-compose.preview.yml`, which omits per-stack edge proxies and adds Traefik labels to `web` and `api`.

Target preview services:

- `web`: static Vite app served internally on `3000`
- `api`: API internally on `3001`
- `worker`: optional; disable for UI-only previews unless the branch needs sync behavior
- no per-preview nginx/Caddy
- local blueprint uploads persist in each preview stack's `blueprint_storage` Docker volume at `/app/storage/blueprints`

Routing:

- `Host(<slug>.preview.sitelayer.sandolab.xyz) && (Path(/api) || PathPrefix(/api/) || Path(/health))` -> `api:3001`
- `Host(<slug>.preview.sitelayer.sandolab.xyz)` -> `web:3000`

## Database Policy

Use two levels depending on preview needs:

1. **UI-only preview:** web can run locally with `VITE_FIXTURES=1` and skip the backend.
2. **Full-stack preview:** use the shared `sitelayer_preview` database with an isolated schema per slug. `pr-42` maps to `sitelayer_pr_42`; deploy sets `PGOPTIONS=-c search_path=<schema>,public`, creates the schema, applies migrations, and checks that schema before starting containers.

Never point previews at production data. Never reuse production DB credentials in preview stacks.

Current default:

- Shared database: `sitelayer_preview`
- Per-preview schema: `sitelayer_<slug with hyphens changed to underscores>`, for example `sitelayer_pr_42`
- Shared app user: `sitelayer_preview_app`
- Shared env path on preview host: `/app/previews/.env.shared`
- App URL uses normal `sslmode=require` plus `DATABASE_SSL_REJECT_UNAUTHORIZED=false` because DigitalOcean managed Postgres presents a certificate chain that Node `pg` rejects unless a CA bundle is configured.
- Maintenance commands use the same URL with `psql`; deploy and cleanup pass `PGOPTIONS` so migrations, checks, and application connections hit the preview schema instead of `public`.

## Database Backend (`PREVIEW_DB_BACKEND`)

`scripts/deploy-preview.sh` chooses where a stack's Postgres lives via `PREVIEW_DB_BACKEND`:

| Value     | Meaning                                                                                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed` | The DigitalOcean managed cluster `sitelayer-db` (today's behavior). `DATABASE_URL` comes from the shared env; the `preview` tier isolates a per-slug schema inside `sitelayer_preview`.                                                                                                         |
| `local`   | A Postgres **container** on the preview droplet (`docker-compose.preview-db.yml`, service `preview-db`). `DATABASE_URL` is rewritten to `postgres://sitelayer:sitelayer@preview-db:5432/sitelayer` (no TLS); migrations + the demo reseed run against the container; the schema stays `public`. |

**Default is tier-aware and conservative:**

- **`preview` → `local`** (active now). Each `pr-<n>` stack gets its own throwaway `postgres:18-alpine` container and a project-namespaced named volume (`sitelayer-pr-<n>_preview_db_data`) created on deploy, migrated, and **destroyed with the stack** by the existing `docker compose down -v` cleanup/reap path (`scripts/cleanup-preview.sh`, `scripts/preview-gc-remote.sh`, the in-deploy pre-flight reap). This removes per-slug-schema accumulation under heavy PR churn. Set `PREVIEW_DB_BACKEND=managed` for a single PR to fall back to the shared cluster + per-slug schema.
- **`dev` / `demo` → `managed`** (no auto-cutover). The operator flips `PREVIEW_DB_BACKEND=local` deliberately, after verifying. With `local`, each tier gets a **persistent** container + named volume (`sitelayer-dev_preview_db_data` / `sitelayer-demo_preview_db_data`) that survives watch-mode redeploys; a deliberate reset recreates it.

The container is on the stack's `app` Docker network only (`internal: true` — no host/internet exposure). `api`/`worker` reach it over that network; migrations run from a psql container that joins `<project>_app` (`PSQL_DOCKER_NETWORK`).

**Cutover (dev/demo) — disposable data, so no data move:** because non-prod data is throwaway, "cutover" is just _point + migrate + reseed_. On the preview droplet, set `PREVIEW_DB_BACKEND=local` for the tier (env on the `scripts/deploy.sh dev|demo` invocation, or persist it in `/app/previews/.env.{dev,demo}.shared`) and redeploy. The deploy starts the container, applies migrations, and (demo) reseeds.

### Resetting a non-prod DB

Non-prod DBs are trivially resettable:

- `scripts/reset-tier-db.sh <dev|demo|preview> [slug]` — the general helper.
  - **local** backend → recreate the container + its named volume (instant), then re-migrate. For `demo`, re-run `scripts/deploy.sh demo` to reapply the seed.
  - **managed** backend → conservative per-object drop: `preview` drops + recreates its per-slug schema; `dev` delegates to `scripts/reset-dev-db.sh` (per-object public-schema drop); managed `demo` is intentionally not automated (flip it to `local`, or reset by hand with operator review).
- `scripts/reset-dev-db.sh` still works as before for the managed dev DB, and now auto-delegates to `reset-tier-db.sh dev` when the dev stack runs the local backend.

### End state

The intended steady state:

- **Managed cluster `sitelayer-db` = PROD ONLY.** Prod keeps its forward-only/immutable migration discipline (`scripts/deploy.sh prod`), its managed connection pool (`sitelayer-prod-pool`), and is the only durable tier.
- **dev / demo / preview = Docker Postgres on the preview droplet** (disposable). Migration churn on these tiers is free; non-prod tiers stop competing for the managed cluster's ~47 raw connections.

`PREVIEW_DB_BACKEND` defaults keep dev/demo on the managed cluster until the operator does the deliberate per-tier cutover; only the already-ephemeral per-PR previews moved to local Postgres immediately.

## Deploy Flow

Preview/dev/demo deploys are fleet-driven, not GitHub Actions. The `.github/workflows/deploy-preview.yml` workflow and the self-hosted `sitelayer-preview` runner were removed in commit `70b9584b`; the last remaining workflow, `.github/workflows/quality.yml`, was deleted on 2026-06-02, so **no GitHub Actions remain**. The single verification authority is the local gate `scripts/verify-local.sh` (`npm run verify`), run by `scripts/deploy.sh` and the fleet auto-deploy watcher — there is no CI deploy gate.

Run the deploy from a fleet box (e.g. taylor-pc-ubuntu):

- `scripts/deploy.sh dev` and `scripts/deploy.sh demo` dispatch to `scripts/deploy-preview.sh` on the preview droplet.
- These persistent stacks run in source-mounted watch-mode (tsx + Vite HMR) — no `docker compose up --build`. PR-style slug previews are still driven by `scripts/deploy-preview.sh` directly.

What `scripts/deploy-preview.sh` does on the preview droplet:

- Computes the slug (`pr-<number>` for a PR preview, or `dev` / `demo` for the persistent tiers).
- Stages code under `/app/previews/<slug>`.
- Renders `.env` from the shared env file (`/app/previews/.env.shared`, or `.env.dev.shared` / `.env.demo.shared`) plus slug-specific host and schema values.
- For per-slug previews, creates the preview schema, runs migrations in that schema, and checks that schema.
- Brings up the stack with `docker compose -p sitelayer-<slug> ...`.
- Health-checks `https://<slug>.preview.sitelayer.sandolab.xyz/health`.

Cleanup:

1. Run `scripts/cleanup-preview.sh` for `pr-<number>` (e.g. from the fleet, or when a slug is retired).
2. Stop containers and either drop the preview schema (managed backend, `.env` contains `PREVIEW_DB_SCHEMA`) or destroy the per-stack Postgres volume (local backend, `.env` contains `PREVIEW_DB_BACKEND=local`). For local-backend stacks the cleanup/reap path layers `-f docker-compose.preview-db.yml` so `down -v` drops the `preview_db_data` volume.
3. Remove `/app/previews/<slug>`.
4. Prune old images/volumes with the TTL guard.

The TTL guard runs as a systemd prune timer rather than the removed `preview-gc.yml` workflow. Fresh preview hosts install it during `scripts/setup-preview-host.sh` (also installable via `scripts/install-preview-prune-systemd.sh`). The service points at `/app/previews/main/scripts/prune-preview-stacks.sh`; before the `main` preview exists it exits cleanly, then becomes active after the first `main` deploy.

## Security Rules

- Preview deploys are driven from the fleet (`scripts/deploy.sh dev|demo` → `scripts/deploy-preview.sh`), which SSHes to the preview droplet. There is no self-hosted GitHub runner and no GitHub-Actions secret path.
- Preview env uses sandbox or blank Clerk/QBO/Spaces/Sentry values.
- Preview blueprint uploads are stored in a per-stack Docker volume; do not upload customer-sensitive plans to preview until access control and retention policy are explicit.
- Preview deploys run only for trusted internal branches; only deploy refs you trust.
- Preview branch code can execute Docker build scripts on the preview host; treat this as privileged execution.
- Whoever holds fleet SSH access to the preview host effectively has privileged execution there. Only deploy trusted internal refs from the fleet.
- Protect preview URLs with basic auth or IP allowlisting if customer data appears there.
- Do not expose public port `3000`; only `80` and `443` should be open.

## Capacity Guidance

Approximate starting point:

- `s-2vcpu-2gb`: 1-2 low-traffic full-stack previews, builds may be tight.
- `s-2vcpu-4gb`: 3-6 low-traffic previews with serialized builds.
- `s-4vcpu-8gb`: many previews or faster builds, but this costs the same class as production.

Keep preview deploy concurrency low. Serialize deploys from the fleet (one `scripts/deploy.sh` invocation at a time per slug) and let builds serialize on the preview droplet.

## Scaling Up

DigitalOcean supports vertical Droplet resize.

- CPU/RAM-only resize is reversible and does not permanently grow disk.
- Disk/CPU/RAM resize permanently grows the root disk and cannot be shrunk later.
- Resize requires downtime because the Droplet must be powered off or moved.
- Snapshot before resize.

For this preview host, prefer CPU/RAM-only upgrades first:

```text
s-2vcpu-4gb  -> s-4vcpu-8gb
s-4vcpu-8gb  -> larger CPU/RAM shape if preview traffic/build pressure grows
```

If the bottleneck is Docker image storage, attach a volume for Docker data or do a permanent disk resize. Do not permanently grow root disk unless needed.

## Open Implementation Tasks

- [x] Install Docker and base packages on `sitelayer-preview`.
- [x] Add wildcard preview DNS under `sitelayer.sandolab.xyz`.
- [x] Install Traefik on preview droplet.
- [x] Create `docker-compose.preview.yml`.
- [x] Wire fleet-driven preview deploys via `scripts/deploy.sh dev|demo` → `scripts/deploy-preview.sh` (the GitHub Actions `deploy-preview.yml` workflow was removed in `70b9584b`).
- [x] Add `scripts/cleanup-preview.sh` for slug teardown.
- [x] Create shared preview DB/user on existing `sitelayer-db`.
- [x] Smoke deploy `main.preview.sitelayer.sandolab.xyz`.
- [x] Add TTL-based Docker image/container cleanup script.
- [x] Install TTL cleanup timer.
