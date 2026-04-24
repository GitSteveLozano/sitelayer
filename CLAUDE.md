# Sitelayer

Construction operations platform: blueprint takeoff, estimation, crew scheduling, and QBO sync.

## Agent Coordination Source of Truth

**Last reconciled:** 2026-04-23

**Mesh project:** `sitelayer` / project ID `282`

**Open Mesh deployment task chain:** `sitelayer-deploy-reconcile-20260423`

This repo has historical planning docs that drift from the current deployment state. Use this order of authority:

1. Live code and checked-in deployment files.
2. Mesh planning/runtime records for project `sitelayer`.
3. `DEPLOYMENT.md` and `INFRASTRUCTURE_READY.md`.
4. Historical docs in `docs/`, `PILOT_SETUP_PLAN.md`, `SERVICES_*`, and older planning notes.

When an agent changes architecture, deployment, secrets layout, external services, or infrastructure:

- Add a Mesh planning note with `project=sitelayer`.
- Upsert affected Mesh runtime dependencies.
- Patch the relevant repo doc in the same turn.
- Do not rely on old prose in historical docs if it disagrees with live code.

Current Mesh runtime dependencies recorded for `sitelayer` as of `list_runtime_deps` on 2026-04-23:

- `postgres/sitelayer-db`
- `env_file/production-env`
- `docker_container/production-compose-stack`
- `port/public-http`
- `port/preview-ssh-restricted`
- `port/droplet-public-3000-followup`
- `build_cmd/production-docker-build`

These are currently tracked as deployment verification items, not global task blockers. After the first successful droplet deploy, promote the production-critical deps to required in Mesh.

Preview state is documented in this repo and in Mesh planning notes, but the runtime dependency rows still need reconciliation. Runtime-dep upserts for the preview DB/router/shared env/main stack were blocked by the tool guard in this session. Retry in a clean context for:

- `postgres/sitelayer-preview-db`
- `env_file/preview-shared-env`
- `docker_container/preview-router-traefik`
- `docker_container/preview-main-stack`
- `port/preview-http-https`
- `build_cmd/preview-docker-build`

GitHub preview automation: self-hosted runner `sitelayer-preview` is registered on the preview droplet. Service `actions.runner.GitSteveLozano-sitelayer.sitelayer-preview.service` is active/enabled and runner logs show `Listening for Jobs`. Current `taylorSando` API access still cannot list repo runners (`403`), so use host service status/logs as verification unless repo runner-management permission is added.

Runner package state: `/home/sitelayer/actions-runner` exists on `sitelayer-preview` with actions runner `2.333.1` unpacked and configured.

## Current Infrastructure Snapshot

**Verified with `doctl` and production smoke checks on 2026-04-24.**

| Resource | Current State |
|----------|---------------|
| Production droplet | `sitelayer`, ID `566798325`, Ubuntu 22.04, Toronto `tor1`, 4 vCPU, 8GB RAM, public IPv4 `165.245.230.3` |
| Reserved production IP | `159.203.51.158`, assigned to droplet `566798325` |
| Preview droplet | `sitelayer-preview`, ID `566806040`, Ubuntu 22.04, Toronto `tor1`, 2 vCPU, 4GB RAM, reserved IPv4 `159.203.53.218` |
| Managed Postgres | `sitelayer-db`, ID `9948c96b-b6b6-45ad-adf7-d20e4c206c66`, Postgres 18, `db-s-1vcpu-1gb`, Toronto `tor1`, online |
| Managed Postgres databases | `defaultdb`, `sitelayer_prod`, `sitelayer_preview`; create separate `sitelayer_dev` before dev deploys mutate data |
| Managed Postgres trusted sources | Droplet `566798325` (`sitelayer`) and droplet `566806040` (`sitelayer-preview`) |
| Production deploy path | GitHub Actions runs on the self-hosted `sitelayer-preview` runner, SSHs to `sitelayer@10.118.0.4`, deploys `/app/sitelayer` with Docker Compose, `.env` at `/app/sitelayer/.env` |
| Preview deploy path | `docker-compose.preview.yml` behind Traefik on `sitelayer-preview`; shared env at `/app/previews/.env.shared`; smoke stack at `main.preview.sitelayer.sandolab.xyz` |
| Public HTTP | Containerized nginx on port 80; HTTPS is not enabled in committed compose/nginx until certs are provisioned |
| Backups | DO managed Postgres automatic backups exist; independent logical backup scripts are added and production timer uses `postgres:18-alpine` pg_dump |
| Optional integrations | Clerk, DigitalOcean Spaces, QBO, and Sentry can stay blank/placeholders for bootable deploy; `DATABASE_URL` is the hard requirement |

Security note: the deploy user is in the Docker group. That avoids root SSH but Docker access is root-equivalent. Treat `DEPLOY_SSH_KEY` as production-root-equivalent.

## Architecture Overview

Three-layer architecture designed to decouple external integrations (QBO, Clerk) from core domain logic:

```
Layer 1: Source Connectors
  └─ QBO OAuth integration, sync state tracking

Layer 2: Normalized Operational Model  
  └─ Domain types, business logic, accounting mapping

Layer 3: Derived Insight & Workflow UI
  └─ React SPA, background job processor
```

### Tech Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| **Backend** | Node.js (plain http module) + Postgres | No framework; minimal HTTP server |
| **Frontend** | React 19 + Vite SPA | Client-side only; no SSR |
| **Worker** | Node.js background tasks | Inline in monorepo; no Hatchet yet |
| **Monorepo** | npm workspaces | apps: api, web, worker; packages: domain |
| **Database** | Postgres (pg driver) | Direct SQL queries in server.ts; no ORM |
| **Auth** | TBD (hardcoded demo user) | Clerk planned but not yet integrated |
| **File Storage** | TBD (DigitalOcean Spaces planned) | Blueprint PDFs not yet persisted to external storage |
| **QBO Integration** | OAuth + REST API (direct HTTP) | Connector layer; sync state in `integration_mappings` table |

## Project Structure

```
sitelayer/
├── apps/
│   ├── api/                 # Backend HTTP server (2917 lines)
│   ├── web/                 # Frontend React SPA (2444 lines)
│   └── worker/              # Background job processor
├── packages/
│   └── domain/              # Shared types, business logic, constants
├── docker/
│   └── postgres/init/       # Schema initialization
├── docs/                    # Architecture, requirements, findings
└── PILOT_SETUP_PLAN.md      # 9-phase deployment checklist (4-6 week pilot)
```

## Core Components

### Backend (apps/api/src/server.ts)

- **HTTP Server**: Plain Node.js `http` module; no framework overhead
- **Routing**: Manual request parsing; CORS handling for frontend/worker origins
- **Database**: Direct pg client queries; no ORM
- **Dependencies**: Only `pg` and `@sitelayer/domain`

**Endpoints**:
- POST `/projects` — create project
- GET `/projects` — list projects  
- POST `/projects/:id/blueprints` — upload blueprint PDF
- GET `/blueprints/:id` — retrieve blueprint metadata
- POST `/annotations` — save polygon measurements
- GET `/estimates/:id` — retrieve estimate (calculates on-demand)
- POST `/integrations/qbo/connect` — OAuth initiation
- POST `/integrations/qbo/sync` — trigger full sync job
- GET `/integrations/status` — sync state

**Environment Variables**:
```
PORT=3001
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer
ACTIVE_COMPANY_SLUG=la-operations        # Hardcoded tenant demo
ACTIVE_USER_ID=demo-user                 # Hardcoded user
QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI
QBO_ENVIRONMENT=sandbox|production
ALLOWED_ORIGINS=http://localhost:5173,...
```

### Frontend (apps/web/src/App.tsx)

- **React 19 SPA**: No Next.js, no SSR; pure client-side
- **Build**: Vite dev server @ `0.0.0.0:3000` during dev
- **State**: IndexedDB for offline-first (recent addition)
- **UI Components**: Konva.js for PDF canvas annotation (not yet in dependencies, imported inline)
- **Storage**: LocalStorage for drafts, IndexedDB for offline queue

**Key Views**:
- Projects dashboard
- Blueprint upload + PDF viewer
- Polygon annotation layer
- Estimate preview
- Integration status

### Domain Layer (packages/domain/src/index.ts)

Shared type definitions and business logic:

```typescript
export interface Company { id, slug, name, created_at }
export interface Division { id, name, rate_standard, rate_overtime, ... }
export interface Project { id, name, customer_id, divisions, created_at, ... }
export interface Takeoff { id, description, quantity, division_id, ... }
export interface Estimate { id, project_id, line_items, total_labor, total_material, ... }
export interface Worker { id, name, email, ... }
export interface LabourEntry { id, worker_id, project_id, hours, rate, ... }
export const DEFAULT_BONUS_RULE = { min_revenue, bonus_percentage, ... }
export const LA_TEMPLATE = { divisions: [...], items: [...] } // PreLoaded LA Operations template
export const calculateMargin = (revenue, cost) => (revenue - cost) / revenue
export const calculateProjectCost = (takeoffs, divisions) => ...
export const calculateBonusPayout = (revenue, cost, rule) => ...
```

### Worker (apps/worker/src/worker.ts)

Background job processor (currently minimal):
- QBO sync orchestration
- Blueprint PDF processing
- Estimate generation

### Database Schema

**Core Tables**:
- `companies` — multi-tenant isolation
- `users` — user accounts  
- `projects` — construction projects (customer, location, divisions)
- `blueprints` — uploaded PDF documents with S3/Spaces reference
- `takeoffs` — measurements extracted from blueprints (description, qty, division)
- `estimates` — calculated estimates with line items (labor, material, overhead)
- `workers` — crew roster
- `labor_entries` — time tracking
- `integration_mappings` — external system references (QBO customer ID → local project ID, etc.)
- `sync_state` — last sync timestamp, pending changes, error log

**Source of Truth Rules**:
- **QBO Authoritative**: Customer, division, service item definitions
- **Sitelayer Authoritative**: Measurements, schedules, labor entries, costing

## Architectural Decisions

### 1. **No Framework (Plain Node.js HTTP)**

**Decision**: Use only Node.js core `http` module; no Express/Fastify/Hono.

**Rationale**:
- Minimal startup overhead for containerized deployment
- Direct control over request handling
- Easier to reason about CORS, auth middleware
- Can add routing/middleware incrementally as complexity grows

**Tradeoff**: Manual routing, middleware composition, no built-in validation.

**Assessment**: ✅ **Appropriate for MVP**. Fine up to ~50 endpoints. Beyond that, consider Fastify (lightweight, TypeScript-first, similar to raw Node but with convenient abstractions).

### 2. **React SPA (No Next.js, No SSR)**

**Decision**: Pure client-side React 19 with Vite bundler.

**Rationale**:
- Construction crews use this on-site with intermittent connectivity
- Offline-first priority (IndexedDB queue for sync when online)
- Simple deployment (static build artifacts)
- Avoids Node.js server overhead in field environments

**Tradeoff**: No server-side rendering, SEO not applicable, larger JS bundle.

**Assessment**: ✅ **Correct for this use case**. On-site/offline requirement rules out server-side rendering. Next.js would add complexity without benefit.

### 3. **Direct SQL in Server.ts**

**Decision**: All database queries written as string SQL directly in handler functions.

**Rationale**:
- Transparent, reviewable queries
- No ORM initialization overhead
- Type-safe via TypeScript if using pg client correctly
- Easier to profile and debug

**Tradeoff**: String interpolation risks SQL injection; verbose; no query builder abstractions; schema changes require code edits.

**Recommendation**: ⚠️ **Unsustainable beyond 100 queries**. At ~500 queries per pilot, already at threshold. Consider:
- **Option A** (Minimal): Migrate to Postgres.js (same client, better ergonomics, typed queries)
- **Option B** (Recommended): Introduce Drizzle or Prisma when schema stabilizes post-pilot
- **Option C** (Overkill): Pair Node.js with Temporal.io for workflow + transactional guarantees

### 4. **Monorepo with npm Workspaces**

**Decision**: Single repository with apps (api, web, worker) and packages (domain).

**Rationale**:
- Shared domain types across backend, frontend, worker
- Single deploy pipeline
- Coordinated schema + API + UI changes

**Assessment**: ✅ **Correct for this team size**. npm workspaces is lightweight; no need for Nx/Turbo at pilot stage.

### 5. **IndexedDB for Offline-First**

**Decision**: LocalStorage + IndexedDB queue for offline capture, sync when online.

**Rationale**:
- Construction sites have unreliable connectivity
- Allow crews to capture measurements offline
- Sync queue when connection restored

**Assessment**: ✅ **Good for field operations**. Correctly prioritizes offline UX.

## Technology Research & Alternatives

### Backend Framework

**Current**: Plain Node.js http module  
**Verdict**: ✅ OK for MVP; plan migration to Fastify/Hono before 500+ endpoints

| Framework | Upside | Downside | Fit for Sitelayer |
|-----------|--------|---------|-------------------|
| **Fastify** | Lightweight, TypeScript-first, schema validation, streaming | Smaller ecosystem than Express | ✅ Best choice for post-pilot |
| **Hono** | Minimal footprint, edge-first, great types | Very new; less mature | 🟡 Alternative if edge deployment needed |
| **Express** | Largest ecosystem, mature | Heavy middleware pattern; bloated | ❌ Avoid; contradicts minimal approach |
| **Nest.js** | Full framework, dependency injection | Opinionated; adds layer of indirection | ❌ Overkill for this domain |

**Recommendation**: If you must pick a framework now, choose **Fastify**. It fills the gap between raw Node and Express without the bloat. But plain http is defensible for the next 3 months.

### Frontend Framework

**Current**: React 19 + Vite  
**Verdict**: ✅ Correct choice; no change needed

| Framework | Upside | Downside | Fit for Sitelayer |
|-----------|--------|---------|-------------------|
| **React 19** | Latest hooks, stable, largest ecosystem | Largest bundle size | ✅ Good choice |
| **Svelte** | Smallest bundle, great ergonomics | Smaller ecosystem | 🟡 Viable if bundle size critical |
| **Solid.js** | Fine-grained reactivity, small | Still young; smaller community | 🟡 Not worth risk |
| **Vue 3** | Balanced, good for forms | Smaller US community | 🟡 OK but React better for team |

**Recommendation**: Stay with React. It's the safe, productive choice. Vite is already excellent.

### Database ORM / Query Layer

**Current**: Direct pg client SQL strings  
**Verdict**: ⚠️ OK for now; **must migrate by post-pilot**

| Tool | Upside | Downside | Fit for Sitelayer |
|------|--------|---------|-------------------|
| **Prisma** | Best DX, auto-migrations, type-safe | Runtime overhead, lock-in to schema.prisma | ✅ Recommended |
| **Drizzle** | Lightweight, fully typed, SQL-in-TS | Smaller ecosystem | ✅ Alternative if performance critical |
| **Postgres.js** | Drop-in pg replacement, typed queries | Still manual composition | 🟡 Bridge solution, not long-term |
| **Raw pg** | Total control, transparent | String concatenation risks | ❌ Don't scale this |

**Recommendation**: Plan **Prisma migration** before production. It gives you:
- Type safety for queries
- Auto-migration generation from schema changes
- Clear schema-of-record (schema.prisma)
- Generator plugins for seed data

### Authentication

**Current**: Hardcoded demo user  
**Verdict**: 🔴 **Must implement before pilot**

| Solution | Upside | Downside | Fit for Sitelayer |
|----------|--------|---------|-------------------|
| **Clerk** | Multi-tenant orgs, RBAC, webhooks | Per-action pricing (~$0.02 per user) | ✅ Matches requirements |
| **Auth0** | Mature, flexible rules | Higher pricing than Clerk | 🟡 More expensive |
| **Supabase Auth** | Open-source, free tier exists | Limited multi-tenant features | 🟡 OK for single-tenant MVP |
| **NextAuth.js** | Self-hosted, flexible | OAuth provider setup overhead | 🟡 Consider if avoiding third-party |

**Recommendation**: **Integrate Clerk before pilot** (required for multi-tenant demo). Estimated cost: ~$20-50/month for pilot scale.

### File Storage

**Current**: Not implemented (hardcoded "demo" placeholder)  
**Verdict**: 🔴 **Blocker for MVP**

| Service | Upside | Downside | Cost | Fit |
|---------|--------|---------|------|-----|
| **DigitalOcean Spaces** | $5/mo, 250GB included, S3-compatible | Smaller ecosystem | $5-15/mo | ✅ Planned choice |
| **AWS S3** | Industry standard, mature | Per-request pricing, more complex setup | $10+/mo | 🟡 Overkill for MVP |
| **Supabase Storage** | Built on S3, PostgreSQL-native | Different S3 endpoint | ~$10/mo | 🟡 Adds dependency |
| **Cloudinary** | Image optimization built-in | Per-request pricing, vendor lock-in | $10+/mo | ❌ Overkill for PDFs |

**Recommendation**: **Use DigitalOcean Spaces** as planned ($5/mo, S3-compatible, simple setup). Implement before first pilot customer.

### Background Jobs

**Current**: Inline worker.ts (not yet hooked to actual job queue)  
**Verdict**: 🔴 **Needs implementation**

| Solution | Upside | Downside | Cost | Fit |
|----------|--------|---------|------|-----|
| **Hatchet** | Purpose-built for workflows, no infra | Pricing TBD (currently free) | Free? | ✅ Planned choice |
| **Bull** (Redis) | Lightweight, mature | Need Redis instance | $0-15/mo | 🟡 Works, adds Redis |
| **Postgres pg-boss** | No external dep, uses your DB | Less mature than Bull, slower | $0 | 🟡 Simpler for MVP |
| **Temporal.io** | Enterprise-grade, durable | Significant overhead, learning curve | $0 (OSS) | ❌ Too much for MVP |

**Recommendation**: For pilot, use **pg-boss** (Postgres-native, no Redis, free). Migrate to Hatchet post-pilot if you need deeper workflow orchestration.

### Monitoring & Observability

**Current**: None (logging via console.log)  
**Verdict**: 🟡 **OK for pilot, implement post-MVP**

| Solution | Upside | Downside | Cost |
|----------|--------|---------|------|
| **Sentry** | Error tracking, release tracking | Third-party, pricing per event | $20-50/mo |
| **DataDog** | Metrics + logs + traces | Expensive, steep learning curve | $100+/mo |
| **Axiom** | Log aggregation, good DX | Newer, smaller ecosystem | $20/mo |
| **Logdna** | Simple log management | Limited structured query | $15/mo |

**Recommendation**: **Defer Sentry until post-MVP**. For now, use structured logging to stdout (JSON logs), which your Docker host can aggregate.

## Pending Infrastructure & Setup

### Phase 1 — Environment & Secrets (Week 1, Day 1-2)

- [ ] Domain registration (sitelayer.{local|site})
- [ ] DigitalOcean Spaces bucket (`sitelayer-blueprints`)
- [ ] DigitalOcean database (Postgres 15+, 1GB RAM minimum)
- [ ] Clerk organization setup + OAuth credentials
- [ ] Environment file (`.env.local`)
- [ ] Docker Compose: api + web + postgres + redis-equivalent (pg-boss)

### Phase 2 — Initial Deployment (Week 1, Day 3-5)

- [ ] Build Docker images (api, web, worker)
- [ ] Postgres schema migration
- [ ] Seed data (LA Operations template)
- [ ] Test QBO OAuth flow (sandbox)
- [ ] Test blueprint upload → Spaces

### Phase 3 — Pilot Customer Onboarding (Week 2+)

- [ ] Hardcode first customer in schema
- [ ] Train on crew scheduling + labor entry
- [ ] Daily sync with QBO
- [ ] Weekly business review

## Migration Roadmap (Post-Pilot)

**When**: After first customer completes 2-4 week pilot

1. **Prisma Integration** (1 week)
   - Migrate schema.prisma from SQL
   - Auto-generate migrations
   - Type-safe queries
   
2. **Clerk Auth** (1 week)
   - Replace hardcoded demo user
   - Per-company isolation
   - RBAC for crew vs. admin
   
3. **Sentry + Axiom** (3 days)
   - Error tracking
   - Structured logging
   
4. **Hatchet Evaluation** (1 week research)
   - Assess QBO sync reliability with pg-boss
   - Plan migration if needed
   
5. **Fastify Migration** (2 weeks, optional)
   - Only if endpoint count > 200 and code smell
   - Low priority; raw Node.js still fine

## Open Questions

1. **PDF Processing**: How are blueprints being processed today? (cropped, rotated, stored)
   - [ ] Investigate PDF.js + canvas rendering pipeline
   - [ ] Determine if ImageMagick/Ghostscript needed server-side

2. **QBO Sync Strategy**: Append-only events or full-sync nightly?
   - Current: Sketch includes bidirectional sync (estimate → invoice)
   - Need to decide: pull customer/items nightly, or push estimates as drafted?

3. **Multi-tenancy Row Security**: RLS policies in Postgres or app-level filtering?
   - Current: `ACTIVE_COMPANY_SLUG` env var (hardcoded demo)
   - Post-pilot: Need to implement per-user company isolation

4. **Offline Sync Conflict Resolution**: What if crew edits measurement both online and offline?
   - Current: IndexedDB queue (FIFO)
   - Need: Last-write-wins vs. manual resolution UI

## References

- **Domain Model**: See `packages/domain/src/index.ts`
- **Requirements**: See `docs/REQUIREMENTS_SPEC.md`
- **Deployment Plan**: See `PILOT_SETUP_PLAN.md`
- **QBO Integration**: See `docs/QBO_EXTRACTION_CANONICAL_REFERENCE.md`
- **Greenfield Architecture**: See `docs/GREENFIELD_ARCHITECTURE_PLAN.md`
