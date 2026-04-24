# Sitelayer Infrastructure Ready

**Date:** 2026-04-23  
**Status:** Live DigitalOcean state reconciled; preview deploy path smoke-tested; secrets redacted from repo

This document is infrastructure inventory only. Deployment procedure lives in `DEPLOYMENT.md`. Planning/runtime state must also be mirrored into Mesh under project `sitelayer`.

---

## Infrastructure Details

### Droplet
- **ID:** 566798325
- **Name:** sitelayer
- **Region:** Toronto (tor1)
- **Size:** 4 vCPU, 8GB RAM (s-4vcpu-8gb)
- **Image:** Ubuntu 22.04
- **Public IP:** 165.245.230.3
- **Reserved IP:** 159.203.51.158 (assigned)
- **SSH Key:** Configured (key ID 2238080)
- **Cost:** ~$48/mo

### Preview Droplet
- **ID:** 566806040
- **Name:** sitelayer-preview
- **Region:** Toronto (tor1)
- **Size:** 2 vCPU, 4GB RAM (s-2vcpu-4gb)
- **Image:** Ubuntu 22.04
- **Public IP:** 137.184.169.208
- **Private IP:** 10.118.0.2
- **Reserved IP:** 159.203.53.218 (assigned)
- **SSH Key:** Configured (key ID 2238080)
- **Cost:** $24/mo
- **Purpose:** branch/PR preview environments only; no production secrets or production database access.
- **Router:** Traefik v3 on Docker network `sitelayer-preview-router`
- **Shared env:** `/app/previews/.env.shared`, owner `sitelayer:sitelayer`, mode `600`
- **GitHub runner:** `sitelayer-preview`, active systemd service `actions.runner.GitSteveLozano-sitelayer.sitelayer-preview.service`
- **Preview cleanup:** `sitelayer-preview-prune.timer`, daily TTL cleanup
- **Smoke preview:** `https://main.preview.sitelayer.sandolab.xyz`

### Database
- **ID:** 9948c96b-b6b6-45ad-adf7-d20e4c206c66
- **Name:** sitelayer-db
- **Engine:** PostgreSQL 18
- **Size:** 1 vCPU, 1GB RAM, 10GB Storage
- **Region:** Toronto (tor1)
- **Status:** Online
- **Databases:** `defaultdb`, `sitelayer_preview` as of 2026-04-23. Create `sitelayer_prod` and `sitelayer_dev` with separate app users before splitting production and dev deploys.
- **Preview user:** `sitelayer_preview_app` for `sitelayer_preview`
- **Connection String:** stored outside git in the project secret store / deployment environment.
- **Security note:** a live database URL was previously committed here. Rotate that credential before any production or pilot use.
- **Cost:** $15.15/mo
- **Backup status:** DigitalOcean managed backups are available. Independent logical backup scripts exist in `scripts/backup-postgres.sh`, but the production backup timer is not installed until `/app/sitelayer/.env` exists.

### Firewall
- **ID:** 63b5d4f6-0949-4658-ba91-48e119c53ee3
- **Name:** sitelayer-tor
- **Rules:** HTTP (80), HTTPS (443), SSH (22), API (3000)
- **Status:** Active
- **Follow-up:** port 3000 is no longer required by committed production Compose, which exposes only port 80. Close public 3000 after confirming no temporary service depends on it.

### Preview Firewall
- **ID:** 7a8f443e-cd74-4867-af8a-118559f33561
- **Name:** sitelayer-preview
- **Rules:** SSH (22) from `50.71.113.46/32`, HTTP (80), HTTPS (443)
- **Outbound:** TCP/UDP egress plus ICMP egress to `0.0.0.0/0`
- **Status:** Active
- **Security note:** no public 3000/3001/etc. Preview app traffic should enter through Traefik on 80/443 only.

---

## DNS Configuration (Cloudflare)

Add an A record to your Cloudflare zone (sandolab.xyz):

| Type | Name      | Content       | Proxied |
|------|-----------|---------------|---------|
| A    | sitelayer | 159.203.51.158 | No      |

⚠️ **Important:** Keep proxied = No (gray cloud) so Let's Encrypt certificate validation works.

For preview deployments, add records under the main site hostname:

| Type | Cloudflare Name       | Full Hostname                         | Content        | Proxied |
|------|------------------------|---------------------------------------|----------------|---------|
| A    | preview.sitelayer      | preview.sitelayer.sandolab.xyz       | 159.203.53.218 | No      |
| A    | *.preview.sitelayer    | *.preview.sitelayer.sandolab.xyz     | 159.203.53.218 | No      |

Keep preview records DNS-only initially. Traefik can request per-preview certificates through HTTP-01. If you later want orange-cloud proxying, switch after origin TLS is working and Cloudflare SSL mode is set deliberately.

After DNS propagates (usually ~5 min):
```bash
dig sitelayer.sandolab.xyz  # Should resolve to 159.203.51.158
```

---

## Environment Variables

Save this to `/app/sitelayer/.env` on the Droplet, owned by the `sitelayer` deployment user with mode `600`:

```bash
# Database
DATABASE_URL=<set-in-deployment-environment>
# For DO managed Postgres sslmode=require until a CA bundle is configured.
DATABASE_SSL_REJECT_UNAUTHORIZED=false

# DigitalOcean Spaces (optional until storage is provisioned)
DO_SPACES_ENDPOINT=https://sitelayer.tor1.digitaloceanspaces.com
DO_SPACES_KEY=
DO_SPACES_SECRET=

# Clerk (optional until auth is provisioned)
CLERK_SECRET_KEY=

# Intuit QBO (optional until OAuth credentials are ready)
QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
QBO_REDIRECT_URI=https://sitelayer.sandolab.xyz/api/integrations/qbo/callback
QBO_SUCCESS_REDIRECT_URI=https://sitelayer.sandolab.xyz/?qbo=connected
QBO_ENVIRONMENT=sandbox
QBO_STATE_SECRET=

# Sentry (optional)
SENTRY_DSN=
VITE_SENTRY_DSN=

# Domain
DOMAIN=sitelayer.sandolab.xyz
```

---

## Manual Setup Required (9 minutes via UI)

### 1. Create DO Spaces Bucket (2 min)
1. Go to https://cloud.digitalocean.com/spaces
2. Click **Create Spaces Bucket**
3. Name: `sitelayer`
4. Region: Toronto (tor1)
5. Click Create
6. Go to **Settings** → **API Keys** (tab)
7. Click **Generate New Key**
8. Copy the key and secret to your `.env`

### 2. Create Clerk Organization (2 min)
1. Go to https://dashboard.clerk.com
2. Create app (if not done): choose "Google OAuth + Email"
3. Go to **JWT Templates** tab
4. Create new template with claims:
   ```json
   {
     "org_slug": "{{org.slug}}"
   }
   ```
5. Copy Secret Key and Publishable Key to `.env`

### 3. Create Intuit QBO App (2 min)
1. Go to https://developer.intuit.com
2. Create app, choose "QuickBooks Online"
3. Copy Client ID and Secret to `.env`
4. Development redirect URI: `http://localhost:3001/api/integrations/qbo/callback`
5. Production redirect URI, after deployment exists: `https://sitelayer.sandolab.xyz/api/integrations/qbo/callback`

### 4. Create Sentry Projects (2 min)
1. Go to https://sentry.io
2. Create project → Node.js for backend
3. Create project → React for frontend
4. Copy DSNs to `.env`

### 5. UptimeRobot Monitors (optional, 1 min)
1. Go to https://uptimerobot.com
2. Add monitor: `https://sitelayer.sandolab.xyz`
3. Add monitor: `https://sitelayer.sandolab.xyz/api/bootstrap`

---

## SSH Access

```bash
# SSH to Droplet with key (replace key path)
ssh -i ~/.ssh/id_rsa ubuntu@159.203.51.158

# Or use DO SSH console from dashboard
```

Once connected:
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker and support tools
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo apt install -y git curl postgresql-client

# Run scripts/setup-deploy-user.sh from the repo as root, then create:
sudo nano /app/sitelayer/.env
```

---

## Next Steps

1. **Create `/app/sitelayer/.env`** with at least `DATABASE_URL`.
2. **Deploy app to Droplet** using `.github/workflows/deploy-droplet.yml` or `DEPLOYMENT.md`.
3. **Apply database schema:**
   ```bash
   psql $DATABASE_URL < docker/postgres/init/001_schema.sql
   ```
4. **Provision optional services** (Clerk, Spaces, QBO, Sentry) when ready.
5. **Add TLS** after DNS and certs are ready; committed nginx is currently HTTP-only.
6. **Verify at:** http://sitelayer.sandolab.xyz or reserved IP until TLS is enabled.

Preview has been verified at:

```bash
curl https://main.preview.sitelayer.sandolab.xyz/health
curl https://main.preview.sitelayer.sandolab.xyz/api/bootstrap
```

---

## Cost Summary (Month 1)

| Service      | Cost   |
|--------------|--------|
| Droplet      | $48.00 |
| Database     | $15.15 |
| Reserved IP  | $3.60  |
| Spaces       | $5.00  |
| Domain       | $0.83  |
| **Total**    | **$72.58** |

*(Plus free tier: Clerk, Sentry, UptimeRobot, Intuit)*

---

## Troubleshooting

**Droplet not accessible:**
- Check firewall rules in DO console
- Verify DNS record in Cloudflare

**Database connection fails:**
- Ensure firewall allows egress to DigitalOcean (should be default)
- Test: `psql $DATABASE_URL -c "SELECT 1;"`

**SSL certificate fails:**
- Ensure DNS is propagated and points to correct IP
- Run: `dig sitelayer.sandolab.xyz` to verify

---

**Automation Summary:**
- ✅ Droplet created (5 min, automated)
- ✅ Database created (5 min, automated)
- ✅ Firewall configured (1 min, automated)
- ⏳ `/app/sitelayer/.env` on droplet
- ⏳ GitHub Actions `DEPLOY_HOST` and `DEPLOY_SSH_KEY`
- ⏳ Separate Postgres databases/users for prod/dev
- ⏳ Spaces/Clerk/QBO optional service credentials
- ⏳ TLS enablement

**Total:** ~27 minutes to full deployment
