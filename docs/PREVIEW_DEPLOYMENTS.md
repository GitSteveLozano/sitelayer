# Sitelayer Preview Deployments

**Status:** Preview droplet, Traefik routing, shared preview DB, deploy scripts, GitHub self-hosted runner, TTL cleanup timer, and `main` smoke preview are live
**Last updated:** 2026-04-23

## Goal

Run branch/PR preview environments on a separate DigitalOcean droplet without risking production. Previews should make UI review easy while keeping production secrets, production data, and the production droplet isolated.

## Recommendation

Use the provisioned `sitelayer-preview` droplet in `tor1`.

The current `s-2vcpu-4gb` size is appropriate for the short term. It successfully built and ran the monorepo preview stack on 2026-04-23. Keep deploy concurrency serialized; if Docker builds or several concurrent previews create memory pressure, resize CPU/RAM upward before splitting hosts.

Do not create a second managed Postgres cluster yet. Use the existing `sitelayer-db` cluster with separate preview/dev databases and non-production users.

## Provisioned Preview Infrastructure

| Resource | Value |
|----------|-------|
| Droplet | `sitelayer-preview` |
| Droplet ID | `566806040` |
| Region | Toronto `tor1` |
| Size | `s-2vcpu-4gb` |
| RAM / CPU / disk | 4GB RAM, 2 vCPU, 80GB disk |
| Droplet public IPv4 | `137.184.169.208` |
| Reserved IPv4 for DNS | `159.203.53.218` |
| Private IPv4 | `10.118.0.2` |
| Firewall | `sitelayer-preview`, ID `7a8f443e-cd74-4867-af8a-118559f33561` |
| Firewall inbound | SSH `22` from `50.71.113.46/32`; HTTP `80` public; HTTPS `443` public |
| Firewall outbound | TCP/UDP egress plus ICMP egress to `0.0.0.0/0` for package installs, Docker pulls, ACME, and update checks |
| Router | Traefik v3 at `/opt/sitelayer-preview-router`, Docker network `sitelayer-preview-router` |
| Shared env | `/app/previews/.env.shared`, owner `sitelayer:sitelayer`, mode `600` |
| Shared preview DB | `sitelayer_preview` on managed cluster `sitelayer-db`, user `sitelayer_preview_app` |
| GitHub runner | `sitelayer-preview`, service `actions.runner.GitSteveLozano-sitelayer.sitelayer-preview.service` |
| TTL cleanup | `sitelayer-preview-prune.timer`, daily, 14-day default |
| Smoke preview | `https://main.preview.sitelayer.sandolab.xyz` |

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
COMPOSE_PROJECT_NAME=sitelayer_pr_42
/app/previews/pr-42
/app/previews/pr-42/.env
```

The preview stack should not publish arbitrary host ports. Traefik owns ports `80` and `443`; app containers stay on Docker networks.

## Compose Shape

Production uses `docker-compose.prod.yml` with its own nginx container. Preview uses `docker-compose.preview.yml`, which omits per-stack nginx and adds Traefik labels to `web` and `api`.

Target preview services:

- `web`: static Vite app served internally on `3000`
- `api`: API internally on `3001`
- `worker`: optional; disable for UI-only previews unless the branch needs sync behavior
- no per-preview `nginx`

Routing:

- `Host(<slug>.preview.sitelayer.sandolab.xyz) && (Path(/api) || PathPrefix(/api/) || Path(/health))` -> `api:3001`
- `Host(<slug>.preview.sitelayer.sandolab.xyz)` -> `web:3000`

## Database Policy

Use three levels depending on preview needs:

1. **UI-only preview:** web points at a shared preview API/database with seeded demo data.
2. **Full-stack preview:** create `sitelayer_preview_<slug>` on the existing managed Postgres cluster and apply schema/seed data.
3. **Migration-risk preview:** require explicit approval. Branch migrations can drift or destroy preview data, so do not run them automatically against shared databases.

Never point previews at production data. Never reuse production DB credentials in preview stacks.

Current default:

- Shared database: `sitelayer_preview`
- Shared app user: `sitelayer_preview_app`
- Shared env path on preview host: `/app/previews/.env.shared`
- App URL uses normal `sslmode=require` plus `DATABASE_SSL_REJECT_UNAUTHORIZED=false` because DigitalOcean managed Postgres presents a certificate chain that Node `pg` rejects unless a CA bundle is configured.
- Maintenance commands can still use the same URL with `psql` because `sslmode=require` remains libpq-compatible.

## GitHub Actions Flow

Preview automation is defined in `.github/workflows/deploy-preview.yml`.

Trigger candidates:

- `pull_request` opened/synchronize/reopened for internal branches only
- `workflow_dispatch` with a branch input
- optionally `push` to `preview/**`

Do not run secret-bearing preview deploys for untrusted fork PRs.

Current workflow design:

- Runs on a self-hosted runner labeled `sitelayer-preview`.
- Computes `pr-<number>` for PRs or uses a manual dispatch slug.
- Runs `scripts/deploy-preview.sh` from the checked-out commit.
- Stages code under `/app/previews/<slug>`.
- Renders `.env` from `/app/previews/.env.shared` plus slug-specific host values.
- Runs `docker compose -p sitelayer-<slug> -f docker-compose.preview.yml up -d --build --remove-orphans`.
- Health-checks `https://<slug>.preview.sitelayer.sandolab.xyz/health`.

Cleanup workflow:

1. On PR close, run on the `sitelayer-preview` self-hosted runner.
2. Run `scripts/cleanup-preview.sh` for `pr-<number>`.
3. Remove `/app/previews/<slug>`.
4. Delete branch-specific preview DB if one was created manually.
5. Prune old images/volumes with a TTL guard.

Runner registration completed on 2026-04-24 using an owner-provided token. The runner package is installed at `/home/sitelayer/actions-runner`, and the service is active/enabled:

```bash
systemctl status actions.runner.GitSteveLozano-sitelayer.sitelayer-preview.service
```

The current `taylorSando` token still cannot list repo runners through the REST API (`403`), but the runner service log shows a successful GitHub broker session and `Listening for Jobs`.

## Security Rules

- Preview droplet uses separate SSH key and GitHub secrets from production.
- Preview env uses sandbox or blank Clerk/QBO/Spaces/Sentry values.
- Preview deploys run only for trusted internal branches unless manually approved.
- Preview branch code can execute Docker build scripts on the preview host; treat this as privileged execution.
- A self-hosted GitHub runner on the preview host is also privileged execution. Only run it for trusted internal branches or manually approved workflow dispatches.
- Protect preview URLs with basic auth or IP allowlisting if customer data appears there.
- Do not expose public port `3000`; only `80` and `443` should be open.

## Capacity Guidance

Approximate starting point:

- `s-2vcpu-2gb`: 1-2 low-traffic full-stack previews, builds may be tight.
- `s-2vcpu-4gb`: 3-6 low-traffic previews with serialized builds.
- `s-4vcpu-8gb`: many previews or faster builds, but this costs the same class as production.

Keep preview deploy concurrency low. Let GitHub Actions cancel in-progress deploys per branch and serialize builds on the preview droplet.

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
- [x] Add `.github/workflows/deploy-preview.yml`.
- [x] Add preview cleanup workflow.
- [x] Create shared preview DB/user on existing `sitelayer-db`.
- [x] Smoke deploy `main.preview.sitelayer.sandolab.xyz`.
- [x] Register self-hosted GitHub runner with label `sitelayer-preview`.
- [x] Add PR comment with preview URL after deploy.
- [x] Add TTL-based Docker image/container cleanup script.
- [x] Install TTL cleanup timer.
