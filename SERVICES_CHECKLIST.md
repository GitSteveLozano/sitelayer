# Sitelayer Services & Infrastructure Checklist

> **🚫 SUPERSEDED — DO NOT USE FOR PROVISIONING (banner added 2026-04-25).**
>
> Same drift as `SERVICES_QUICK_START.md` and `PILOT_SETUP_PLAN.md`: assumes nginx + Hatchet + `CLERK_SECRET_KEY` + `NEXT_PUBLIC_*` + Clerk roles `owner|admin|estimator|field`. The shipped stack uses **Caddy**, a **bespoke Postgres-leased queue** (`packages/queue`), `CLERK_JWT_KEY`/`CLERK_ISSUER`/`CLERK_WEBHOOK_SECRET`, `VITE_*` for the SPA, and roles **`admin|foreman|office|member`**.
>
> **Use instead:** `INFRASTRUCTURE_READY.md`, `DEPLOYMENT.md`, `CRITICAL_PATH.md`, `docs/ONBOARDING_CONTRACTOR.md`, `.env.example`.

**Goal:** Minimal viable setup to onboard first pilot customer  
**Timeline:** 4-6 weeks  
**Monthly Cost:** ~$102/mo

---

## Phase 1: Third-Party Services Registration

### 1.1 Cloud Hosting & Storage

- [ ] **DigitalOcean Account** (https://digitalocean.com)
  - [ ] Create account with credit card
  - [ ] TOR1 (Toronto) region for data sovereignty
  - Subtasks:
    - [ ] Provision 8GB Droplet (Ubuntu 22.04 LTS) — $48/mo
    - [ ] Enable weekly backups — $9.60/mo (20% of droplet)
    - [ ] Managed Postgres database 1GB shared — $15.15/mo
    - [ ] Create Spaces bucket (blueprint storage) — $5/mo
    - [ ] Assign static IP to Droplet
    - [ ] Create VPC for internal networking
    - [ ] Firewall rules: 22 (SSH), 80 (HTTP), 443 (HTTPS), 5432 (Postgres internal)
  - **Cost:** $73.75/mo

### 1.2 Domain & DNS

- [ ] **Domain Registrar** (Porkbun, Namecheap, or Cloudflare)
  - [ ] Register `.com` domain (e.g., `sitelayer.com`, `siterecon.com`)
  - [ ] Point DNS A record to DO Droplet static IP
  - [ ] Verify resolution: `dig yourdomain.com`
  - **Cost:** ~$10/year (~$0.83/mo)

### 1.3 Authentication & User Management

- [ ] **Clerk** (https://dashboard.clerk.com)
  - [ ] Create account and new application (production environment)
  - [ ] Configure Organization model:
    - [ ] One org = one construction company (tenant)
    - [ ] Roles: `owner`, `admin`, `estimator`, `field`
    - [ ] Custom metadata: `company_id` on organization
  - [ ] Copy credentials:
    - [ ] Publishable Key (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`)
    - [ ] Secret Key (`CLERK_SECRET_KEY`)
  - [ ] Configure OAuth providers (for faster onboarding):
    - [ ] Google OAuth
    - [ ] GitHub OAuth (optional, for team)
  - [ ] Enable password authentication fallback
  - [ ] Configure JWT template to include org context:
    ```json
    {
      "org_id": "{{org.id}}",
      "org_slug": "{{org.slug}}",
      "org_role": "{{org.role}}",
      "user_email": "{{user.primary_email_address}}"
    }
    ```
  - **Cost:** Free until 50K MAU (~$20-50/mo for pilot)

### 1.4 QuickBooks Online Integration

- [ ] **Intuit Developer Account** (https://developer.intuit.com)
  - [ ] Create new app (Accounting product)
  - [ ] Set local OAuth redirect URI: `http://localhost:3001/api/integrations/qbo/callback`
  - [ ] Set production OAuth redirect URI after API deployment: `https://yourdomain.com/api/integrations/qbo/callback`
  - [ ] Copy credentials:
    - [ ] Client ID
    - [ ] Client Secret
  - [ ] Test in QBO sandbox before production
  - **Cost:** Free (usage-based when syncing)

### 1.5 Error Tracking & Monitoring

- [ ] **Sentry** (https://sentry.io)
  - [ ] Create account and new project (Node.js + React)
  - [ ] Copy DSN for API: `SENTRY_DSN`
  - [ ] Copy DSN for frontend: `NEXT_PUBLIC_SENTRY_DSN`
  - [ ] Configure error routing and alerts
  - **Cost:** Free until 5K errors/month

- [ ] **UptimeRobot** (https://uptimerobot.com)
  - [ ] Create account (free tier)
  - [ ] Set up 4 monitors:
    - [ ] App health: `GET https://yourdomain.com/`
    - [ ] API health: `GET https://yourdomain.com/api/bootstrap`
    - [ ] Postgres connectivity check
    - [ ] Spaces bucket test fetch
  - [ ] Configure email alerts for downtime
  - **Cost:** Free

### 1.6 Email Service (For Notifications)

- [ ] **Postmark** (https://postmarkapp.com) OR **SendGrid**
  - [ ] Create account and API token
  - [ ] Verify sender domain (yourdomain.com)
  - [ ] Copy API key: `POSTMARK_API_TOKEN`
  - [ ] Send transactional emails (invite links, sync notifications)
  - **Cost:** $15/mo (Postmark Basic) or free trial

---

## Phase 2: Application Credentials & Secrets

Create `.env` files on Droplet with the following (never commit to git):

### apps/api/.env

```bash
# Database
DATABASE_URL=postgres://user:pass@db.digitalocean.com:5432/sitelayer

# Port
PORT=3001

# Clerk
CLERK_SECRET_KEY=sk_live_xxxxx

# QuickBooks OAuth
QBO_CLIENT_ID=xxxxx
QBO_CLIENT_SECRET=xxxxx
QBO_REDIRECT_URI=http://localhost:3001/api/integrations/qbo/callback
QBO_SUCCESS_REDIRECT_URI=http://localhost:3000/?qbo=connected
QBO_ENVIRONMENT=sandbox  # or 'production'

# DigitalOcean Spaces
DO_SPACES_ENDPOINT=https://tor1.digitaloceanspaces.com
DO_SPACES_KEY=xxxxx
DO_SPACES_SECRET=xxxxx
DO_SPACES_BUCKET=sitelayer

# API/Frontend URLs
API_URL=https://yourdomain.com
FRONTEND_URL=https://yourdomain.com

# Observability
SENTRY_DSN=https://xxxxx@sentry.io/xxxxx
POSTMARK_API_TOKEN=xxxxx

# Pilot Company (Hardcoded for MVP)
ACTIVE_COMPANY_SLUG=pilot-company
ACTIVE_USER_ID=demo-user
```

### apps/web/.env.local

```bash
# Public URLs
VITE_API_URL=https://yourdomain.com
VITE_APP_NAME=Sitelayer

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_xxxxx

# Observability
NEXT_PUBLIC_SENTRY_DSN=https://xxxxx@sentry.io/xxxxx
```

---

## Phase 3: Infrastructure Provisioning

### 3.1 Droplet Setup

```bash
# SSH into Droplet
ssh -i /path/to/key ubuntu@<droplet-static-ip>

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js + npm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Git
sudo apt install -y git

# Install Docker (for Hatchet)
sudo apt install -y docker.io
sudo usermod -aG docker ubuntu

# Install nginx (reverse proxy)
sudo apt install -y nginx

# Install certbot (SSL/TLS)
sudo apt install -y certbot python3-certbot-nginx

# Install PostgreSQL client (for migrations)
sudo apt install -y postgresql-client
```

### 3.2 Database Schema

```bash
# On Droplet, clone repo
git clone https://github.com/yourusername/sitelayer.git
cd sitelayer

# Apply migrations and verify schema
DATABASE_URL="$DATABASE_URL" scripts/migrate-db.sh
DATABASE_URL="$DATABASE_URL" scripts/check-db-schema.sh

# Verify tables
psql $DATABASE_URL -c "\dt"
```

### 3.3 Hatchet Deployment (Background Jobs)

```bash
# Run Hatchet Lite (via Docker)
docker run -d \
  --name hatchet \
  -e DATABASE_URL="$DATABASE_URL" \
  -p 8080:8080 \
  ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest

# Verify running
curl http://localhost:8080/health
```

### 3.4 Application Deployment

```bash
# Navigate to sitelayer repo
cd /home/ubuntu/sitelayer

# Install dependencies
npm install

# Build frontend
cd apps/web
npm run build

# Copy to web root
sudo mkdir -p /var/www/sitelayer
sudo cp -r dist/* /var/www/sitelayer/

# Build API
cd ../api
npm run build

# Start API (in tmux or via PM2)
npm run dev
# OR
npm install -g pm2
pm2 start "npm run dev" --name "sitelayer-api"
```

### 3.5 nginx Configuration

Create `/etc/nginx/sites-available/sitelayer`:

```nginx
# HTTP → HTTPS redirect
server {
  listen 80;
  server_name yourdomain.com;
  return 301 https://$server_name$request_uri;
}

# HTTPS with reverse proxy
server {
  listen 443 ssl http2;
  server_name yourdomain.com;

  # SSL certificates (generated by certbot)
  ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

  # Frontend static files
  location / {
    root /var/www/sitelayer;
    try_files $uri $uri/ /index.html;
  }

  # API proxy
  location /api/ {
    proxy_pass http://localhost:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Enable and start:

```bash
sudo ln -s /etc/nginx/sites-available/sitelayer /etc/nginx/sites-enabled/
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 3.6 SSL/TLS Certificate

```bash
# Generate Let's Encrypt certificate
sudo certbot certonly --standalone -d yourdomain.com

# Reload nginx with cert
sudo systemctl reload nginx

# Verify HTTPS works
curl https://yourdomain.com
```

---

## Phase 4: Code Changes Required

### 4.1 Clerk Auth Integration

**Task:** Replace hardcoded demo user with Clerk OAuth

- [ ] Install: `npm install @clerk/nextjs` (or appropriate Clerk SDK)
- [ ] Update `apps/api/src/server.ts`:
  - [ ] Verify Clerk JWT in Authorization header
  - [ ] Extract org_id and org_role from JWT claims
  - [ ] Replace `ACTIVE_COMPANY_SLUG` env var with JWT org_slug
  - [ ] Replace `ACTIVE_USER_ID` env var with JWT user_email
- [ ] Update `apps/web/src/main.tsx`:
  - [ ] Wrap app in `<ClerkProvider>`
  - [ ] Add Clerk UI components (sign-in, user button)
- [ ] Test: Sign in with Google OAuth, verify org context in requests

### 4.2 DigitalOcean Spaces Upload

**Task:** Implement blueprint upload to Spaces

- [ ] Install: `npm install aws-sdk` (for S3-compatible Spaces API)
- [ ] Create `apps/api/src/lib/spaces.ts`:
  - [ ] Initialize S3 client with DO Spaces credentials
  - [ ] Implement `uploadBlueprint(file, projectId): Promise<string>`
- [ ] Add `POST /api/projects/:id/blueprints` endpoint:
  - [ ] Accept multipart/form-data (PDF file)
  - [ ] Validate file type (PDF only)
  - [ ] Upload to Spaces bucket
  - [ ] Store metadata in `blueprints` table
  - [ ] Return signed URL (1-hour expiry)
- [ ] Update `apps/web/src/App.tsx`:
  - [ ] Add file upload input
  - [ ] POST to API, display progress
  - [ ] Render PDF viewer with returned URL
- [ ] Test: Upload a PDF, verify it appears in Spaces dashboard

### 4.3 PDF Rendering & Annotation

**Task:** PDF viewer + polygon drawing

- [ ] Install: `npm install pdfjs-dist konva react-konva`
- [ ] Create `apps/web/src/components/PdfViewer.tsx`:
  - [ ] Render PDF pages using PDF.js
  - [ ] Support page navigation
- [ ] Create `apps/web/src/components/AnnotationLayer.tsx`:
  - [ ] Konva Stage overlay on PDF canvas
  - [ ] Click-to-draw polygons (closed path)
  - [ ] Save button
- [ ] Add `POST /api/projects/:id/annotations` endpoint:
  - [ ] Accept polygon points in PDF coordinate space
  - [ ] Calculate area/perimeter
  - [ ] Store in `annotations` table
- [ ] Test: Draw polygon, save, refresh page, verify it reappears

### 4.4 Background Job Queue (pg-boss)

**Task:** Setup job queue for QBO sync

- [ ] Install: `npm install pg-boss`
- [ ] Initialize in `apps/api/src/server.ts`:

  ```typescript
  import PgBoss from 'pg-boss'

  const boss = new PgBoss(process.env.DATABASE_URL)
  await boss.start()
  ```

- [ ] Create `POST /api/integrations/qbo/sync` endpoint:
  - [ ] Queue job: `boss.send('qbo-sync', { companyId })`
  - [ ] Return job ID
- [ ] Create job handler in `apps/worker/src/worker.ts`:
  - [ ] Subscribe to 'qbo-sync' job
  - [ ] Fetch QBO tokens from DB
  - [ ] Call QBO API to fetch customers, items
  - [ ] Reconcile with local data
  - [ ] Store mapping in `integration_mappings` table
- [ ] Test: Trigger sync via API, check worker logs

### 4.5 Observability Hooks

**Task:** Wire up Sentry + logging

- [ ] Install Sentry SDKs:
  ```bash
  npm install @sentry/node @sentry/react
  ```
- [ ] Initialize in API `server.ts`:

  ```typescript
  import * as Sentry from '@sentry/node'

  Sentry.init({ dsn: process.env.SENTRY_DSN })
  app.use(Sentry.Handlers.requestHandler())
  app.use(Sentry.Handlers.errorHandler())
  ```

- [ ] Initialize in frontend `main.tsx`:

  ```typescript
  import * as Sentry from '@sentry/react'

  Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN })
  ```

- [ ] Add structured logging:
  - [ ] Install: `npm install winston`
  - [ ] Log all API requests (timestamp, method, path, status, duration)
  - [ ] Log errors with stack trace
- [ ] Test: Trigger a 500 error, verify it appears in Sentry

---

## Phase 5: Pre-Deployment Checklist

### 5.1 Configuration Verification

- [ ] `.env` file created on Droplet with all secrets
- [ ] `.env` file in `.gitignore` (never commit)
- [ ] DO Spaces bucket accessible with credentials
- [ ] Clerk org created and JWT template configured
- [ ] QBO sandbox app created and credentials saved
- [ ] Sentry projects created for API + frontend
- [ ] Database URL accessible from Droplet
- [ ] Domain DNS resolves to Droplet IP

### 5.2 Code Verification

- [ ] `npm run typecheck` passes for all workspaces
- [ ] `npm run build` succeeds for web + api
- [ ] No hardcoded company_id or user_id in code
- [ ] Clerk auth check in place (verify JWT exists)
- [ ] Clerk middleware applied to protected routes
- [ ] API returns 401 if no valid Clerk token

### 5.3 Deployment Verification

- [ ] Postgres schema applied (`\dt` shows all tables)
- [ ] Hatchet running and healthy (`curl localhost:8080/health`)
- [ ] API running on localhost:3001 (`curl localhost:3001/health`)
- [ ] nginx reverse proxy working (`curl https://yourdomain.com/api/bootstrap`)
- [ ] Frontend assets served (`curl https://yourdomain.com` returns HTML)
- [ ] SSL certificate valid (`openssl s_client -connect yourdomain.com:443`)

---

## Phase 6: Pilot Launch Checklist

### 6.1 Clerk Organization Setup

- [ ] Create organization in Clerk: "Pilot Company Inc"
- [ ] Invite pilot customer contact as `owner` role
- [ ] Create admin user for your team as `admin` role
- [ ] Test org switching in frontend

### 6.2 End-to-End Workflow Test

- [ ] Log in as pilot customer (via Google OAuth)
- [ ] Create a project via API:
  ```bash
  curl -X POST https://yourdomain.com/api/projects \
    -H "Authorization: Bearer <clerk-token>" \
    -H "Content-Type: application/json" \
    -d '{"name": "Sample Renovation", "customer": "Test Corp"}'
  ```
- [ ] Upload a sample blueprint PDF
- [ ] Draw a polygon annotation on blueprint
- [ ] Save annotation, reload page, verify it persists
- [ ] Verify annotation appears in `annotations` table
- [ ] Test QBO OAuth redirect (sandbox)
- [ ] Check Sentry for any errors
- [ ] Check logs in journalctl

### 6.3 Performance & Reliability

- [ ] Measure API response time (should be <500ms)
- [ ] Test with multiple concurrent uploads
- [ ] Verify backups are running (check DO dashboard)
- [ ] Run UptimeRobot monitors for 24 hours
- [ ] Confirm email alerts work (if configured)

---

## Service Summary Table

| Service               | Purpose                      | Cost         | Required?      | Notes                                |
| --------------------- | ---------------------------- | ------------ | -------------- | ------------------------------------ |
| **DigitalOcean**      | Cloud hosting + DB + storage | $73.75/mo    | ✅ Required    | Only Toronto region                  |
| **Clerk**             | Multi-tenant auth            | Free (pilot) | ✅ Required    | Must replace hardcoded user          |
| **Intuit QBO**        | Accounting integration       | Free         | ✅ Required    | Start with sandbox                   |
| **Sentry**            | Error tracking               | Free (pilot) | 🟡 Recommended | Helps debug production issues        |
| **UptimeRobot**       | Health monitoring            | Free         | 🟡 Recommended | Early warning of downtime            |
| **Postmark/SendGrid** | Email service                | $15/mo       | 🟡 Recommended | For invite links, sync notifications |
| **Domain**            | DNS + branding               | ~$10/year    | ✅ Required    | yourdomain.com                       |

---

## Critical Path Dependencies

```
1. DO account + Droplet + DB (blocks everything)
   ↓
2. Domain + DNS (blocks SSL cert)
   ↓
3. SSL cert (blocks HTTPS deployment)
   ↓
4. Clerk OAuth (blocks user management)
   ↓
5. DO Spaces upload code (blocks blueprint handling)
   ↓
6. PDF viewer + annotation (blocks takeoff workflow)
   ↓
7. QBO OAuth + job queue (blocks sync)
   ↓
8. First pilot customer invited
```

---

## Troubleshooting Guide (Bookmark This)

### "Can't connect to database from Droplet"

- [ ] Check DATABASE_URL in .env matches DO console
- [ ] Verify Droplet is in same region as DB
- [ ] Check firewall allows 5432 from Droplet IP
- [ ] Test: `psql $DATABASE_URL -c "SELECT 1"`

### "Clerk OAuth fails"

- [ ] Verify `CLERK_SECRET_KEY` is from live environment (not dev)
- [ ] Check redirect URI matches exactly: `https://yourdomain.com/api/integrations/clerk/callback`
- [ ] Verify JWT template includes org_id

### "Blueprint upload fails"

- [ ] Check DO_SPACES_KEY and DO_SPACES_SECRET in .env
- [ ] Verify bucket is public or endpoint has read permissions
- [ ] Test: `aws s3 ls s3://sitelayer/ --endpoint-url https://tor1.digitaloceanspaces.com`

### "nginx returns 502 Bad Gateway"

- [ ] Check API is running: `curl localhost:3001`
- [ ] Check nginx config: `sudo nginx -t`
- [ ] Check nginx logs: `sudo tail -f /var/log/nginx/error.log`
- [ ] Check API logs: `pm2 logs sitelayer-api`

### "PDF viewer shows blank canvas"

- [ ] Verify PDF file is valid: `file blueprint.pdf`
- [ ] Check browser console for CORS errors
- [ ] Verify signed URL is within 1-hour expiry
- [ ] Test with a known-good PDF from browsers

---

**Next Step:** Start with DO account creation and Droplet provisioning (Phase 1.1).
