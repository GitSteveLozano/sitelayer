# Sitelayer Critical Path to Pilot Launch

**Goal:** First customer onboarded in 4-6 weeks  
**Today:** Production and preview infrastructure are live on DigitalOcean; prod deploys use immutable registry images through GitHub Actions; Clerk, Spaces, TLS, backups, and baseline observability are wired. Blueprint uploads stream multipart through the API directly to Spaces, with presigned download URLs.
**Next:** validate live QBO sync end to end, then onboard the first pilot company.

**Mesh coordination:** project `sitelayer` / ID `282`; follow-up task chain `sitelayer-deploy-reconcile-20260423`

---

## Current Status

### ✅ Completed

- [x] Architecture documentation (CLAUDE.md)
- [x] Tech stack evaluation (Node.js plain HTTP, React SPA, Postgres, Clerk, DO Spaces)
- [x] Pilot setup plan (PILOT_SETUP_PLAN.md)
- [x] Service checklist (SERVICES_CHECKLIST.md)
- [x] Quick-start guide (SERVICES_QUICK_START.md)
- [x] Codebase structure (monorepo with api, web, worker, domain)
- [x] Database schema (`docker/postgres/init/001_schema.sql`)
- [x] DigitalOcean production droplet provisioned (`sitelayer`, Toronto, 4 vCPU/8GB)
- [x] DigitalOcean managed Postgres provisioned (`sitelayer-db`, Postgres 18, 1 vCPU/1GB)
- [x] Reserved production IP assigned (`159.203.51.158`)
- [x] Sentry projects/DSNs captured locally
- [x] Intuit developer account/app credentials captured locally
- [x] Docker Compose production deployment path added
- [x] Stale GitHub Pages deployment workflow removed
- [x] Preview droplet provisioned and locked down to SSH from `50.71.113.46/32` plus public 80/443
- [x] Preview Traefik router installed
- [x] Shared preview DB/user created on managed Postgres
- [x] `main.preview.sitelayer.sandolab.xyz` smoke preview deployed and verified
- [x] `/app/sitelayer/.env` on production droplet with production `DATABASE_URL`
- [x] GitHub Actions `DEPLOY_HOST` and `DEPLOY_SSH_KEY`
- [x] Separate managed Postgres DB/user for production (`sitelayer_prod`, `sitelayer_prod_app`)
- [x] Deploy user public SSH key installed on production droplet
- [x] First bootable Docker Compose deploy verified at `https://sitelayer.sandolab.xyz`
- [x] Managed Postgres trusted sources restricted to production and preview droplets
- [x] Production logical backup timer installed and smoke-tested with Postgres 18 pg_dump
- [x] Production TLS enabled with Caddy and Let's Encrypt (`https://sitelayer.sandolab.xyz`)
- [x] Separate managed Postgres DB/user for dev (`sitelayer_dev`, `sitelayer_dev_app`)
- [x] Local durable blueprint upload storage via Docker volume
- [x] Takeoff polygon annotations append to DB without replacing existing measurements
- [x] Clerk auth cut over in production; unauthenticated app APIs return `401`
- [x] DO Spaces enabled in production for blueprint object storage
- [x] Blueprint upload streaming via multipart → Spaces (`apps/api/src/blueprint-upload.ts`, busboy + lib-storage); 30–80MB PDFs no longer fight the JSON body cap. Cap is `MAX_BLUEPRINT_UPLOAD_BYTES` (default 200MB).
- [x] Presigned download URL plumbing in place (`@aws-sdk/s3-request-presigner`); 302 redirect gated on `BLUEPRINT_DOWNLOAD_PRESIGNED=1` until Spaces CORS is validated for PDF.js fetches.

### ⏳ In Progress

- [ ] Live QBO sandbox/prod sync validation with real credentials.

### 🔴 Blockers for Pilot

These are configuration / validation blockers; the underlying code is shipped.

1. **Live QBO sync validation** — `mutation_outbox` + `sync_events` worker drain is unit-tested; real QBO sandbox credentials still need to be exercised end-to-end.

---

## Mandatory Services (Can't Launch Without These)

| Service                                | Current State                                              | Pilot Blocker If Broken                   |
| -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| **DigitalOcean** (Droplet, DB, Spaces) | Live prod + preview; details in `INFRASTRUCTURE_READY.md`  | Yes — hosting, database, and file storage |
| **Domain / TLS**                       | `sitelayer.sandolab.xyz` on reserved IP + Caddy            | Yes — auth redirects and customer access  |
| **Clerk**                              | Prod JWT auth configured                                   | Yes — multi-tenant login                  |
| **Intuit QBO**                         | App credentials captured; live sync still needs validation | Yes for accounting sync pilot scope       |
| **Sentry**                             | API, worker, and lazy web client wired                     | No — required for operator visibility     |
| **UptimeRobot / timer monitor**        | Baseline uptime and timer checks configured                | No — required before unattended operation |

**Current monthly cost:** see `docs/COST_AND_LIMITS.md`.

---

## Phases & Dependencies

```
PHASE 1: INFRASTRUCTURE (Week 1, Days 1-3)
├─ DigitalOcean droplet (DONE: 8GB, Ubuntu 22.04, tor1)
├─ Postgres database (DONE: 1GB managed Postgres, tor1)
├─ Reserved IP (DONE: 159.203.51.158)
├─ Spaces bucket (DONE: sitelayer-blueprints-prod, tor1, versioning enabled)
├─ Domain/DNS pointing to reserved IP (DONE: sitelayer.sandolab.xyz)
├─ Dedicated sitelayer deploy user + SSH key (DONE)
└─ `/app/sitelayer/.env` on Droplet (DONE)
   └─ Prerequisite for: all code deployment

PHASE 2: CODE CHANGES (mostly DONE)
├─ [DONE] Clerk SDK + JWT verification (apps/web/src/App.tsx, apps/api/src/auth.ts)
├─ [DONE] DigitalOcean Spaces dual-mode storage (apps/api/src/storage.ts auto-selects S3)
├─ [DONE] PDF viewer + SVG polygon annotation + server-side geometry validation
├─ [DONE] Postgres-leased queue worker (mutation_outbox + sync_events; not pg-boss)
└─ [DONE] Observability: Sentry across api/web/worker with trace propagation, Pino JSON logs

REMAINING: Streaming blueprint upload (replace base64 buffering); live QBO sandbox validation.

PHASE 3: DEPLOYMENT (DONE)
├─ Apply Postgres schema through managed DB connection
├─ Build immutable runtime image with Dockerfile and DO Container Registry
├─ Deploy via `.github/workflows/deploy-droplet.yml`
├─ Start api/web/worker/Caddy through `docker compose -f docker-compose.prod.yml`
├─ Verify public HTTPS health at `https://sitelayer.sandolab.xyz/health`
├─ Verify HTTP redirects to HTTPS
└─ Keep only ports 80/443 public
   └─ Prerequisite for: pilot launch

PHASE 4: PILOT LAUNCH (Week 3+)
├─ Create Clerk org for pilot company
├─ Invite first customer as owner
├─ End-to-end test: login → upload → annotate → sync
├─ Monitor: Sentry, UptimeRobot, logs
└─ Weekly check-in with customer
```

---

## Critical Path (Longest Chain)

1. Replace base64 JSON blueprint uploads with streaming multipart to Spaces.
2. Serve blueprint downloads through presigned URLs instead of API-buffered payloads.
3. Validate QBO OAuth, token refresh, and worker-drained sync with sandbox credentials.
4. Provision first pilot company, Clerk org/memberships, and QBO mapping.
5. Run pilot smoke: login → upload large blueprint → annotate → estimate → sync.

**Parallelizable:** QBO validation can proceed while the blueprint streaming path is implemented.

---

## Week-by-Week Timeline

### Week 1

- **Days 1-2:** Infrastructure setup (DO, Domain, Clerk, Intuit)
- **Days 3-4:** Code changes 1-3 (Clerk auth, DO Spaces, PDF viewer)
- **Day 5:** Deployment to Droplet + initial testing

### Week 2

- **Days 1-3:** Code changes 4-5 (Job queue, observability) + refinement
- **Days 4-5:** Full end-to-end test (upload → annotate → sync simulation)

### Week 3

- **Days 1-2:** QBO sandbox integration testing
- **Days 3-5:** Pilot customer prep + onboarding

### Weeks 4-6

- **Weekly check-ins** with customer
- **Bug fixes** as they arise
- **Iterate** on UX based on feedback

---

## Success Criteria (Must Have Before Pilot)

- [x] Clerk OAuth working (customer can sign in with Google)
- [x] Local blueprint upload persistence working (PDF persists in Docker volume)
- [x] Blueprint upload to Spaces/off-host object storage working for current JSON-size limit
- [x] PDF viewer + polygon drawing implemented (user can annotate)
- [x] Annotations save to DB through append endpoint
- [ ] API responds in <500ms for pilot-critical flows under real blueprint/QBO load
- [x] Caddy reverse proxy working (`https://sitelayer.sandolab.xyz` returns app/API)
- [x] Postgres logical backups automated and restore-drilled
- [ ] UptimeRobot green (all monitors passing)
- [ ] QBO OAuth flow working (sandbox test)
- [x] Worker processes queue reliably with Postgres leases
- [x] Logs accessible via SSH / Docker Compose logs

---

## Cost Breakdown (Month 1 + Year 1)

### Month 1 (Pilot Setup)

- DO Droplet 8GB: $48
- DO Backups: $9.60
- DO Postgres 1GB: $15.15
- DO Spaces: $5
- Domain (prorated): ~$1
- Clerk: $0 (free)
- Sentry: $0 (free)
- UptimeRobot: $0 (free)
- Postmark (optional): $15
- **Total:** ~$93.75 (or ~$108.75 with email)

### Year 1 (12 months of pilot)

- Infrastructure: ~$102/mo × 12 = ~$1,224
- Domain: ~$10/year
- **Total:** ~$1,234

### Post-Pilot (5 customers)

- Upgrade Postgres 4GB: $60.90/mo
- Add Valkey cache: $15/mo
- Postmark Basic: $15/mo (if not already)
- **New total:** ~$193/mo

---

## Key Decision Points

### 1. Job Queue: pg-boss vs Hatchet?

**Recommendation:** **pg-boss** for MVP (free, Postgres-native, lightweight)

**When to migrate:** Post-pilot, once you need:

- Workflow orchestration (not just queue)
- Distributed execution (multiple workers)
- Audit trail of job executions
- Then evaluate Hatchet ($0 for lite, $$$ for cloud)

### 2. Auth: Clerk vs Auth0 vs DIY?

**Recommendation:** **Clerk** (multi-tenant built-in, no-code orgs)

**Cost at scale:**

- Pilot: Free
- 100 users: ~$20/mo
- 1000 users: ~$100/mo

### 3. Monitoring: Sentry vs DataDog vs Axiom?

**Recommendation:** **Sentry** for now (free until 5K events/month)

**Upgrade path:**

- If errors > 5K/month: Consider Axiom ($20/mo) or DataDog ($100+/mo)
- But unlikely at pilot scale

---

## Go/No-Go Decision Gates

### Gate 1: End of Week 1

**Question:** Can we deploy app to Droplet and see homepage?  
**Criterion:** `curl https://yourdomain.com` returns HTML  
**If No:** Fix deployment issues (Caddy config, DNS, SSL cert)  
**If Yes:** Proceed to code changes

### Gate 2: End of Week 2

**Question:** Can customer sign in and upload a blueprint?  
**Criterion:** Clerk OAuth works + DO Spaces has blueprint file  
**If No:** Debug auth or file upload  
**If Yes:** Proceed to annotation UI

### Gate 3: End of Week 3

**Question:** Does full workflow work end-to-end without errors?  
**Criterion:** Sentry shows zero errors in pilot user session  
**If No:** Fix critical bugs, defer QBO sync  
**If Yes:** Invite pilot customer

---

## Immediate Action Items

- [x] **Create:** `sitelayer_prod` and `sitelayer_dev` DBs plus separate app users on existing managed Postgres.
- [x] **Install:** deployment public key for `sitelayer` user on droplet.
- [x] **Set:** GitHub Actions `DEPLOY_HOST` and `DEPLOY_SSH_KEY`.
- [x] **Create:** `/app/sitelayer/.env` on droplet with `DATABASE_URL` and optional integration placeholders.
- [x] **Deploy:** run the GitHub Actions droplet workflow once.
- [x] **Tighten:** remove public firewall port 3000 if no temporary service needs it.
- [ ] **Decide:** same droplet dev deploy vs separate small dev droplet before exposing `sitelayer_dev`.
- [ ] **Implement:** streaming blueprint upload / presigned download before large pilot PDFs.
- [ ] **Validate:** live QBO sandbox sync and production token refresh path.

---

## Documentation Reference

| Document                    | Purpose                                           | Audience          |
| --------------------------- | ------------------------------------------------- | ----------------- |
| **CLAUDE.md**               | Architecture, tech decisions, migration roadmap   | You + future team |
| **PILOT_SETUP_PLAN.md**     | Detailed 9-phase plan with exact commands         | Deployment guide  |
| **SERVICES_CHECKLIST.md**   | Comprehensive checklist for all services + config | Verification      |
| **SERVICES_QUICK_START.md** | TL;DR for setup (7 services, 5 code changes)      | Quick reference   |
| **CRITICAL_PATH.md**        | This document — timeline, decisions, gates        | Project planning  |

---

## Questions Before You Start?

1. **DO region:** Toronto (TOR1) only? Or fallback to US-East?
2. **Domain:** Do you have a name picked (sitelayer.com, siterecon.com)?
3. **Clerk:** Should we pre-configure Google OAuth + GitHub OAuth for team access?
4. **Pilot customer:** Do you have a real construction company ready, or testing with fake data?
5. **Timeline:** Can you dedicate 20+ hours/week to get to Week 3 launch?

---

**Next call:** Once you've signed up for DigitalOcean and gotten Droplet IP, we can start the deployment.
