# Sitelayer Deployment Guide

## Overview

Sitelayer is deployed to a DigitalOcean Droplet using Docker Compose. The GitHub Actions workflow automatically builds one immutable runtime image, pushes it to DigitalOcean Container Registry, and deploys production on push to `main`.

## Initial Droplet Setup

### 1. Prerequisites

- DigitalOcean account with Droplet created (Ubuntu 22.04 LTS recommended)
- Public SSH key added to the Droplet
- Reserved IP assigned (optional but recommended)
- Managed PostgreSQL database provisioned

### 2. Droplet Configuration

SSH into the droplet and run initial setup:

```bash
# Update system
apt-get update && apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install other tools used by deployment and database initialization
apt-get install -y git curl postgresql-client

# Verify Docker Compose is available. The install script normally provides
# the `docker compose` plugin; the deployment workflow also supports legacy
# `docker-compose` if you install it separately.
docker compose version
```

### 3. Create Deployment User

Run the deployment user setup script **as root**:

```bash
# As root on the droplet
bash /tmp/setup-deploy-user.sh
```

Or manually create the user with minimal permissions:

```bash
# Create user
useradd -m -s /bin/bash sitelayer

# Set up app directory
mkdir -p /app/sitelayer
chown -R sitelayer:sitelayer /app/sitelayer

# Add to docker group. This avoids root SSH but is still root-equivalent.
usermod -aG docker sitelayer
```

Docker daemon access can build and run privileged containers. Treat the deployment SSH key as production-root-equivalent even though direct root login is not used.

> **SECURITY NOTE (2026-04-24):** Membership in `docker` is functionally root because the Docker socket lets a caller mount any host path into a privileged container. We accept this on the production droplet today because the GitHub Actions deploy workflow (`.github/workflows/deploy-droplet.yml`) SSHes in as `sitelayer` and runs `docker compose ...` directly. Removing `sitelayer` from `docker` would also require either (a) a `/etc/sudoers.d/sitelayer-docker` granting `NOPASSWD: /usr/bin/docker, /usr/bin/docker-compose` and a deploy-script change to prepend `sudo`, or (b) a rootless-Docker reinstall. Tracked separately; do not silently fix during unrelated work. Until then: rotate `DEPLOY_SSH_KEY` if it ever leaves the GitHub secrets store and prefer non-root inside containers (see Dockerfile `USER node`).

### 4. Configure SSH Access for Deployment User

On your local machine, generate an SSH key for deployments:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/sitelayer_deploy -C "sitelayer-deploy"
```

Then add the public key to the droplet:

```bash
# On droplet, as sitelayer user
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo "YOUR_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 5. Clone Repository

As the `sitelayer` user:

```bash
cd /app/sitelayer
git clone https://github.com/GitSteveLozano/sitelayer.git .
```

### 6. Environment Configuration

Create `/app/sitelayer/.env` owned by the `sitelayer` user. `DATABASE_URL`, production auth, `API_METRICS_TOKEN`, and Spaces credentials are required for the current production profile.

```bash
cat > /app/sitelayer/.env << 'EOF'
# Database (managed DigitalOcean PostgreSQL)
DATABASE_URL=postgresql://user:password@host:25060/defaultdb?sslmode=require
# DO managed Postgres until a CA bundle is configured.
DATABASE_SSL_REJECT_UNAUTHORIZED=false

# API Configuration
APP_TIER=prod
PORT=3001
NODE_ENV=production
ACTIVE_COMPANY_SLUG=la-operations
ACTIVE_USER_ID=demo-user

# QBO Integration (optional until Intuit production credentials are ready)
QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
QBO_REDIRECT_URI=https://your-domain.com/api/integrations/qbo/callback
QBO_SUCCESS_REDIRECT_URI=https://your-domain.com/?qbo=connected
QBO_ENVIRONMENT=production
QBO_STATE_SECRET=

# Clerk Authentication (prod requires Clerk JWT key or INTERNAL_AUTH_TOKEN)
CLERK_JWT_KEY=
CLERK_ISSUER=
CLERK_WEBHOOK_SECRET=
AUTH_ALLOW_HEADER_FALLBACK=
AUTH_ALLOW_HEADER_FALLBACK_BREAK_GLASS=
INTERNAL_AUTH_TOKEN=

# Metrics
API_METRICS_TOKEN=<generate-32b-random>

# DigitalOcean Spaces
DO_SPACES_KEY=<scoped-readwrite-key>
DO_SPACES_SECRET=<scoped-readwrite-secret>
DO_SPACES_BUCKET=sitelayer-blueprints-prod
DO_SPACES_REGION=tor1
DO_SPACES_ENDPOINT=https://tor1.digitaloceanspaces.com

# Local durable blueprint storage fallback.
# docker-compose.prod.yml persists this path in the blueprint_storage volume.
BLUEPRINT_STORAGE_ROOT=/app/storage/blueprints
# Emergency-only escape hatch if Spaces is unavailable. Leave blank in prod.
ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD=

# Frontend
# These are build-time inputs. Production deploy passes them to `docker build`;
# editing `/app/sitelayer/.env` after deploy does not change the already-built
# browser bundle.
VITE_API_URL=
VITE_COMPANY_SLUG=la-operations
VITE_USER_ID=demo-user

# Optional: Error Tracking
SENTRY_DSN=
SENTRY_WORKER_DSN=
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.1
VITE_SENTRY_DSN=
VITE_SENTRY_ENVIRONMENT=production

# CORS
ALLOWED_ORIGINS=https://your-domain.com
EOF

chmod 600 /app/sitelayer/.env
chown sitelayer:sitelayer /app/sitelayer/.env
```

### 7. Initialize Database

As the `sitelayer` user:

```bash
cd /app/sitelayer
ENV_FILE=/app/sitelayer/.env scripts/migrate-db.sh
ENV_FILE=/app/sitelayer/.env scripts/check-db-schema.sh
```

The production GitHub Actions deploy builds images, takes a pre-migration
logical backup, then runs both commands before replacing containers. The runner
records each migration in `schema_migrations` with a checksum and holds a
transaction-scoped advisory lock so overlapping deploys cannot apply migrations
concurrently. Do not edit a committed migration after it has run in any shared
environment; add a new SQL file instead. Keep seed data guarded by `NOT EXISTS`
checks unless a real unique constraint exists.

For the local Docker database, use the Compose network instead of opening the
database port:

```bash
PSQL_DOCKER_NETWORK=sitelayer_default \
  DATABASE_URL=postgres://sitelayer:sitelayer@db:5432/sitelayer \
  scripts/check-db-schema.sh
```

### 8. TLS Certificate

Caddy is the production reverse proxy in `docker-compose.prod.yml`. It binds
ports `80` and `443`, automatically obtains a Let's Encrypt certificate for
`sitelayer.sandolab.xyz`, and redirects HTTP to HTTPS.

### 9. Start Services

As the `sitelayer` user:

```bash
cd /app/sitelayer
APP_IMAGE=registry.digitalocean.com/sitelayer/sitelayer:<git-sha> \
  docker compose -f docker-compose.prod.yml up -d
```

Or via GitHub Actions (automatic on push to `main`).

## GitHub Actions Deployment

### 1. Configure GitHub Secrets

Add the following secrets to your GitHub repository settings:

- `DEPLOY_HOST`: Droplet IP or domain (e.g., `165.245.230.3` or `sitelayer.sandolab.xyz`)
- `DEPLOY_SSH_KEY`: Private SSH key content from `~/.ssh/sitelayer_deploy` (the deployment user's key)
- `DIGITALOCEAN_ACCESS_TOKEN`: token with registry read/write access for pushing immutable images and minting short-lived registry pull credentials

The workflow uses the `sitelayer` deployment user and does not expose the root SSH key. Because the user can access Docker, the deployment key is still root-equivalent and must be protected accordingly.

### 2. Trigger Deployment

Push to `main` to trigger automatic production deployment:

```bash
git push origin main
```

The GitHub Actions workflow will:

1. Check out the code
2. Build `registry.digitalocean.com/sitelayer/sitelayer:<git-sha>`
3. Push both `<git-sha>` and `main` image tags to DigitalOcean Container Registry
4. Mint short-lived read-only registry pull credentials for the droplet
5. SSH into the droplet
6. Pull latest repo metadata from GitHub
7. Pull the exact image tag built for this commit
8. Run a pre-migration logical backup with `scripts/backup-postgres.sh`
9. Run `scripts/migrate-db.sh`
10. Run `scripts/check-db-schema.sh`
11. Start services with `APP_IMAGE=<sha-image> docker compose up -d --remove-orphans`
12. Verify public HTTPS health, `/api/version`, web root, metrics gating, and container state

## Tier Isolation

Sitelayer runs in one of four tiers, declared explicitly via `APP_TIER`:

| Tier      | DB (DigitalOcean managed Postgres) | Spaces bucket                             | Purpose                                     |
| --------- | ---------------------------------- | ----------------------------------------- | ------------------------------------------- |
| `local`   | `postgres` in `docker-compose.yml` | MinIO bucket `sitelayer-blueprints-local` | Laptop-only development                     |
| `dev`     | `sitelayer_dev`                    | `sitelayer-blueprints-dev`                | Shared sandbox; Claude Desktop / MCP agents |
| `preview` | `sitelayer_preview`                | `sitelayer-blueprints-preview`            | Per-PR stacks, non-technical demos          |
| `prod`    | `sitelayer_prod`                   | `sitelayer-blueprints-prod`               | Real customers only                         |

**Startup guard.** On boot the API reads `APP_TIER`, `DATABASE_URL`, and `DO_SPACES_BUCKET` and refuses to start on mismatch. Concrete rules:

- `APP_TIER=prod` requires `DATABASE_URL` to reference `sitelayer_prod`.
- Any non-prod tier that points at a `sitelayer_prod` database crashes at startup.
- `APP_TIER=prod` requires `DO_SPACES_BUCKET` to end in `-prod` (or equal the legacy `sitelayer-blueprints`).
- Any non-prod tier pointed at a `*-prod*` bucket crashes.

This prevents an accidentally-copied `.env` from letting a dev stack overwrite customer data.

**Feature flags.** `FEATURE_FLAGS` is a comma-separated allowlist. Recognized values:

- `read-prod-ro` — unlocks a separate read-only pool via `DATABASE_URL_PROD_RO` (user must be a `_ro` or `readonly` role). Forbidden in prod.
- `qbo-live` — preview can hit real QBO sandbox instead of fixtures.
- `pdf-ocr-experimental` — opt in to unstable OCR path.

Unknown flags are logged and ignored. The active tier and flags are returned by `GET /api/features` and displayed as a ribbon at the top of the web UI (non-prod only).

**Non-technical collaborator rules.**

- They use the `main.preview.sitelayer.sandolab.xyz` URL (or equivalent) — never prod directly.
- No prod creds on their machine. If they use Claude Desktop with an MCP server, it connects to `sitelayer_dev` only.
- The ribbon is the ground truth: if they don't see "PREVIEW" or "DEV DATA" they're in the wrong place.

**Enabling `read-prod-ro` for a preview.**

1. Run `psql "$PROD_DATABASE_URL" -v password="'…'" -f scripts/sitelayer_prod_ro.sql` against the prod cluster. The script is idempotent.
2. Put the resulting connection string in `DATABASE_URL_PROD_RO` in the preview stack's `.env.shared`.
3. Add `read-prod-ro` to `FEATURE_FLAGS` for that stack.
4. The preview bootstraps a second pg pool; any accidental write is rejected at the Postgres role level, not just by app logic.

**Provisioning per-tier Spaces buckets.**

```
DO_SPACES_KEY=… DO_SPACES_SECRET=… ./scripts/provision-spaces-buckets.sh
```

Creates `sitelayer-blueprints-{dev,preview,prod}`, private ACL + public-access-block. Idempotent — existing buckets are skipped. Then put the matching name in each tier's `DO_SPACES_BUCKET`.

**Storage adapter.** `apps/api/src/storage.ts` picks a backend at startup:

- If `DO_SPACES_KEY` + `DO_SPACES_SECRET` + `DO_SPACES_BUCKET` are all set → S3/Spaces client (works for DO Spaces, MinIO, or any S3-compatible endpoint via `DO_SPACES_ENDPOINT`).
- Otherwise → local filesystem at `BLUEPRINT_STORAGE_ROOT`.

`storage_path` column is now an opaque key (`<companyId>/<blueprintId>/<filename>`), not an absolute path. Legacy rows with `/app/storage/blueprints/...` still resolve via a prefix-strip compatibility shim.

Local compose ships a MinIO container at `http://minio:9000` with console at `:9001` (`sitelayerlocal`/`sitelayerlocal`). The `minio-init` one-shot creates `sitelayer-blueprints-local` on boot.

**Write-origin audit column.** Migration `docker/postgres/init/002_tier_origin.sql` adds an `origin text` column to `projects`, `blueprint_documents`, `takeoff_measurements`, `labor_entries`, `material_bills`, `crew_schedules`, `estimate_lines`. Defaults to `current_setting('app.tier', true)`. The API/worker pools pass Postgres startup options (`-c app.tier=<tier>`) so newly-inserted rows are self-labeled before any query can race the connection setup.

Applying to existing deployed DBs:

```
ENV_FILE=/app/sitelayer/.env MIGRATION_FILES="docker/postgres/init/002_tier_origin.sql" scripts/migrate-db.sh
```

Idempotent (`ADD COLUMN IF NOT EXISTS`). Existing rows stay NULL in the origin column — that's fine, only future writes get tagged.

**Dev data seeding.** `npm run seed:dev` attaches the PDFs in `blueprints_sample/` to the LA Operations demo project and uploads them through the active storage adapter. Idempotent. Refuses to run when `APP_TIER=prod`. Run this manually for local/dev/preview seed refreshes.

**Takeoff geometry.** Polygon board-space math and validation live in `@sitelayer/domain`. The web uses it for live quantity/centroid display, and the API uses it to normalize polygon geometry and validate blueprint ownership before writing `takeoff_measurements`, including bulk replacement.

**Queue processing.** The API and worker use Postgres-backed queue tables instead of an external Redis dependency. `mutation_outbox` and `sync_events` are claimed with a short processing lease, using `FOR UPDATE SKIP LOCKED`, then marked `applied`. The shared SQL/transaction implementation lives in `packages/queue` and is covered by unit tests so API-triggered sync and the worker cannot drift. This is still a local/simulated processor until live QBO sync is enabled, but it prevents multiple workers from processing the same row and leaves retry metadata (`attempt_count`, `next_attempt_at`, `error`) for the real connector.

## Environment Variables Reference

| Variable                                 | Required   | Description                                                                                                                |
| ---------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `APP_TIER`                               | ✅ in prod | `local`\|`dev`\|`preview`\|`prod`. Startup guard refuses to boot on mismatch.                                              |
| `FEATURE_FLAGS`                          | ❌         | Comma-separated. See Tier Isolation above.                                                                                 |
| `DATABASE_URL`                           | ✅         | PostgreSQL connection string (use managed database)                                                                        |
| `DATABASE_URL_PROD_RO`                   | ❌         | Read-only prod pool for `read-prod-ro` flag; user must be `_ro`/readonly role.                                             |
| `PORT`                                   | ❌         | API port; Compose sets `3001`                                                                                              |
| `NODE_ENV`                               | ❌         | Compose sets `production`                                                                                                  |
| `QBO_CLIENT_ID`                          | ❌         | QuickBooks Online client ID; defaults to demo placeholders until configured                                                |
| `QBO_CLIENT_SECRET`                      | ❌         | QuickBooks Online client secret; defaults to demo placeholders until configured                                            |
| `QBO_REDIRECT_URI`                       | ❌         | OAuth redirect URI for QBO                                                                                                 |
| `QBO_SUCCESS_REDIRECT_URI`               | ❌         | UI redirect after QBO OAuth success                                                                                        |
| `QBO_STATE_SECRET`                       | ❌         | Secret used to sign QBO OAuth state                                                                                        |
| `CLERK_SECRET_KEY`                       | ❌         | Reserved for future Clerk Backend API calls; current request auth does not read it.                                        |
| `CLERK_JWT_KEY`                          | ✅ in prod | Clerk JWT public key. Prod refuses to boot unless `CLERK_JWT_KEY` or `INTERNAL_AUTH_TOKEN` is configured.                  |
| `AUTH_ALLOW_HEADER_FALLBACK`             | ❌         | Dev/preview escape hatch for header/default identity. Prod refuses this unless `AUTH_ALLOW_HEADER_FALLBACK_BREAK_GLASS=1`. |
| `AUTH_ALLOW_HEADER_FALLBACK_BREAK_GLASS` | ❌         | Emergency-only prod override for header fallback; never leave enabled.                                                     |
| `INTERNAL_AUTH_TOKEN`                    | ❌         | Service bearer token. Also satisfies the prod auth startup guard when Clerk is unavailable.                                |
| `API_METRICS_TOKEN`                      | ✅ in prod | Bearer token required for `/api/metrics`; prod refuses to boot without it.                                                 |
| `APP_IMAGE`                              | ✅ deploy  | Immutable runtime image tag; deploy exports `registry.digitalocean.com/sitelayer/sitelayer:<git-sha>`.                     |
| `VITE_CLERK_PUBLISHABLE_KEY`             | ✅ web     | Public Clerk frontend key baked into the web bundle at image build time.                                                   |
| `VITE_API_URL`                           | ❌         | Frontend API base URL. Leave blank in same-origin production so Caddy routes `/api/*` to the API.                          |
| `VITE_APP_TIER`                          | ❌         | Frontend tier hint used by the ribbon and build metadata.                                                                  |
| `VITE_SENTRY_DSN`                        | ❌         | Public web Sentry DSN. When blank, the web Sentry chunk is never loaded.                                                   |
| `VITE_SENTRY_TRACES_SAMPLE_RATE`         | ❌         | Web trace sample rate. Defaults to `0.1` in prod, `1.0` elsewhere.                                                         |
| `SENTRY_ENVIRONMENT`                     | ❌         | API/worker Sentry environment label. Compose defaults it to `production`.                                                  |
| `SENTRY_WORKER_DSN`                      | ❌         | Optional worker-specific Sentry DSN. When blank, worker falls back to `SENTRY_DSN`.                                        |
| `SENTRY_TRACES_SAMPLE_RATE`              | ❌         | API/worker trace sample rate. Defaults to `0.1` in prod, `1.0` elsewhere.                                                  |
| `DO_SPACES_KEY`                          | ✅ in prod | Scoped DigitalOcean Spaces read/write key for `sitelayer-blueprints-prod`.                                                 |
| `DO_SPACES_SECRET`                       | ✅ in prod | Scoped DigitalOcean Spaces secret.                                                                                         |
| `ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD`  | ❌         | Temporary prod escape hatch for local blueprint storage; requires off-host volume backups while set.                       |
| `BLUEPRINT_STORAGE_ROOT`                 | ❌         | Local filesystem blueprint storage path; production Compose persists `/app/storage/blueprints` in a named Docker volume    |
| `SENTRY_DSN`                             | ❌         | API Sentry error tracking URL; worker uses this too unless `SENTRY_WORKER_DSN` is set.                                     |
| `ALLOWED_ORIGINS`                        | ❌         | CORS allowed origins (comma-separated)                                                                                     |

## Web Serving, Caching, and Bundle Budget

Production serves `apps/web/dist` through the `@sitelayer/web` package script:

```bash
npm start -w @sitelayer/web
# runs: serve -l 3000 dist
```

Do not add `serve -s` here. The SPA fallback is intentionally expressed in `apps/web/public/serve.json` as explicit route rewrites so missing `/assets/...` URLs return `404` instead of cached `index.html`.

Current browser cache contract:

- `/assets/**` — `Cache-Control: public, max-age=31536000, immutable`; all Vite assets are hashed, so repeat visits download only changed files.
- `/index.html` — `Cache-Control: no-cache` plus `ETag`; browsers revalidate and receive `304` when unchanged.
- `/sitelayer-logo.svg` — `Cache-Control: public, max-age=86400`.

Startup bundle rules are enforced by `npm run web:bundle-budget` and included in `npm run ci:quality`:

- initial eager JS gzip budget: `160 KiB`;
- individual eager chunk gzip budget: `110 KiB`;
- lazy app chunk gzip budget: `40 KiB`;
- `vendor-sentry-*` must never be eager.

The web app also recovers from stale lazy chunks after a deploy. `main.tsx` listens for Vite preload failures and React chunk-load errors, records them to Sentry when configured, and reloads the page once per build so old open tabs fetch the new `index.html` and changed chunk names.

## Monitoring & Troubleshooting

### Check Service Status

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
```

### Restart Services

```bash
docker compose -f docker-compose.prod.yml restart api
docker compose -f docker-compose.prod.yml down
GIT_SHA=$(cat .last_successful_deployed_sha) docker compose -f docker-compose.prod.yml up -d
```

When a command recreates `api` or `worker`, preserve `GIT_SHA` from `.last_successful_deployed_sha`; otherwise `/api/version` reports `unknown` even though the image is correct.

### Database Connection Issues

```bash
# Test database connection
psql "$DATABASE_URL" -c "SELECT version();"

# Check if migrations were applied
psql "$DATABASE_URL" -c "\dt"

# Full schema readiness check
ENV_FILE=/app/sitelayer/.env scripts/check-db-schema.sh
```

### Check Logs

```bash
# API logs
docker compose -f docker-compose.prod.yml logs api

# Web logs
docker compose -f docker-compose.prod.yml logs web

# Worker logs
docker compose -f docker-compose.prod.yml logs worker
```

## Backup & Recovery

Managed DigitalOcean Postgres includes automatic provider backups with short retention. Keep those as the first recovery path, but add logical backups before pilot data so an accidental cluster deletion, bad migration, or application-level data corruption has an independent restore point.

Full layered strategy, retention, off-host copy details, and the restore drill runbook live in [BACKUP_STRATEGY.md](./BACKUP_STRATEGY.md). The summary below is just the install path.

### Manual Database Backup

```bash
# Create compressed backup
BACKUP_DIR=/app/backups/postgres DATABASE_URL="$DATABASE_URL" scripts/backup-postgres.sh

# Restore from backup
DATABASE_URL="$RESTORE_TARGET_DATABASE_URL" scripts/restore-postgres.sh /app/backups/postgres/sitelayer-YYYYMMDDTHHMMSSZ.sql.gz
```

### Automated Logical Backups + Off-host Copy + Restore Drill

The installers wire up five timers on the production droplet. Verified live on
2026-04-25:

- `sitelayer-postgres-backup.timer` — daily logical pg_dump at 03:17 UTC (30-day retention).
- `sitelayer-postgres-offsite.timer` — rsyncs the latest dump to the preview droplet over the 10.118.0.0/16 private network at 03:32 UTC. Verifies via `sha256sum`, atomic rename, mirrors retention.
- `sitelayer-blueprint-backup.timer` — tars the production `blueprint_storage` Docker volume and rsyncs it to the preview droplet at 03:47 UTC when `ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD=1` is in use. Production normally stores new blueprint objects in Spaces.
- `sitelayer-restore-drill.timer` — weekly (Sunday 04:00 UTC), log at `/var/log/sitelayer/restore-drill.log`. Restores the latest dump into a throwaway `postgres:18-alpine` container and runs sanity queries.
- `sitelayer-timer-monitor.timer` — hourly, checks that the backup/off-host/restore timers are active, recently successful, and not stale. Sends a Sentry event when `SENTRY_DSN` is configured and the check fails.

Install (run on prod droplet, idempotent):

```bash
sudo APP_DIR=/app/sitelayer ENV_FILE=/app/sitelayer/.env \
  BACKUP_DIR=/app/backups/postgres RETENTION_DAYS=30 \
  OFFSITE_HOST=sitelayer@10.118.0.2 \
  OFFSITE_DIR=/app/offsite-backups/postgres-from-prod \
  bash /app/sitelayer/scripts/install-postgres-backup-systemd.sh

sudo APP_DIR=/app/sitelayer ENV_FILE=/app/sitelayer/.env \
  BACKUP_DIR=/app/backups/blueprints RETENTION_DAYS=30 \
  OFFSITE_HOST=sitelayer@10.118.0.2 \
  OFFSITE_DIR=/app/offsite-backups/blueprints-from-prod \
  bash /app/sitelayer/scripts/install-blueprint-backup-systemd.sh

sudo APP_DIR=/app/sitelayer ENV_FILE=/app/sitelayer/.env \
  bash /app/sitelayer/scripts/install-timer-monitor-systemd.sh
```

Useful checks:

```bash
systemctl list-timers \
  sitelayer-postgres-backup.timer \
  sitelayer-postgres-offsite.timer \
  sitelayer-blueprint-backup.timer \
  sitelayer-restore-drill.timer \
  sitelayer-timer-monitor.timer
systemctl status sitelayer-postgres-backup.service sitelayer-postgres-offsite.service sitelayer-blueprint-backup.service sitelayer-timer-monitor.service
ls -lh /app/backups/postgres
ssh sitelayer@10.118.0.2 ls -lh /app/offsite-backups/postgres-from-prod
ssh sitelayer@10.118.0.2 ls -lh /app/offsite-backups/blueprints-from-prod
tail -50 /var/log/sitelayer/restore-drill.log
```

Monthly manual drill (regardless of weekly timer):

```bash
bash /app/sitelayer/scripts/restore-drill.sh
```

### Container Log Rotation

`docker-compose.prod.yml` configures a per-service `logging` block:

```yaml
logging:
  driver: json-file
  options:
    max-size: '20m'
    max-file: '5'
```

Total cap per service: ~100 MB rolling. Applies to `api`, `web`, `worker`, and `caddy`. Without this, Docker's default `json-file` driver keeps a single unbounded log file under `/var/lib/docker/containers/*/*-json.log`, which on a long-running prod droplet eventually fills `/dev/vda1` (78G). After deploying this change, restart the stack so existing containers pick up the new logging config:

```bash
cd /app/sitelayer
GIT_SHA=$(cat .last_successful_deployed_sha) docker compose -f docker-compose.prod.yml up -d --force-recreate
```

(Docker only re-reads `logging` on container creation, not on simple restart.)

## Post-Deployment Checklist

- [ ] SSL certificate installed and auto-renewal configured
- [x] Database schema applied successfully
- [x] API responding on health check endpoint
- [x] Frontend loading without errors
- [ ] QBO integration credentials configured
- [x] Clerk authentication working
- [x] DO Spaces credentials configured
- [x] Local blueprint storage volume configured as fallback
- [x] Backup strategy in place
- [x] Monitoring/alerts baseline configured; final on-call routing still pending
- [x] DNS pointing to reserved IP

## Next Steps

1. Validate QBO sandbox and production credentials.
2. Provision the first pilot company and memberships.
3. Wire Sentry/timer-monitor events to the final on-call destination.
4. Keep `npm run web:bundle-budget` green before every deploy.
