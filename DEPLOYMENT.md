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
DO_SPACES_BUCKET=sitelayer-blueprints
DO_SPACES_REGION=nyc3

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
4. Validate Compose config
5. Build Docker images
6. Start services with `docker compose up -d --remove-orphans`
7. Verify API health on `127.0.0.1:3001/health`

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (use managed database) |
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
- [ ] Backup strategy in place
- [ ] Monitoring/alerts configured
- [ ] DNS pointing to reserved IP

## Next Steps

1. Configure your domain DNS to point to the droplet IP
2. Obtain real credentials for QBO, Clerk, Sentry
3. Set up automated backups
4. Configure monitoring and alerts
5. Create deployment runbooks for common operations
