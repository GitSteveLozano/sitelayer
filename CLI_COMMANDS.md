# Sitelayer Deployment CLI Commands

Quick reference for all command-line operations needed to deploy and manage Sitelayer on DigitalOcean.

## Droplet Access

### SSH as root (initial setup only)

```bash
ssh -i ~/.ssh/id_rsa root@165.245.231.199
```

Or if you've configured a domain:

```bash
ssh -i ~/.ssh/id_rsa root@sitelayer.example.com
```

### SSH as sitelayer user (after setup)

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199
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
scp -i ~/.ssh/id_rsa scripts/setup-deploy-user.sh root@165.245.231.199:/tmp/

# Then SSH as root and run it
ssh -i ~/.ssh/id_rsa root@165.245.231.199 'bash /tmp/setup-deploy-user.sh'
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
cat ~/.ssh/sitelayer_deploy.pub | ssh -i ~/.ssh/id_rsa root@165.245.231.199 \
  'cat >> /home/sitelayer/.ssh/authorized_keys && chmod 600 /home/sitelayer/.ssh/authorized_keys'
```

## Configuration (as sitelayer user)

### 1. Clone repository

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
git clone https://github.com/GitSteveLozano/sitelayer.git .
EOF
```

### 2. Create .env file

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 'cat > /app/sitelayer/.env' << 'EOF'
DATABASE_URL=postgresql://user:password@host:25060/defaultdb?sslmode=require
PORT=3001
NODE_ENV=production
ACTIVE_COMPANY_SLUG=la-operations
ACTIVE_USER_ID=demo-user
QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
QBO_REDIRECT_URI=https://your-domain.com/api/integrations/qbo/callback
QBO_SUCCESS_REDIRECT_URI=https://your-domain.com/?qbo=connected
QBO_ENVIRONMENT=production
QBO_STATE_SECRET=
CLERK_SECRET_KEY=
DO_SPACES_KEY=
DO_SPACES_SECRET=
DO_SPACES_BUCKET=sitelayer-blueprints
DO_SPACES_REGION=nyc3
VITE_API_URL=https://your-domain.com
VITE_COMPANY_SLUG=la-operations
VITE_USER_ID=demo-user
SENTRY_DSN=
VITE_SENTRY_DSN=
VITE_SENTRY_ENVIRONMENT=production
ALLOWED_ORIGINS=https://your-domain.com
EOF
```

### 3. Initialize database

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
source .env
psql "$DATABASE_URL" < docker/postgres/init/001_schema.sql
psql "$DATABASE_URL" -c "SELECT version();"  # Verify connection
EOF
```

### 4. Start services

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
docker compose -f docker-compose.prod.yml up -d
sleep 2
docker compose -f docker-compose.prod.yml ps
EOF
```

## Management Commands (as sitelayer user)

### Service status

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml ps'
```

### View logs

```bash
# All services
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml logs -f'

# Specific service
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml logs -f api'
```

### Restart service

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml restart api'
```

### Stop all services

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 \
  'cd /app/sitelayer && docker compose -f docker-compose.prod.yml down'
```

### Rebuild and restart

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml build --pull
docker compose -f docker-compose.prod.yml up -d
EOF
```

## Database Management

### Test connection

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
source .env
psql "$DATABASE_URL" -c "SELECT version();"
EOF
```

### List tables

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
source .env
psql "$DATABASE_URL" -c "\dt"
EOF
```

### Backup database

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
source .env
pg_dump "$DATABASE_URL" > sitelayer_backup_$(date +%Y%m%d_%H%M%S).sql
ls -lh *.sql
EOF
```

### Restore database

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
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
DEPLOY_HOST=165.245.231.199

# Set DEPLOY_SSH_KEY (your private key)
DEPLOY_SSH_KEY=$(cat ~/.ssh/sitelayer_deploy)
```

In GitHub UI:

1. Go to repository Settings
2. Click "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. Add `DEPLOY_HOST` = your droplet IP/domain
5. Add `DEPLOY_SSH_KEY` = contents of `~/.ssh/sitelayer_deploy` file

## Health Checks

### Check API health

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 \
  'curl -s http://127.0.0.1:3001/health'
```

### Check all services running

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
docker compose -f docker-compose.prod.yml ps
echo "---"
curl -s http://127.0.0.1:3001/health && echo "✓ API healthy"
EOF
```

## Troubleshooting

### SSH key permissions

```bash
# Ensure private key has correct permissions (local machine)
chmod 600 ~/.ssh/sitelayer_deploy
chmod 600 ~/.ssh/id_rsa

# Verify on droplet
ssh -i ~/.ssh/id_rsa root@165.245.231.199 'ls -la /home/sitelayer/.ssh/'
```

### Docker daemon issues

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
docker ps  # Should work without sudo (sitelayer in docker group)
docker compose version
EOF
```

### Port conflicts

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 \
  'ss -tlnp | grep -E "(3000|3001|80|443)"'
```

### Clear Docker resources

```bash
ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
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

ssh -i ~/.ssh/sitelayer_deploy sitelayer@165.245.231.199 << 'EOF'
cd /app/sitelayer
git fetch origin
git checkout -B main origin/main
git reset --hard origin/main
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
EOF
```

## Environment Variables (for reference)

Keep these values secure. Only DATABASE_URL is required to start:

```bash
# Required
DATABASE_URL=postgresql://...

# Optional (service integrations)
QBO_CLIENT_ID
QBO_CLIENT_SECRET
QBO_REDIRECT_URI
QBO_SUCCESS_REDIRECT_URI
QBO_ENVIRONMENT
QBO_STATE_SECRET
CLERK_SECRET_KEY
DO_SPACES_KEY
DO_SPACES_SECRET
SENTRY_DSN
```
