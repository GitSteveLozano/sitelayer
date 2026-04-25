# Sitelayer Services Quick Start

> **🚫 SUPERSEDED — DO NOT USE FOR PROVISIONING (banner added 2026-04-25).**
>
> The infrastructure described here is provisioned (see `INFRASTRUCTURE_READY.md`) and the code-changes are merged. Concrete instructions are wrong against the current code:
> - Reverse proxy is **Caddy**, not nginx + certbot.
> - Background jobs are a bespoke Postgres-leased queue, not Hatchet.
> - Auth env vars are `CLERK_JWT_KEY` / `CLERK_ISSUER` / `CLERK_WEBHOOK_SECRET` / `AUTH_ALLOW_HEADER_FALLBACK` — not `CLERK_SECRET_KEY`. The SPA is Vite, so frontend env is `VITE_*`, not `NEXT_PUBLIC_*`.
>
> **Use instead:** `INFRASTRUCTURE_READY.md`, `DEPLOYMENT.md`, `CRITICAL_PATH.md`, `docs/ONBOARDING_CONTRACTOR.md`, `.env.example`.

**TL;DR:** 7 services to sign up for, 5 code changes to implement, 1 Droplet to configure.

---

## Services to Sign Up For (In Order)

### 1. DigitalOcean

- **URL:** https://digitalocean.com
- **What:** Cloud hosting, database, file storage
- **Setup Time:** 15 min
- **What to Get:**
  - [ ] Droplet ID (8GB Ubuntu 22.04)
  - [ ] Database connection string (DATABASE_URL)
  - [ ] DO Spaces endpoint + credentials
  - [ ] Static IP address
- **Cost:** $73.75/mo

### 2. Domain Registrar (Porkbun / Namecheap / Cloudflare)

- **URL:** https://porkbun.com (cheapest + best UX)
- **What:** Domain name for yourdomain.com
- **Setup Time:** 10 min
- **What to Get:**
  - [ ] Domain name (e.g., sitelayer.com)
  - [ ] DNS pointing to DO Droplet IP
- **Cost:** $10/year

### 3. Clerk

- **URL:** https://dashboard.clerk.com
- **What:** Multi-tenant authentication (replace hardcoded demo user)
- **Setup Time:** 20 min
- **What to Get:**
  - [ ] Publishable Key (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
  - [ ] Secret Key (CLERK_SECRET_KEY)
  - [ ] Configured Organization model
  - [ ] Google OAuth client ID (optional but recommended)
- **Cost:** Free for pilot

### 4. Intuit Developer (QuickBooks)

- **URL:** https://developer.intuit.com
- **What:** OAuth credentials for QBO sync
- **Setup Time:** 15 min
- **What to Get:**
  - [ ] Client ID (QBO_CLIENT_ID)
  - [ ] Client Secret (QBO_CLIENT_SECRET)
  - [ ] Development redirect URI: `http://localhost:3001/api/integrations/qbo/callback`
  - [ ] Sandbox realm ID (for testing)
- **Cost:** Free

### 5. Sentry

- **URL:** https://sentry.io
- **What:** Error tracking (knows when things break)
- **Setup Time:** 10 min
- **What to Get:**
  - [ ] DSN for API (SENTRY_DSN)
  - [ ] DSN for frontend (NEXT_PUBLIC_SENTRY_DSN)
- **Cost:** Free for pilot

### 6. UptimeRobot

- **URL:** https://uptimerobot.com
- **What:** Health checks (emails you when app is down)
- **Setup Time:** 10 min
- **What to Get:**
  - [ ] 4 monitors created (app, API, DB, Spaces)
  - [ ] Email alerts configured
- **Cost:** Free

### 7. Postmark (Optional but Recommended)

- **URL:** https://postmarkapp.com
- **What:** Transactional emails (invite links, sync notifications)
- **Setup Time:** 10 min
- **What to Get:**
  - [ ] API token (POSTMARK_API_TOKEN)
  - [ ] Sender domain verified
- **Cost:** $15/mo (or use free tier)

---

## Code Changes (Parallelizable)

### Change 1: Clerk Auth Integration

**File:** `apps/api/src/server.ts`  
**Time:** 2 hours  
**What:** Replace hardcoded ACTIVE_COMPANY_SLUG with JWT org_slug

```typescript
// OLD (remove):
const activeCompanySlug = process.env.ACTIVE_COMPANY_SLUG ?? 'la-operations'

// NEW (add):
import jwt from 'jsonwebtoken'

function getCompanySlugFromAuth(req: http.IncomingMessage): string {
  const authHeader = req.headers.authorization
  if (!authHeader) return 'unauthorized'

  const token = authHeader.split(' ')[1]
  const decoded = jwt.verify(token, process.env.CLERK_SECRET_KEY)
  return decoded.org_slug
}

// In each handler:
const companySlug = getCompanySlugFromAuth(req)
```

### Change 2: DO Spaces Upload

**File:** `apps/api/src/server.ts`  
**Time:** 2 hours  
**What:** Implement `POST /api/projects/:id/blueprints`

```typescript
import AWS from 'aws-sdk'

const s3 = new AWS.S3({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  region: 'us-east-1',
})

// Add endpoint
app.post('/api/projects/:id/blueprints', async (req, res) => {
  // Parse multipart file upload
  // Validate: PDF only
  // Upload to s3: bucket = 'sitelayer', key = `blueprints/{project_id}/{filename}`
  // Store metadata in blueprints table
  // Return signed URL (1 hour expiry)
})
```

### Change 3: PDF Viewer + Annotation

**File:** `apps/web/src/App.tsx`  
**Time:** 3 hours  
**What:** PDF.js + Konva polygon drawing

```typescript
// Install: npm install pdfjs-dist konva react-konva

// Add components:
// - PdfViewer: renders PDF pages
// - AnnotationLayer: draws polygons on top
// - Add state: { blueprintUrl, annotations[], mode: 'view'|'draw' }
// - Add POST to /api/projects/:id/annotations on save
```

### Change 4: Job Queue (pg-boss)

**File:** `apps/api/src/server.ts` + `apps/worker/src/worker.ts`  
**Time:** 2 hours  
**What:** Setup background job processor

```typescript
// In server.ts:
import PgBoss from 'pg-boss'
const boss = new PgBoss(process.env.DATABASE_URL)
await boss.start()

// Add endpoint:
app.post('/api/integrations/qbo/sync', async (req, res) => {
  await boss.send('qbo-sync', { companyId })
  res.json({ queued: true })
})

// In worker.ts:
boss.subscribe('qbo-sync', async (job) => {
  // Fetch QBO tokens
  // Call QBO API
  // Store mappings
})
```

### Change 5: Observability (Sentry + Logging)

**File:** `apps/api/src/server.ts` + `apps/web/src/main.tsx`  
**Time:** 1 hour  
**What:** Wire up error tracking + structured logging

```typescript
// In API:
import * as Sentry from "@sentry/node";
Sentry.init({ dsn: process.env.SENTRY_DSN });
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.errorHandler());

// In Frontend:
import * as Sentry from "@sentry/react";
Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN });

// Add logging:
npm install winston
// Log all API requests + errors
```

---

## Droplet Configuration (Sequential)

### Step 1: Initial Setup

```bash
# SSH in
ssh -i /path/to/key ubuntu@<static-ip>

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install tools
sudo apt install -y git docker.io nginx certbot python3-certbot-nginx postgresql-client
sudo usermod -aG docker ubuntu
```

### Step 2: Clone & Deploy

```bash
# Clone repo
git clone <your-repo>
cd sitelayer

# Install deps
npm install

# Create .env file (with all secrets from services above)
cat > apps/api/.env << EOF
DATABASE_URL=postgres://...
CLERK_SECRET_KEY=sk_...
DO_SPACES_ENDPOINT=https://tor1.digitaloceanspaces.com
DO_SPACES_KEY=...
DO_SPACES_SECRET=...
QBO_CLIENT_ID=...
QBO_CLIENT_SECRET=...
QBO_REDIRECT_URI=http://localhost:3001/api/integrations/qbo/callback
QBO_SUCCESS_REDIRECT_URI=http://localhost:3000/?qbo=connected
SENTRY_DSN=...
EOF

# Build frontend
cd apps/web && npm run build
sudo mkdir -p /var/www/sitelayer
sudo cp -r dist/* /var/www/sitelayer/

# Build API and start
cd ../api
npm run build
npm install -g pm2
pm2 start "npm run dev" --name sitelayer-api
pm2 save
```

### Step 3: nginx + SSL

```bash
# Create nginx config at /etc/nginx/sites-available/sitelayer
# (copy from SERVICES_CHECKLIST.md Phase 3.5)

# Enable
sudo ln -s /etc/nginx/sites-available/sitelayer /etc/nginx/sites-enabled/
sudo systemctl enable nginx
sudo systemctl start nginx

# SSL cert
sudo certbot certonly --standalone -d yourdomain.com
sudo systemctl reload nginx
```

### Step 4: Database & Hatchet

```bash
# Apply schema
psql $DATABASE_URL < docker/postgres/init/001_schema.sql

# Run Hatchet
docker run -d \
  --name hatchet \
  -e DATABASE_URL="$DATABASE_URL" \
  -p 8080:8080 \
  ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest
```

---

## Verification Checklist

- [ ] `dig yourdomain.com` returns Droplet IP
- [ ] `curl https://yourdomain.com` returns HTML (frontend)
- [ ] `curl https://yourdomain.com/api/bootstrap` returns 200 (API running)
- [ ] `psql $DATABASE_URL -c "\dt"` shows all tables
- [ ] `curl localhost:8080/health` returns 200 (Hatchet running)
- [ ] `pm2 logs sitelayer-api` shows clean logs (no errors)
- [ ] Sentry dashboard shows test event (if you triggered error)
- [ ] UptimeRobot showing all monitors green

---

## Pilot Launch (Day 1)

```bash
# Create Clerk org
# Invite pilot customer to yourdomain.com
# They sign in with Google OAuth

# Test workflow
1. Create project
2. Upload blueprint PDF
3. Draw polygon on canvas
4. Save annotation
5. Reload page (annotation persists)
6. Check Sentry for zero errors
7. Check logs: no warnings
```

---

## Post-Pilot Plan

- [ ] Upgrade DO Postgres to 4GB dedicated ($60.90/mo)
- [ ] Add Valkey cache ($15/mo)
- [ ] Implement real QBO sync (not stub)
- [ ] Build analytics dashboard
- [ ] Collect customer feedback

---

## Support Contacts

- **DO:** support@digitalocean.com
- **Clerk:** support@clerk.com
- **Intuit:** developer.intuit.com/support
- **Sentry:** support@sentry.io
- **Your domain:** registrar support

---

**Total Setup Time:** ~24 hours (can parallelize most of it)  
**Monthly Cost:** ~$102/mo  
**Success Metric:** First pilot customer uploads blueprint + creates estimate
