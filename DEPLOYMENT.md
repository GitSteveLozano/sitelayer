# Sitelayer Deployment Guide

## Overview

Sitelayer is deployed to a DigitalOcean Droplet using Docker Compose. The GitHub Actions workflow automatically deploys production on push to `main`.

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

Create `/app/sitelayer/.env` owned by the `sitelayer` user. `DATABASE_URL` is the only hard requirement for the stack to render; leave optional integration values blank until those services are provisioned.

```bash
cat > /app/sitelayer/.env << 'EOF'
# Database (managed DigitalOcean PostgreSQL)
DATABASE_URL=postgresql://user:password@host:25060/defaultdb?sslmode=require
# DO managed Postgres until a CA bundle is configured.
DATABASE_SSL_REJECT_UNAUTHORIZED=false

# API Configuration
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

# Clerk Authentication (optional until Clerk is provisioned)
CLERK_SECRET_KEY=

# DigitalOcean Spaces (optional until file storage is provisioned)
DO_SPACES_KEY=
DO_SPACES_SECRET=
DO_SPACES_BUCKET=sitelayer-blueprints-prod
DO_SPACES_REGION=tor1

# Local durable blueprint storage fallback.
# docker-compose.prod.yml persists this path in the blueprint_storage volume.
BLUEPRINT_STORAGE_ROOT=/app/storage/blueprints

# Frontend
VITE_API_URL=
VITE_COMPANY_SLUG=la-operations
VITE_USER_ID=demo-user

# Optional: Error Tracking
SENTRY_DSN=
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
source .env
psql "$DATABASE_URL" < docker/postgres/init/001_schema.sql
```

For ongoing deploys, use the repo migration runner instead of calling SQL files
manually:

```bash
cd /app/sitelayer
ENV_FILE=/app/sitelayer/.env scripts/migrate-db.sh
ENV_FILE=/app/sitelayer/.env scripts/check-db-schema.sh
```

The production GitHub Actions deploy runs both commands before rebuilding the
containers. The SQL files are currently idempotent; review this before adding
any destructive migration. Keep seed data guarded by `NOT EXISTS` checks unless
a real unique constraint exists.

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
docker compose -f docker-compose.prod.yml up -d
```

Or via GitHub Actions (automatic on push to `main`).

## GitHub Actions Deployment

### 1. Configure GitHub Secrets

Add the following secrets to your GitHub repository settings:

- `DEPLOY_HOST`: Droplet IP or domain (e.g., `165.245.231.199` or `sitelayer.example.com`)
- `DEPLOY_SSH_KEY`: Private SSH key content from `~/.ssh/sitelayer_deploy` (the deployment user's key)

The workflow uses the `sitelayer` deployment user and does not expose the root SSH key. Because the user can access Docker, the deployment key is still root-equivalent and must be protected accordingly.

### 2. Trigger Deployment

Push to `main` to trigger automatic production deployment:

```bash
git push origin main
```

The GitHub Actions workflow will:
1. Check out the code
2. SSH into the droplet
3. Pull latest changes from GitHub
4. Run `scripts/migrate-db.sh`
5. Run `scripts/check-db-schema.sh`
6. Validate Compose config
7. Build Docker images
8. Start services with `docker compose up -d --remove-orphans`
9. Verify public HTTPS health locally through Caddy

## Tier Isolation

Sitelayer runs in one of four tiers, declared explicitly via `APP_TIER`:

| Tier | DB (DigitalOcean managed Postgres) | Spaces bucket | Purpose |
|------|-----------------------------------|---------------|---------|
| `local` | `postgres` in `docker-compose.yml` | MinIO (TBD) | Laptop-only development |
| `dev` | `sitelayer_dev` | `sitelayer-blueprints-dev` (TBD) | Shared sandbox; Claude Desktop / MCP agents |
| `preview` | `sitelayer_preview` | `sitelayer-blueprints-preview` (TBD) | Per-PR stacks, non-technical demos |
| `prod` | `sitelayer_prod` | `sitelayer-blueprints-prod` | Real customers only |

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

**Queue processing.** The API and worker use Postgres-backed queue tables instead of an external Redis dependency. `mutation_outbox` and `sync_events` are claimed with a short processing lease, using `FOR UPDATE SKIP LOCKED`, then marked `applied`. The shared SQL/transaction implementation lives in `packages/queue` and is covered by unit tests so API-triggered sync and the worker cannot drift. This is still a local/simulated processor until live QBO sync is enabled, but it prevents multiple workers from processing the same row and leaves retry metadata (`attempt_count`, `next_attempt_at`, `error`) for the real connector.

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `APP_TIER` | ✅ in prod | `local`\|`dev`\|`preview`\|`prod`. Startup guard refuses to boot on mismatch. |
| `FEATURE_FLAGS` | ❌ | Comma-separated. See Tier Isolation above. |
| `DATABASE_URL` | ✅ | PostgreSQL connection string (use managed database) |
| `DATABASE_URL_PROD_RO` | ❌ | Read-only prod pool for `read-prod-ro` flag; user must be `_ro`/readonly role. |
| `PORT` | ❌ | API port; Compose sets `3001` |
| `NODE_ENV` | ❌ | Compose sets `production` |
| `QBO_CLIENT_ID` | ❌ | QuickBooks Online client ID; defaults to demo placeholders until configured |
| `QBO_CLIENT_SECRET` | ❌ | QuickBooks Online client secret; defaults to demo placeholders until configured |
| `QBO_REDIRECT_URI` | ❌ | OAuth redirect URI for QBO |
| `QBO_SUCCESS_REDIRECT_URI` | ❌ | UI redirect after QBO OAuth success |
| `QBO_STATE_SECRET` | ❌ | Secret used to sign QBO OAuth state |
| `CLERK_SECRET_KEY` | ❌ | Clerk authentication secret |
| `DO_SPACES_KEY` | ❌ | DigitalOcean Spaces API key |
| `DO_SPACES_SECRET` | ❌ | DigitalOcean Spaces API secret |
| `BLUEPRINT_STORAGE_ROOT` | ❌ | Local filesystem blueprint storage path; production Compose persists `/app/storage/blueprints` in a named Docker volume |
| `SENTRY_DSN` | ❌ | Sentry error tracking URL |
| `ALLOWED_ORIGINS` | ❌ | CORS allowed origins (comma-separated) |

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
docker compose -f docker-compose.prod.yml up -d
```

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

### Manual Database Backup

```bash
# Create compressed backup
BACKUP_DIR=/app/backups/postgres DATABASE_URL="$DATABASE_URL" scripts/backup-postgres.sh

# Restore from backup
DATABASE_URL="$RESTORE_TARGET_DATABASE_URL" scripts/restore-postgres.sh /app/backups/postgres/sitelayer-YYYYMMDDTHHMMSSZ.sql.gz
```

### Automated Logical Backups

Install a daily local logical backup timer on the production droplet after `/app/sitelayer/.env` exists:

```bash
sudo APP_DIR=/app/sitelayer ENV_FILE=/app/sitelayer/.env BACKUP_DIR=/app/backups/postgres RETENTION_DAYS=30 \
  bash /app/sitelayer/scripts/install-postgres-backup-systemd.sh
```

Useful checks:

```bash
systemctl list-timers sitelayer-postgres-backup.timer
systemctl status sitelayer-postgres-backup.service
ls -lh /app/backups/postgres
```

## Post-Deployment Checklist

- [ ] SSL certificate installed and auto-renewal configured
- [ ] Database schema applied successfully
- [ ] API responding on health check endpoint
- [ ] Frontend loading without errors
- [ ] QBO integration credentials configured
- [ ] Clerk authentication working
- [ ] DO Spaces credentials configured
- [x] Local blueprint storage volume configured
- [ ] Backup strategy in place
- [ ] Monitoring/alerts configured
- [ ] DNS pointing to reserved IP

## Next Steps

1. Configure your domain DNS to point to the droplet IP
2. Obtain real credentials for QBO, Clerk, Sentry
3. Set up automated backups
4. Configure monitoring and alerts
5. Create deployment runbooks for common operations
