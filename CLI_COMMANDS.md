# Sitelayer Deployment CLI Commands

> **Canonical deploy path is GitHub Actions** (`.github/workflows/deploy-droplet.yml`, triggered by push to `main`). The commands below are the manual fallback / bootstrap reference. Live infrastructure values (droplet IP, DB IDs, bucket names) come from `INFRASTRUCTURE_READY.md`.

Quick reference for all command-line operations needed to deploy and manage Sitelayer on DigitalOcean.

## Droplet Access

### SSH as root (initial setup only)

```bash
ssh -i ~/.ssh/id_rsa root@sitelayer.sandolab.xyz
```

Or if you've configured a domain:

```bash
ssh -i ~/.ssh/id_rsa root@sitelayer.example.com
```

### SSH as sitelayer user (after setup)

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz
```

## Initial Droplet Setup (as root)

### 1. Update system and install tools

```bash
apt-get update && apt-get upgrade -y
curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh
apt-get install -y git curl postgresql-client
docker compose version  # Verify installation
```

### 2. Create deployment user

Run the setup script:

```bash
# Copy script to droplet first (from your local machine)
scp -i ~/.ssh/id_rsa scripts/setup-deploy-user.sh root@sitelayer.sandolab.xyz:/tmp/

# Then SSH as root and run it
ssh -i ~/.ssh/id_rsa root@sitelayer.sandolab.xyz 'bash /tmp/setup-deploy-user.sh'
```

Or manually:

```bash
useradd --create-home --shell /bin/bash --user-group sitelayer
usermod -aG docker sitelayer
mkdir -p /app/sitelayer
chown -R sitelayer:sitelayer /app/sitelayer
mkdir -p /home/sitelayer/.ssh
touch /home/sitelayer/.ssh/authorized_keys
chown -R sitelayer:sitelayer /home/sitelayer/.ssh
chmod 700 /home/sitelayer/.ssh
chmod 600 /home/sitelayer/.ssh/authorized_keys
```

### 3. Add sitelayer SSH key to authorized_keys (as root)

```bash
# From your local machine
cat ~/.ssh/sitelayer_deploy.pub | ssh -i ~/.ssh/id_rsa root@sitelayer.sandolab.xyz \
  'cat >> /home/sitelayer/.ssh/authorized_keys && chmod 600 /home/sitelayer/.ssh/authorized_keys'
```

## Configuration (as sitelayer user)

### 1. Clone repository

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
git clone https://github.com/GitSteveLozano/sitelayer.git .
EOF
```

### 2. Create .env file

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz 'cat > /app/sitelayer/.env' << 'EOF'
APP_TIER=prod
DATABASE_URL=postgresql://sitelayer_prod_app:...@host:25060/sitelayer_prod?sslmode=require
PORT=3001
NODE_ENV=production
# Auth — header fallback only kept on while Clerk is being rolled out
ACTIVE_COMPANY_SLUG=la-operations
ACTIVE_USER_ID=demo-user
AUTH_ALLOW_HEADER_FALLBACK=
# CLERK_JWT_KEY=<PEM public key from Clerk dashboard → JWT Public Key>
# CLERK_ISSUER=https://clerk.sandolab.xyz
# CLERK_WEBHOOK_SECRET=<svix whsec_… from Clerk dashboard → Webhooks>
# QBO
QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
QBO_REDIRECT_URI=https://sitelayer.sandolab.xyz/api/integrations/qbo/callback
QBO_SUCCESS_REDIRECT_URI=https://sitelayer.sandolab.xyz/?qbo=connected
QBO_ENVIRONMENT=production
QBO_STATE_SECRET=
# Blueprint storage — prod requires scoped Spaces credentials.
BLUEPRINT_STORAGE_ROOT=/app/storage/blueprints
DO_SPACES_KEY=<scoped-readwrite-key>
DO_SPACES_SECRET=<scoped-readwrite-secret>
DO_SPACES_BUCKET=sitelayer-blueprints-prod
DO_SPACES_REGION=tor1
DO_SPACES_ENDPOINT=https://tor1.digitaloceanspaces.com
# Frontend VITE_* values are build-time Docker args in deploy-droplet.yml.
# Editing this runtime .env after deploy will not change the browser bundle.
# Observability
SENTRY_DSN=
SENTRY_WORKER_DSN=
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.1
# VITE_SENTRY_DSN / VITE_SENTRY_ENVIRONMENT are build-time only.
DEBUG_TRACE_TOKEN=<generate-32b-random>
API_METRICS_TOKEN=<generate-32b-random>
ALLOWED_ORIGINS=https://sitelayer.sandolab.xyz
EOF
```

### 3. Initialize database

Use the migration runner — it applies every file in `docker/postgres/init/` in order, records checksums in `schema_migrations`, and skips already-applied files. Don't `psql < 001_schema.sql` directly (skips later migrations and the ledger).

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
ENV_FILE=/app/sitelayer/.env PSQL_DOCKER_IMAGE=postgres:18-alpine \
  scripts/migrate-db.sh
ENV_FILE=/app/sitelayer/.env PSQL_DOCKER_IMAGE=postgres:18-alpine \
  scripts/check-db-schema.sh
EOF
```

### 4. Start services

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
GIT_SHA=$(cat .last_successful_deployed_sha 2>/dev/null || git rev-parse --short HEAD) \
  docker compose -f docker-compose.prod.yml up -d
sleep 2
docker compose -f docker-compose.prod.yml ps
EOF
```

## Management Commands (as sitelayer user)

### Service status

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml ps'
```

### View logs

```bash
# All services
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml logs -f'

# Specific service
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml logs -f api'
```

### Restart service

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml restart api'
```

### Stop all services

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml down'
```

### Pull current immutable image and restart

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
GIT_SHA=$(git rev-parse --short HEAD)
APP_IMAGE=registry.digitalocean.com/sitelayer/sitelayer:$GIT_SHA
(grep -q '^APP_IMAGE=' .env && sed -i "s|^APP_IMAGE=.*|APP_IMAGE=$APP_IMAGE|" .env || printf '\nAPP_IMAGE=%s\n' "$APP_IMAGE" >> .env)
APP_IMAGE=$APP_IMAGE docker compose -f docker-compose.prod.yml pull api web worker
GIT_SHA=$GIT_SHA APP_IMAGE=$APP_IMAGE docker compose -f docker-compose.prod.yml up -d --remove-orphans
EOF
```

## Database Management

### Test connection

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
source .env
psql "$DATABASE_URL" -c "SELECT version();"
EOF
```

### List tables

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
source .env
psql "$DATABASE_URL" -c "\dt"
EOF
```

### Backup database

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
source .env
pg_dump "$DATABASE_URL" > sitelayer_backup_$(date +%Y%m%d_%H%M%S).sql
ls -lh *.sql
EOF
```

### Restore database

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
source .env
psql "$DATABASE_URL" < sitelayer_backup_20240101_120000.sql
EOF
```

## GitHub Actions Secrets

Configure these in your GitHub repository at: Settings → Secrets and variables → Actions

### Secret names and values

```bash
# Set DEPLOY_HOST (droplet IP or domain)
DEPLOY_HOST=sitelayer.sandolab.xyz

# Set DEPLOY_SSH_KEY (your private key)
DEPLOY_SSH_KEY=$(cat ~/.ssh/sitelayer_deploy)

# Set DIGITALOCEAN_ACCESS_TOKEN (registry push/pull + doctl deploy automation)
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_...
```

In GitHub UI:

1. Go to repository Settings
2. Click "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. Add `DEPLOY_HOST` = prod droplet private VPC IP from preview runner, or public/reserved IP if firewall allows it
5. Add `DEPLOY_SSH_KEY` = contents of `~/.ssh/sitelayer_deploy` file
6. Add `DIGITALOCEAN_ACCESS_TOKEN` = DO token used by deploy automation

## Health Checks

### Check API health

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz \
  'curl --resolve sitelayer.sandolab.xyz:443:127.0.0.1 -fsS https://sitelayer.sandolab.xyz/health'
```

### Check all services running

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
docker compose -f docker-compose.prod.yml ps
echo "---"
curl --resolve sitelayer.sandolab.xyz:443:127.0.0.1 -fsS https://sitelayer.sandolab.xyz/health && echo "API healthy"
EOF
```

## Troubleshooting

### SSH key permissions

```bash
# Ensure private key has correct permissions (local machine)
chmod 600 ~/.ssh/sitelayer_deploy
chmod 600 ~/.ssh/id_rsa

# Verify on droplet
ssh -i ~/.ssh/id_rsa root@sitelayer.sandolab.xyz 'ls -la /home/sitelayer/.ssh/'
```

### Docker daemon issues

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
docker ps  # Should work without sudo (sitelayer in docker group)
docker compose version
EOF
```

### Port conflicts

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz \
  'ss -tlnp | grep -E "(3000|3001|80|443)"'
```

### Clear Docker resources

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
docker compose -f docker-compose.prod.yml down --remove-orphans
docker system prune -f
EOF
```

## Quick Deploy Reference

Fastest way to deploy after initial setup:

```bash
# 1. Push to main
git push origin main

# 2. GitHub Actions runs automatically
# 3. Monitor in GitHub Actions tab
# 4. Or manually trigger:

# Manual fallback should mirror deploy-droplet.yml: use an already-built
# immutable image, pull before DB work, take backup, migrate/check, start, verify.
ssh -i ~/.ssh/sitelayer_deploy sitelayer@sitelayer.sandolab.xyz << 'EOF'
cd /app/sitelayer
GIT_SHA=$(git rev-parse --short HEAD)
APP_IMAGE=registry.digitalocean.com/sitelayer/sitelayer:$GIT_SHA
(grep -q '^APP_IMAGE=' .env && sed -i "s|^APP_IMAGE=.*|APP_IMAGE=$APP_IMAGE|" .env || printf '\nAPP_IMAGE=%s\n' "$APP_IMAGE" >> .env)
APP_IMAGE=$APP_IMAGE docker compose -f docker-compose.prod.yml pull api web worker
BACKUP_DIR=/app/backups/postgres DATABASE_URL_FILE=/app/sitelayer/.env PG_DUMP_DOCKER_IMAGE=postgres:18-alpine scripts/backup-postgres.sh
PSQL_DOCKER_IMAGE=postgres:18-alpine scripts/migrate-db.sh
PSQL_DOCKER_IMAGE=postgres:18-alpine scripts/check-db-schema.sh
GIT_SHA=$GIT_SHA APP_IMAGE=$APP_IMAGE docker compose -f docker-compose.prod.yml up -d --remove-orphans
EXPECTED_SHA=$GIT_SHA scripts/verify-prod-deploy.sh
EOF
```

## Environment Variables (for reference)

Keep these values secure. Only DATABASE_URL is required to start:

```bash
# Required
APP_TIER             # local|dev|preview|prod — startup guard cross-checks DATABASE_URL and DO_SPACES_BUCKET
DATABASE_URL         # tier-specific role: sitelayer_{prod,preview,dev}_app
PORT                 # default 3001

# Auth (Clerk integration; see apps/api/src/auth.ts)
CLERK_JWT_KEY        # PEM public key from Clerk dashboard
CLERK_ISSUER         # e.g. https://clerk.sandolab.xyz
CLERK_WEBHOOK_SECRET # Svix whsec_... for /api/webhooks/clerk
AUTH_ALLOW_HEADER_FALLBACK # leave empty in prod once Clerk JWT is enforced
ACTIVE_COMPANY_SLUG  # demo fallback only when CLERK_JWT_KEY unset
ACTIVE_USER_ID       # demo fallback only when CLERK_JWT_KEY unset

# QBO
QBO_CLIENT_ID
QBO_CLIENT_SECRET
QBO_REDIRECT_URI
QBO_SUCCESS_REDIRECT_URI
QBO_ENVIRONMENT      # sandbox|production
QBO_STATE_SECRET     # HMAC nonce signing for OAuth state

# Blueprint storage (S3 mode auto-selected when all three Spaces vars are set)
BLUEPRINT_STORAGE_ROOT   # e.g. /app/storage/blueprints
DO_SPACES_BUCKET         # tier-specific: sitelayer-blueprints-{dev,preview,prod}
DO_SPACES_REGION         # tor1
DO_SPACES_ENDPOINT       # https://tor1.digitaloceanspaces.com
DO_SPACES_KEY
DO_SPACES_SECRET

# Observability
SENTRY_DSN
SENTRY_WORKER_DSN       # optional; worker falls back to SENTRY_DSN
SENTRY_ENVIRONMENT      # runtime api/worker label
SENTRY_TRACES_SAMPLE_RATE
VITE_SENTRY_DSN         # build-time only
VITE_SENTRY_ENVIRONMENT # build-time only
DEBUG_TRACE_TOKEN        # bearer for /api/debug/traces/:traceId
API_METRICS_TOKEN        # bearer for /api/metrics

# Feature flags
FEATURE_FLAGS            # comma-separated subset of: read-prod-ro, qbo-live, pdf-ocr-experimental
DATABASE_URL_PROD_RO     # required when FEATURE_FLAGS includes read-prod-ro
```
