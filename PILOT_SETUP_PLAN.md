# Sitelayer Pilot Setup Plan

**Goal:** Get one real construction company on the platform, upload a blueprint, create an estimate, and push to QBO

**Timeline:** 4-6 weeks to pilot-ready
**Monthly Cost:** ~$102/mo infrastructure

---

## Phase 1: Foundation & Infrastructure (Week 1)

### 1.1 DigitalOcean Setup ($73.75/mo recurring)

- [ ] Create DO account with credit card
- [ ] Provision TOR1 (Toronto) region exclusively
  - [ ] Basic 8GB Droplet ($48/mo) — runs app + Hatchet worker
  - [ ] Enable weekly backups ($9.60/mo, 20% of droplet)
  - [ ] Managed Postgres 1GB shared ($15.15/mo) — schema + data
  - [ ] Spaces bucket TOR1 ($5/mo) — blueprints + files
- [ ] Assign static IP to Droplet
- [ ] Create a firewall rule: allow 22 (SSH), 80 (HTTP), 443 (HTTPS), 5432 (Postgres)
- [ ] Create VPC for all services (internal networking)

**Output:** DO project, Droplet running Ubuntu 22.04 LTS, DB provisioned, Spaces bucket

### 1.2 Domain & DNS

- [ ] Register `.com` domain (Porkbun or Cloudflare) (~$10/year)
- [ ] Point DNS A record to Droplet static IP
- [ ] Add DO as nameserver (if using external registrar)
- [ ] Test DNS resolution: `dig yourdomain.com` returns Droplet IP

**Output:** yourdomain.com resolves to Droplet

### 1.3 Postgres Schema Deployment

- [ ] SSH into Droplet: `ssh -i /path/to/key ubuntu@<droplet-ip>`
- [ ] Create `.env` file on Droplet with `DATABASE_URL=postgres://...` (from DO console)
- [ ] Clone git repo: `git clone https://github.com/yourusername/sitelayer.git`
- [ ] Run Postgres schema migration (one-time):
  ```bash
  psql $DATABASE_URL < docker/postgres/init/001_schema.sql
  ```
- [ ] Verify tables exist: `psql $DATABASE_URL -c "\dt"`

**Output:** Empty Postgres DB with all tables, ready for data

---

## Phase 2: Auth & User Management (Week 1-2)

### 2.1 Clerk Setup

- [ ] Create Clerk account at https://dashboard.clerk.com
- [ ] Create new application (production environment)
- [ ] Configure Clerk Organization model:
  - [ ] One organization = one construction company (tenant)
  - [ ] Roles: `owner`, `admin`, `estimator`, `field`
  - [ ] Custom metadata: store `company_id` on organization
- [ ] Copy Clerk keys:
  - [ ] Publishable key (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
  - [ ] Secret key (CLERK_SECRET_KEY)
- [ ] Configure OAuth providers (optional for pilot):
  - [ ] Google OAuth (easier than email magic links)
  - [ ] GitHub OAuth (for team members who are devs)
- [ ] Enable password authentication (fallback for non-technical users)

**Output:** Clerk app configured, keys ready for `.env`

### 2.2 JWT Configuration in Clerk

- [ ] In Clerk dashboard, set JWT template to include:
  ```json
  {
    "org_id": "{{org.id}}",
    "org_slug": "{{org.slug}}",
    "org_role": "{{org.role}}",
    "user_email": "{{user.primary_email_address}}"
  }
  ```
- [ ] Verify JWT structure by signing in and inspecting token

**Output:** JWTs include org context for API authorization

---

## Phase 3: Application Setup & Deployment (Week 2)

### 3.1 Environment Configuration

- [ ] On Droplet, create `apps/api/.env`:
  ```
  DATABASE_URL=postgres://...
  CLERK_SECRET_KEY=sk_...
  VITE_API_URL=https://yourdomain.com
  VITE_COMPANY_SLUG=pilot-company
  ```
- [ ] On Droplet, create `apps/web/.env.local`:
  ```
  VITE_API_URL=https://yourdomain.com
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
  ```
- [ ] Generate JWT secret for API token validation: `openssl rand -hex 32`

**Output:** `.env` files with all secrets, API can read Clerk tokens

### 3.2 Build & Deploy Frontend

- [ ] On Droplet, build the frontend:
  ```bash
  cd apps/web
  npm run build
  ```
- [ ] Copy build output to a public directory:
  ```bash
  mkdir -p /var/www/sitelayer
  cp -r dist/* /var/www/sitelayer/
  ```
- [ ] Install nginx and configure reverse proxy:
  ```bash
  sudo apt-get install -y nginx
  ```
- [ ] Create `/etc/nginx/sites-available/sitelayer`:
  ```nginx
  server {
    listen 443 ssl http2;
    server_name yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    location / {
      root /var/www/sitelayer;
      try_files $uri $uri/ /index.html;
    }
    
    location /api {
      proxy_pass http://localhost:3001;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }
  }
  server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$server_name$request_uri;
  }
  ```
- [ ] Enable nginx: `sudo systemctl enable nginx && sudo systemctl start nginx`

**Output:** Frontend served at https://yourdomain.com, `/api/*` proxies to Node.js

### 3.3 Build & Run API

- [ ] On Droplet, start API server:
  ```bash
  cd apps/api
  npm install
  npm run build
  npm run dev
  ```
  (Or use `pm2 start npm -- run dev` for background)
- [ ] Verify API responds:
  ```bash
  curl -H "x-sitelayer-company-slug: pilot-company" \
       https://yourdomain.com/api/bootstrap
  ```

**Output:** API listening on :3001, nginx forwards requests, responds with bootstrap data

### 3.4 SSL/TLS Certificate

- [ ] Install certbot: `sudo apt-get install -y certbot python3-certbot-nginx`
- [ ] Generate cert:
  ```bash
  sudo certbot certonly --standalone -d yourdomain.com
  ```
- [ ] Reload nginx with cert paths

**Output:** Valid SSL cert, HTTPS working

---

## Phase 4: PDF Canvas Implementation (Week 2-3)

### 4.1 PDF.js Integration

- [ ] In `apps/web/src`, create `components/PdfViewer.tsx`:
  ```typescript
  import * as pdfjsLib from 'pdfjs-dist';
  
  pdfjsLib.GlobalWorkerOptions.workerSrc = 
    `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
  
  export function PdfViewer({ url }: { url: string }) {
    const [pageNum, setPageNum] = useState(1);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    
    useEffect(() => {
      pdfjsLib.getDocument(url).promise.then(pdf => {
        pdf.getPage(pageNum).then(page => {
          const canvas = canvasRef.current!;
          const ctx = canvas.getContext('2d')!;
          const viewport = page.getViewport({ scale: 1.5 });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          page.render({ canvasContext: ctx, viewport });
        });
      });
    }, [url, pageNum]);
    
    return <canvas ref={canvasRef} />;
  }
  ```
- [ ] Test with a sample blueprint PDF from Spaces

**Output:** Blueprint renders in browser canvas

### 4.2 Konva.js Annotation Layer

- [ ] Install: `npm install konva react-konva`
- [ ] Create `components/AnnotationLayer.tsx`:
  ```typescript
  import { Stage, Layer, Line, Transformer } from 'react-konva';
  
  export function AnnotationLayer({ 
    width, 
    height, 
    onCoordinate 
  }: { 
    width: number; 
    height: number; 
    onCoordinate: (x: number, y: number) => void 
  }) {
    const [points, setPoints] = useState<number[]>([]);
    
    const handleStageClick = (e: any) => {
      const pos = e.currentTarget.getPointerPosition();
      setPoints([...points, pos.x, pos.y]);
    };
    
    const handleSave = async () => {
      // Convert canvas coords to PDF space: viewport.convertToPdfPoint(x, y)
      // Then POST to /api/annotations
      console.log('Saving annotation:', points);
    };
    
    return (
      <div>
        <Stage width={width} height={height} onClick={handleStageClick}>
          <Layer>
            {points.length > 1 && (
              <Line points={points} stroke="blue" strokeWidth={2} />
            )}
          </Layer>
        </Stage>
        <button onClick={handleSave}>Save Annotation</button>
      </div>
    );
  }
  ```
- [ ] Overlay on PDF canvas in `TakeoffView`

**Output:** User can draw polygons on blueprints

### 4.3 Annotation Persistence

- [ ] Create API endpoint `POST /api/projects/:id/annotations`:
  ```typescript
  app.post('/api/projects/:id/annotations', async (req, res) => {
    const { blueprintId, points, type } = req.body;
    const companyId = req.headers['x-sitelayer-company-slug'];
    
    const result = await pool.query(
      `INSERT INTO annotations 
       (blueprint_id, company_id, points, annotation_type) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [blueprintId, companyId, JSON.stringify(points), type]
    );
    res.json(result.rows[0]);
  });
  ```
- [ ] Test: draw polygon, save, refresh page, verify polygon reappears

**Output:** Annotations persist to DB and reload on page refresh

---

## Phase 5: Blueprint Upload (Week 2-3)

### 5.1 Blueprint Upload to Spaces

- [ ] In API, add `POST /api/projects/:id/blueprints`:
  ```typescript
  import AWS from 'aws-sdk';
  
  const s3 = new AWS.S3({
    endpoint: process.env.DO_SPACES_ENDPOINT,
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
    region: 'us-east-1'
  });
  
  app.post('/api/projects/:id/blueprints', upload.single('file'), async (req, res) => {
    const params = {
      Bucket: 'sitelayer',
      Key: `blueprints/${req.params.id}/${req.file.originalname}`,
      Body: req.file.buffer,
      ContentType: 'application/pdf'
    };
    
    const result = await s3.upload(params).promise();
    
    // Store metadata in DB
    await pool.query(
      `INSERT INTO blueprints (project_id, file_name, storage_path) 
       VALUES ($1, $2, $3)`,
      [req.params.id, req.file.originalname, result.Location]
    );
    
    res.json({ url: result.Location });
  });
  ```
- [ ] Create frontend upload form in `TakeoffView`

**Output:** User can upload PDF files, they're stored in Spaces, URL returned to frontend

### 5.2 Generate Signed URLs (for Private Blueprints)

- [ ] Add helper to API:
  ```typescript
  function getSignedUrl(bucketKey: string) {
    return s3.getSignedUrl('getObject', {
      Bucket: 'sitelayer',
      Key: bucketKey,
      Expires: 3600 // 1 hour
    });
  }
  ```
- [ ] Include signed URL in `GET /api/blueprints/:id` response

**Output:** Blueprints can be fetched with time-limited URLs

---

## Phase 6: QBO Integration Foundation (Week 3-4)

### 6.1 OAuth Setup in Intuit

- [ ] Create QuickBooks Developer account at https://developer.intuit.com
- [ ] Create new app (Accounting)
- [ ] Set OAuth redirect URI: `https://yourdomain.com/api/integrations/qbo/callback`
- [ ] Save Client ID and Client Secret to `.env`

**Output:** QBO credentials ready

### 6.2 QBO Auth Flow

- [ ] Install packages: `npm install intuit-oauth`
- [ ] Create `POST /api/integrations/qbo/auth` endpoint:
  ```typescript
  app.get('/api/integrations/qbo/auth', (req, res) => {
    const companyId = req.headers['x-sitelayer-company-slug'];
    const authUrl = `https://appcenter.intuit.com/connect/oauth2?` +
      `client_id=${process.env.QBO_CLIENT_ID}` +
      `&redirect_uri=${process.env.QBO_REDIRECT_URI}` +
      `&response_type=code` +
      `&scope=com.intuit.quickbooks.accounting` +
      `&state=${companyId}`;
    res.json({ authUrl });
  });
  ```
- [ ] Create callback handler: `GET /api/integrations/qbo/callback?code=...&state=...`
  - [ ] Exchange code for tokens (via intuit-oauth)
  - [ ] Store tokens encrypted in DB under the company

**Output:** QBO OAuth flow wired, tokens stored

### 6.3 Hatchet Deployment (Background Jobs)

- [ ] On Droplet, install Docker if not present: `sudo apt-get install -y docker.io`
- [ ] Run Hatchet Lite:
  ```bash
  docker run -d \
    -e DATABASE_URL=postgres://... \
    -p 8080:8080 \
    ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest
  ```
- [ ] Verify Hatchet dashboard at `http://localhost:8080`

**Output:** Hatchet running, accessible via internal port

### 6.4 QBO Sync Job (Stub)

- [ ] Create `POST /api/integrations/qbo/sync` endpoint:
  ```typescript
  app.post('/api/integrations/qbo/sync', async (req, res) => {
    const companyId = req.headers['x-sitelayer-company-slug'];
    
    // For pilot: just log that sync was triggered
    console.log(`QBO sync triggered for ${companyId}`);
    
    // Later: queue a Hatchet workflow
    res.json({ queued: true });
  });
  ```

**Output:** Endpoint exists and can be called (real sync in Phase 7)

---

## Phase 7: Observability & Monitoring (Week 3-4)

### 7.1 Sentry Error Tracking

- [ ] Create Sentry account and new project (Node.js + Next.js)
- [ ] Add to API `.env`: `SENTRY_DSN=https://...`
- [ ] Initialize in API:
  ```typescript
  import * as Sentry from "@sentry/node";
  
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: 'production',
    tracesSampleRate: 0.1
  });
  ```
- [ ] Add to frontend: `NEXT_PUBLIC_SENTRY_DSN`
- [ ] Verify errors are captured: trigger a 500 error in API and check dashboard

**Output:** Errors logged to Sentry, accessible via dashboard

### 7.2 UptimeRobot Monitoring

- [ ] Create UptimeRobot account (free tier)
- [ ] Add 4 monitors:
  - [ ] App health: `GET https://yourdomain.com/` (should return 200)
  - [ ] API health: `GET https://yourdomain.com/api/bootstrap`
  - [ ] Postgres: ping DB via custom script
  - [ ] Spaces: test GET to a public object
- [ ] Set email alerts for downtime

**Output:** 5-minute checks running, email alerts configured

### 7.3 Logs & Metrics (Minimal)

- [ ] Install `winston` for structured logging:
  ```bash
  npm install winston
  ```
- [ ] Log all API requests and errors to stdout
- [ ] On Droplet, configure `journalctl` to capture Systemd logs:
  ```bash
  journalctl -u sitelayer-api -f  # tail logs
  ```

**Output:** Logs accessible via SSH for debugging

---

## Phase 8: Deploy Script & Documentation (Week 4)

### 8.1 Deployment Script

- [ ] Create `scripts/deploy.sh`:
  ```bash
  #!/bin/bash
  set -e
  
  echo "Building frontend..."
  cd apps/web && npm run build
  
  echo "Building API..."
  cd ../api && npm run build
  
  echo "Running migrations..."
  psql $DATABASE_URL < ../../docker/postgres/init/001_schema.sql
  
  echo "Restarting services..."
  systemctl restart sitelayer-api
  systemctl reload nginx
  
  echo "Deploy complete!"
  ```
- [ ] Make executable: `chmod +x scripts/deploy.sh`

**Output:** One-command deploy

### 8.2 Setup Documentation

- [ ] Create `PILOT_RUNBOOK.md`:
  - [ ] How to SSH into Droplet
  - [ ] How to check logs (`journalctl`, nginx logs)
  - [ ] How to run migrations
  - [ ] How to scale infrastructure
  - [ ] Troubleshooting guide (common issues)

**Output:** Documentation for future deploys

---

## Phase 9: Pilot Customer Onboarding (Week 5)

### 9.1 Create Test Company in Clerk

- [ ] In Clerk dashboard, create organization: `Pilot Company Inc`
- [ ] Invite pilot customer contact as `owner`
- [ ] Create a second user (your admin) as `admin`

**Output:** Test company ready to log in

### 9.2 Create First Project

- [ ] Log in as pilot customer
- [ ] Create project via API:
  ```bash
  curl -X POST https://yourdomain.com/api/projects \
    -H "Content-Type: application/json" \
    -H "x-sitelayer-company-slug: pilot-company-inc" \
    -d '{"name": "Renovation Project", "customer_name": "Acme Corp"}'
  ```
- [ ] Verify project appears in Dashboard

**Output:** Project created, visible in UI

### 9.3 Test End-to-End

- [ ] Upload a sample blueprint PDF
- [ ] Draw a polygon annotation
- [ ] Save and refresh — annotation persists
- [ ] Start QBO OAuth flow (test in sandbox first)
- [ ] Create an estimate from annotation
- [ ] Check Sentry for any errors

**Output:** Complete workflow tested

---

## Weekly Checklist

### Week 1: Infrastructure & Auth
- [ ] DO account, Droplet, DB, Spaces configured
- [ ] Clerk org model set up
- [ ] Domain DNS working
- [ ] Postgres schema deployed
- [ ] API and frontend deploy on Droplet

### Week 2: Canvas & Upload
- [ ] PDF.js renders blueprint
- [ ] Konva layer draws polygons
- [ ] Blueprint upload to Spaces working
- [ ] Annotations persist to DB
- [ ] SSL/TLS certificate installed

### Week 3: QBO & Observability
- [ ] QBO OAuth flow complete (sandbox test)
- [ ] Hatchet running on Droplet
- [ ] Sentry capturing errors
- [ ] UptimeRobot monitoring critical endpoints
- [ ] Logs accessible via SSH

### Week 4: Polish & Docs
- [ ] Deploy script automated
- [ ] Runbook documented
- [ ] Tested full redeploy from scratch
- [ ] All error paths tested

### Week 5: Pilot Launch
- [ ] Pilot customer invited to Clerk org
- [ ] End-to-end test with real blueprint
- [ ] Support contact established
- [ ] Weekly check-in scheduled

---

## Monthly Infrastructure Cost Breakdown

| Service | Cost | Duration |
|---------|------|----------|
| DO Droplet 8GB | $48.00 | Ongoing |
| DO Backups | $9.60 | Ongoing |
| DO Postgres 1GB | $15.15 | Ongoing (upgrade to $60.90 at 5+ customers) |
| DO Spaces | $5.00 | Ongoing |
| Postmark Basic | $15.00 | Ongoing |
| GitHub Team (2) | $8.00 | Ongoing |
| Domain | ~$0.83 | Ongoing (~$10/year) |
| Clerk | $0 | Free until 50K MAU |
| Sentry | $0 | Free until 5K errors/month |
| Grafana Cloud | $0 | Free tier |
| UptimeRobot | $0 | Free tier |
| **Total** | **~$101.58/mo** | |

---

## Success Criteria for Pilot

✅ Pilot customer can log in with Google/GitHub OAuth
✅ Upload a blueprint PDF (2-10 MB)
✅ Draw a polygon measurement on blueprint
✅ Save annotation, reload page, annotation persists
✅ Push estimate to QuickBooks Online (sandbox)
✅ App responds under 2 seconds
✅ Zero downtime over 2 weeks
✅ Errors logged and visible in Sentry
✅ Customer support via email

---

## Post-Pilot: Scale to 5 Customers

- [ ] Upgrade Postgres to 4GB dedicated ($60.90/mo) to avoid noisy neighbor
- [ ] Add managed Valkey 1GB ($15/mo) for session caching
- [ ] Wire up real QBO sync workflow in Hatchet (not stub)
- [ ] Add `/api/projects/:id/summary` endpoint with labor cost calculations
- [ ] Build analytics dashboard for pilot customer
- [ ] Collect feedback and iterate

---

**Total estimated effort:** 200–280 engineer-hours (4-6 weeks at part-time)
**Total infrastructure cost:** ~$102/month (locked in until 20+ customers)
