# Sitelayer

Construction operations platform: blueprint takeoff, estimation, crew scheduling, and QBO sync.

## Agent Coordination Source of Truth

**Last reconciled:** 2026-04-25

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

Current Mesh runtime dependencies recorded for `sitelayer` as of 2026-04-24:

- `postgres/sitelayer-db`
- `env_file/production-env`
- `docker_container/production-compose-stack`
- `port/public-http`
- `port/preview-ssh-restricted`
- `port/droplet-public-3000-followup`
- `build_cmd/production-docker-build`
- `docker_container/tiered-object-storage`
- `env_file/app-tier-isolation`
- `postgres/sitelayer-preview-db`
- `env_file/preview-shared-env`
- `docker_container/preview-router-traefik`
- `docker_container/preview-main-stack`
- `port/preview-http-https`
- `build_cmd/preview-docker-build`

These are deployment verification/runtime records. Treat production-critical rows as required evidence when changing infra, deploy, storage, auth, or observability.

Preview state is documented in this repo and Mesh runtime dependencies. Runtime-dep rows were reconciled on 2026-04-24 for:

- `postgres/sitelayer-preview-db`
- `env_file/preview-shared-env`
- `docker_container/preview-router-traefik`
- `docker_container/preview-main-stack`
- `port/preview-http-https`
- `build_cmd/preview-docker-build`

GitHub preview automation: self-hosted runner `sitelayer-preview` is registered on the preview droplet. Service `actions.runner.GitSteveLozano-sitelayer.sitelayer-preview.service` is active/enabled and runner logs show `Listening for Jobs`. Current `taylorSando` API access still cannot list repo runners (`403`), so use host service status/logs as verification unless repo runner-management permission is added.

Runner package state: `/home/sitelayer/actions-runner` exists on `sitelayer-preview` with actions runner `2.333.1` unpacked and configured.

## Current Infrastructure Snapshot

**Verified with `doctl` and production smoke checks on 2026-04-25.**

| Resource                         | Current State                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production droplet               | `sitelayer`, ID `566798325`, Ubuntu 22.04, Toronto `tor1`, 4 vCPU, 8GB RAM, public IPv4 `165.245.230.3`                                                                                                                                 |
| Reserved production IP           | `159.203.51.158`, assigned to droplet `566798325`                                                                                                                                                                                       |
| Preview droplet                  | `sitelayer-preview`, ID `566806040`, Ubuntu 22.04, Toronto `tor1`, 2 vCPU, 4GB RAM, reserved IPv4 `159.203.53.218`                                                                                                                      |
| Managed Postgres                 | `sitelayer-db`, ID `9948c96b-b6b6-45ad-adf7-d20e4c206c66`, Postgres 18, `db-s-1vcpu-1gb`, Toronto `tor1`, online                                                                                                                        |
| Managed Postgres databases       | `defaultdb`, `sitelayer_prod`, `sitelayer_preview`, `sitelayer_dev`                                                                                                                                                                     |
| Managed Postgres trusted sources | Droplet `566798325` (`sitelayer`) and droplet `566806040` (`sitelayer-preview`)                                                                                                                                                         |
| Production deploy path           | GitHub Actions runs on the self-hosted `sitelayer-preview` runner, SSHs to `sitelayer@10.118.0.4`, deploys `/app/sitelayer` with Docker Compose, `.env` at `/app/sitelayer/.env`                                                        |
| Preview deploy path              | `docker-compose.preview.yml` behind Traefik on `sitelayer-preview`; shared env at `/app/previews/.env.shared`; smoke stack at `main.preview.sitelayer.sandolab.xyz`                                                                     |
| Public edge                      | Containerized Caddy on ports 80/443; automatic Let's Encrypt TLS for `sitelayer.sandolab.xyz`; HTTP redirects to HTTPS                                                                                                                  |
| Backups                          | DO managed Postgres automatic backups exist; logical Postgres backup, Postgres off-host copy, blueprint-volume fallback copy, restore-drill, and timer-monitor timers are active                                                        |
| Object storage                   | DO Spaces bucket `sitelayer-blueprints-prod` in `tor1`, versioning enabled, scoped prod read/write key in `/app/sitelayer/.env`                                                                                                         |
| Container registry               | DO Container Registry `sitelayer` in `tor1`; production deploy promotes `registry.digitalocean.com/sitelayer/sitelayer:<git-sha>`                                                                                                       |
| Optional integrations            | QBO credentials can stay blank until live sync validation; Sentry can stay blank but is wired for api/worker/web when DSNs are present. Prod API boot requires auth config, `API_METRICS_TOKEN`, Spaces credentials, and `DATABASE_URL` |

Security note: the deploy user is in the Docker group. That avoids root SSH but Docker access is root-equivalent. Treat `DEPLOY_SSH_KEY` as production-root-equivalent.

Database migrations use `scripts/migrate-db.sh`; schema readiness uses `scripts/check-db-schema.sh`. Production deploy builds and pushes an immutable registry image, pulls that exact tag on the droplet, takes a pre-migration logical backup, then runs both before replacing containers. The runner records checksums in `schema_migrations`; add new SQL files instead of editing applied migrations. For local Docker verification without exposing Postgres on the host, run with `PSQL_DOCKER_NETWORK=sitelayer_default DATABASE_URL=postgres://sitelayer:sitelayer@db:5432/sitelayer`.

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

| Component           | Technology                                                 | Notes                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Backend**         | Node.js (plain http module) + Postgres                     | No framework; minimal HTTP server                                                                                                                                                                                                                                  |
| **Frontend**        | React 19 + Vite SPA                                        | Client-side only; no SSR                                                                                                                                                                                                                                           |
| **Worker**          | Node.js background tasks                                   | Postgres-backed leased queue; no Hatchet yet                                                                                                                                                                                                                       |
| **Monorepo**        | npm workspaces                                             | apps: api, web, worker; packages: config, domain, logger, queue                                                                                                                                                                                                    |
| **Database**        | Postgres (pg driver)                                       | Direct SQL queries in server.ts; no ORM                                                                                                                                                                                                                            |
| **Auth**            | Clerk wired in SPA + JWT verification in API; gated by env | `apps/web/src/App.tsx` runs SignIn/SignUp; `apps/api/src/auth.ts` verifies Clerk JWTs when `CLERK_JWT_KEY` is set. Header fallback to `ACTIVE_USER_ID=demo-user` is still active until `AUTH_ALLOW_HEADER_FALLBACK=0` and `CLERK_JWT_KEY` are configured per tier. |
| **File Storage**    | Dual-mode shipped: local FS or DigitalOcean Spaces         | `apps/api/src/storage.ts` auto-selects `S3Storage` when `DO_SPACES_BUCKET/KEY/SECRET` are set, otherwise local FS at `BLUEPRINT_STORAGE_ROOT`. Default region `tor1`.                                                                                              |
| **QBO Integration** | OAuth + REST API (direct HTTP)                             | Connector layer; sync state in `integration_mappings` table                                                                                                                                                                                                        |
| **Observability**   | Sentry v10 + Pino                                          | Trace propagation through API/worker; web Sentry and web-vitals are idle/lazy loaded; request-scoped JSON logs via `@sitelayer/logger`                                                                                                                             |

## Project Structure

```
sitelayer/
├── apps/
│   ├── api/                 # Backend HTTP server (apps/api/src/server.ts)
│   ├── web/                 # Frontend React SPA (apps/web/src/App.tsx)
│   └── worker/              # Background job processor (apps/worker/src/worker.ts)
├── packages/
│   ├── config/              # Tier/env loading and deployment safety checks
│   ├── domain/              # Shared types, business math, constants
│   ├── logger/              # Pino logger with request and Sentry trace context
│   ├── queue/               # Shared Postgres queue claiming/apply helpers
│   └── workflows/           # Deterministic workflow reducers + Zod schemas (see docs/DETERMINISTIC_WORKFLOWS.md)
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
- **Dependencies**: `pg`, `@sentry/node`, `@sitelayer/config`, `@sitelayer/domain`, `@sitelayer/logger`, `@sitelayer/queue`

**Endpoints** (representative — `apps/api/src/server.ts` is the canonical list):

System / observability:

- GET `/health` (note: no `/api` prefix — what Caddy probes), GET `/api/version`
- GET `/api/metrics` — Prometheus format, gated by `API_METRICS_TOKEN`
- GET `/api/features`, GET `/api/spec`, GET `/api/session`
- GET `/api/audit-events`
- GET `/api/debug/traces/:traceId` — Sentry trace fetch, gated by `DEBUG_TRACE_TOKEN`

Companies / auth:

- GET/POST `/api/companies`
- POST `/api/companies/:id/memberships`
- POST `/api/webhooks/clerk` — Svix-signed Clerk webhook

Bootstrap / projects:

- GET `/api/bootstrap` — projects and seed data for current company
- POST `/api/projects`, PATCH `/api/projects/:id`
- GET `/api/projects/:id/summary`, POST `/api/projects/:id/closeout`

Blueprints / takeoff:

- POST `/api/projects/:id/blueprints` — upload; accepts streaming `multipart/form-data` (`blueprint_file` + metadata fields) or legacy base64 JSON (`file_contents_base64`)
- GET `/api/projects/:id/blueprints`, GET `/api/blueprints/:id/file`
- PATCH/DELETE `/api/blueprints/:id`, POST `/api/blueprints/:id/versions`
- POST `/api/projects/:id/takeoff/measurement` — append one polygon
- POST `/api/projects/:id/takeoff/measurements` — replace set
- GET/PATCH/DELETE `/api/takeoff/measurements/:id`

Estimation:

- POST `/api/projects/:id/estimate/recompute`
- GET `/api/projects/:id/estimate/scope-vs-bid`
- POST `/api/projects/:id/estimate/push-qbo`
- GET `/api/projects/:id/estimate/forecast-hours`

Material bills:

- GET/POST `/api/projects/:id/material-bills`
- PATCH/DELETE `/api/material-bills/:id`

Reference data CRUD: customers, workers, divisions, service-items, pricing-profiles, bonus-rules, labor-entries, schedules, rentals.

Time tracking (clock):

- POST `/api/clock/in`, POST `/api/clock/out`
- GET `/api/clock/timeline`

Analytics:

- GET `/api/analytics`, `/api/analytics/history`, `/api/analytics/divisions`, `/api/analytics/service-item-productivity`

QBO integration:

- GET `/api/integrations/qbo/auth`, GET `/api/integrations/qbo/callback`
- GET/POST `/api/integrations/qbo`, POST `/api/integrations/qbo/sync`
- POST `/api/integrations/qbo/sync/material-bills` — push material bills to QBO
- GET `/api/integrations/qbo/mappings`, POST `/api/integrations/qbo/mappings`
- PATCH/DELETE `/api/integrations/qbo/mappings/:id`

Rental inventory + billing workflow (see `docs/DETERMINISTIC_WORKFLOWS.md`):

- GET/POST/PATCH/DELETE `/api/inventory-items`, `/api/inventory-locations`, `/api/inventory-movements`
- GET/POST/PATCH/DELETE `/api/projects/:id/rental-contracts`, `/api/job-rental-lines`
- POST `/api/rental-contracts/:id/billing-runs/preview`, GET/POST `/api/rental-contracts/:id/billing-runs`
- GET `/api/rental-billing-runs?state=...` — company-scoped list (entry surface for the headless review UI)
- GET `/api/rental-billing-runs/:id` — returns `WorkflowSnapshot { state, state_version, context, next_events }`
- POST `/api/rental-billing-runs/:id/events` — `{ event, state_version }` applies the pure reducer in one tx; 409 on stale `state_version` or illegal transition

Sync queue inspection:

- GET `/api/sync/status`, `/api/sync/events`, `/api/sync/outbox`
- POST `/api/sync/process` — manual drain trigger

**Environment Variables**:

```
APP_TIER=local|dev|preview|prod          # Tier marker; startup guard enforced
FEATURE_FLAGS=read-prod-ro,qbo-live,...  # See DEPLOYMENT.md → Tier Isolation
DATABASE_URL_PROD_RO=...                 # Read-only prod pool (only for read-prod-ro flag)
PORT=3001
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer
ACTIVE_COMPANY_SLUG=la-operations        # Hardcoded tenant demo
ACTIVE_USER_ID=demo-user                 # Hardcoded user
QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI
QBO_ENVIRONMENT=sandbox|production
BLUEPRINT_STORAGE_ROOT=/app/storage/blueprints
ALLOWED_ORIGINS=http://localhost:5173,...
```

**Tier isolation.** The API refuses to boot if `APP_TIER` disagrees with `DATABASE_URL` (e.g. `APP_TIER=dev` pointing at `sitelayer_prod`) or with `DO_SPACES_BUCKET`. Full rules + feature-flag semantics live in `DEPLOYMENT.md` → Tier Isolation. The web UI shows a colored ribbon reflecting the tier; absence of the ribbon means production. Claude Desktop / MCP agents must never be handed prod credentials.

### Frontend (apps/web/src/App.tsx)

- **React 19 SPA**: No Next.js, no SSR; pure client-side
- **Build**: Vite dev server @ `0.0.0.0:3000` during dev
- **State**: IndexedDB for offline-first (recent addition)
- **UI Components**: Inline SVG polygon annotation overlay over browser PDF/image preview
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
export const normalizePolygonGeometry = (geometry) => ... // validates 0-100 board-space polygons
export const calculateTakeoffQuantity = (points, multiplier) => ...
```

Takeoff geometry is intentionally shared between API and web. The web uses it for live polygon quantity/centroid display; the API uses it to validate and normalize polygon geometry before writing `takeoff_measurements`.

### Cross-cutting middleware

Three concerns wired into every API request, implemented as discrete modules in `apps/api/src/`:

- **Rate limiting** (`rate-limit.ts`) — per-user and per-IP token bucket. Configurable via `RATE_LIMIT_PER_USER_PER_MIN` / `RATE_LIMIT_PER_IP_PER_MIN`; some routes (health, metrics, OAuth callbacks) are exempted via `isRateLimitExempt`.
- **Version guard** (`version-guard.ts`) — optimistic concurrency on PATCH paths via `assertVersion`. Clients send the row's current `version` and the server rejects with 409 on stale writes. Used for projects, blueprints, takeoff measurements, etc.
- **Catalog enforcement** (`catalog.ts`) — guards estimate/labor writes against the per-company curated `service_item_divisions` cross-reference (set up by migration `011_service_item_xref_backfill.sql`).
- **LWW conflict resolution** (`lww.ts`) — last-writer-wins via `updated_at` for offline-queue replays from the SPA. Migration `012_takeoff_measurements_updated_at.sql` adds the column + index that this relies on.

### Queue Package (packages/queue/src/index.ts)

Shared Postgres queue lease implementation used by both API-triggered sync and the background worker:

- Claims `mutation_outbox` and `sync_events` with `FOR UPDATE SKIP LOCKED`.
- Uses short processing leases through `next_attempt_at` so stale work can be retried.
- Wraps claim/apply/update in one transaction and rolls back on failure.
- Has unit coverage in `packages/queue/src/index.test.ts`; do not fork this SQL back into app code.

### Worker (apps/worker/src/worker.ts)

Background job processor:

- Calls `@sitelayer/queue` for the shared Postgres queue lease/transaction behavior.
- Marks simulated local queue work as `applied`. The QBO material-bill push path is now exercised in CI by `apps/api/src/qbo-material-bill-sync.test.ts` against a localhost HTTP mock; before flipping the `qbo-live` flag in prod, run `scripts/qbo-sandbox-smoke.sh` against a real QBO sandbox.

### Database Schema

**Core Tables** (canonical source: `docker/postgres/init/*.sql`):

- `companies` — multi-tenant root
- `company_memberships` — Clerk user → company role (`admin|foreman|office|member`); auth identity lives here, not a separate users table
- `customers` — per-company customer roster
- `projects` — construction projects
- `blueprint_documents` — uploaded PDF/image documents with storage path (local FS or DO Spaces key) and revision lineage
- `takeoff_measurements` — polygon/manual measurements with persisted geometry
- `estimate_lines` — per-project estimate line items (no separate `estimates` parent table)
- `service_items`, `service_item_divisions`, `divisions`, `pricing_profiles`, `bonus_rules` — reference data
- `workers`, `labor_entries`, `crew_schedules`, `clock_events` — crew + time tracking
- `material_bills`, `rentals` — material spend and rental ledger per project
- `integration_connections` — QBO/etc. OAuth tokens, refresh state, webhook secrets
- `integration_mappings` — external refs per `(provider, entity_type)` (customer/project/item)
- `mutation_outbox` — outbound writes queued for external systems (worker drains)
- `sync_events` — directional sync ledger with status, attempts, applied_at, error. Both queue tables are leased in-place via `FOR UPDATE SKIP LOCKED` (`packages/queue/src/index.ts`); there is no separate `queue_leases` table.
- `audit_events` — append-only audit trail (also surfaced via `GET /api/audit-events`)
- `notifications` — per-user/per-company notification ledger

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

| Framework   | Upside                                                      | Downside                               | Fit for Sitelayer                        |
| ----------- | ----------------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| **Fastify** | Lightweight, TypeScript-first, schema validation, streaming | Smaller ecosystem than Express         | ✅ Best choice for post-pilot            |
| **Hono**    | Minimal footprint, edge-first, great types                  | Very new; less mature                  | 🟡 Alternative if edge deployment needed |
| **Express** | Largest ecosystem, mature                                   | Heavy middleware pattern; bloated      | ❌ Avoid; contradicts minimal approach   |
| **Nest.js** | Full framework, dependency injection                        | Opinionated; adds layer of indirection | ❌ Overkill for this domain              |

**Recommendation**: If you must pick a framework now, choose **Fastify**. It fills the gap between raw Node and Express without the bloat. But plain http is defensible for the next 3 months.

### Frontend Framework

**Current**: React 19 + Vite  
**Verdict**: ✅ Correct choice; no change needed

| Framework    | Upside                                  | Downside                       | Fit for Sitelayer                 |
| ------------ | --------------------------------------- | ------------------------------ | --------------------------------- |
| **React 19** | Latest hooks, stable, largest ecosystem | Largest bundle size            | ✅ Good choice                    |
| **Svelte**   | Smallest bundle, great ergonomics       | Smaller ecosystem              | 🟡 Viable if bundle size critical |
| **Solid.js** | Fine-grained reactivity, small          | Still young; smaller community | 🟡 Not worth risk                 |
| **Vue 3**    | Balanced, good for forms                | Smaller US community           | 🟡 OK but React better for team   |

**Recommendation**: Stay with React. It's the safe, productive choice. Vite is already excellent.

### Database ORM / Query Layer

**Current**: Direct pg client SQL strings  
**Verdict**: ⚠️ OK for now; **must migrate by post-pilot**

| Tool            | Upside                                | Downside                                   | Fit for Sitelayer                      |
| --------------- | ------------------------------------- | ------------------------------------------ | -------------------------------------- |
| **Prisma**      | Best DX, auto-migrations, type-safe   | Runtime overhead, lock-in to schema.prisma | ✅ Recommended                         |
| **Drizzle**     | Lightweight, fully typed, SQL-in-TS   | Smaller ecosystem                          | ✅ Alternative if performance critical |
| **Postgres.js** | Drop-in pg replacement, typed queries | Still manual composition                   | 🟡 Bridge solution, not long-term      |
| **Raw pg**      | Total control, transparent            | String concatenation risks                 | ❌ Don't scale this                    |

**Recommendation**: Keep the current ledgered SQL migrations through the pilot, then plan a **Prisma migration** before the schema surface grows much further. It gives you:

- Type safety for queries
- Auto-migration generation from schema changes
- Clear schema-of-record (schema.prisma)
- Generator plugins for seed data

### Authentication

**Current**: Clerk JWT verification in API, Clerk React provider in web, local fixture fallback for development.
**Verdict**: ✅ **Implemented for production; validate first-customer org/membership mapping during pilot setup**

| Solution          | Upside                            | Downside                             | Fit for Sitelayer                   |
| ----------------- | --------------------------------- | ------------------------------------ | ----------------------------------- |
| **Clerk**         | Multi-tenant orgs, RBAC, webhooks | Per-action pricing (~$0.02 per user) | ✅ Matches requirements             |
| **Auth0**         | Mature, flexible rules            | Higher pricing than Clerk            | 🟡 More expensive                   |
| **Supabase Auth** | Open-source, free tier exists     | Limited multi-tenant features        | 🟡 OK for single-tenant MVP         |
| **NextAuth.js**   | Self-hosted, flexible             | OAuth provider setup overhead        | 🟡 Consider if avoiding third-party |

**Recommendation**: Keep Clerk for pilot auth and organization mapping. `CLERK_SECRET_KEY` is reserved for future Clerk Backend API calls; the current request path verifies `CLERK_JWT_KEY`.

### File Storage

**Current**: DigitalOcean Spaces is enabled for production (`sitelayer-blueprints-prod`) with the local `blueprint_storage` volume retained as a dev/preview/emergency fallback.
**Verdict**: ✅ **Object storage is live; remaining pilot risk is upload/download size, not storage durability**

| Service                 | Upside                               | Downside                                | Cost     | Fit                  |
| ----------------------- | ------------------------------------ | --------------------------------------- | -------- | -------------------- |
| **DigitalOcean Spaces** | $5/mo, 250GB included, S3-compatible | Smaller ecosystem                       | $5-15/mo | ✅ Current choice    |
| **AWS S3**              | Industry standard, mature            | Per-request pricing, more complex setup | $10+/mo  | 🟡 Overkill for MVP  |
| **Supabase Storage**    | Built on S3, PostgreSQL-native       | Different S3 endpoint                   | ~$10/mo  | 🟡 Adds dependency   |
| **Cloudinary**          | Image optimization built-in          | Per-request pricing, vendor lock-in     | $10+/mo  | ❌ Overkill for PDFs |

**Recommendation**: Keep DigitalOcean Spaces as the production object store. Streaming multipart upload (`apps/api/src/blueprint-upload.ts`, busboy + `@aws-sdk/lib-storage`) and presigned download URLs (`@aws-sdk/s3-request-presigner`) ship today; 30–80MB construction PDFs no longer flow through the JSON body limit.

### Background Jobs

**Current**: Inline worker.ts backed by `mutation_outbox` and `sync_events` leases.  
**Verdict**: 🟡 **OK for pilot simulation; live QBO connector still needs validation**

| Solution             | Upside                                | Downside                             | Cost     | Fit                  |
| -------------------- | ------------------------------------- | ------------------------------------ | -------- | -------------------- |
| **Hatchet**          | Purpose-built for workflows, no infra | Additional hosted/service dependency | Varies   | 🟡 Future option     |
| **Bull** (Redis)     | Lightweight, mature                   | Need Redis instance                  | $0-15/mo | 🟡 Works, adds Redis |
| **Postgres pg-boss** | No external dep, uses your DB         | Less mature than Bull, slower        | $0       | 🟡 Simpler for MVP   |
| **Temporal.io**      | Enterprise-grade, durable             | Significant overhead, learning curve | $0 (OSS) | ❌ Too much for MVP  |

**Recommendation**: Keep the current Postgres-backed queue for pilot unless sync complexity grows. Revisit pg-boss or Hatchet after live QBO behavior is known.

### Monitoring & Observability

**Current**: Sentry (v10, OpenTelemetry-native) across `api`, `worker`, and `web`; Pino JSON logs stamped with `trace_id` / `span_id` / `request_id` via AsyncLocalStorage.
**Verdict**: ✅ **Live as of 2026-04-24.** Prod defaults to `tracesSampleRate=0.1`; local/dev/preview default to `1.0`. Revisit sampling once volume justifies tuning.

**What is wired:**

- `apps/api/src/instrument.ts` and `apps/worker/src/instrument.ts` are imported first and enable `httpIntegration`, `nativeNodeFetchIntegration`, `postgresIntegration`, and `contextLinesIntegration`. HTTP server spans and `pg` query spans are automatic.
- Every request gets a UUID `x-request-id` (echoed in response headers and error bodies), attached to the active Sentry scope and to an AsyncLocalStorage slot consumed by `@sitelayer/logger`.
- `recordSyncEvent` and `recordMutationOutbox` persist `sentry_trace`, `sentry_baggage`, and `request_id` on every enqueue (migration `005_trace_propagation.sql`). The worker calls `Sentry.continueTrace()` on each applied row so the queue hop shows up as a child span of the originating HTTP request.
- Web SDK ships `reactRouterV7BrowserTracingIntegration` + `replayIntegration` (masks text, inputs, and media) only after the lazy Sentry chunk loads. `main.tsx` uses a local React error boundary that reports through the lazy Sentry facade and also handles stale chunk reload recovery after deploys. Offline-queue replay emits an `offline_queue.replay` span with depth/replayed/dropped/conflict counts when Sentry is loaded.

**Agent trace lookup:** `GET /api/debug/traces/:traceId` (or `?by=request_id`) — Bearer `DEBUG_TRACE_TOKEN`, tier-gated against prod unless `DEBUG_ALLOW_PROD=1`, rate-limited. Proxies Sentry's `events-trace` API and joins local `mutation_outbox` and `sync_events` rows matching the trace or request id.

**Required env for full trace tooling** (see `.env.example`): `SENTRY_DSN`, optional `SENTRY_WORKER_DSN`, build-time `VITE_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_AUTH_TOKEN`, `DEBUG_TRACE_TOKEN`. Trace sample rate defaults to `0.1` in prod and `1.0` elsewhere; on-error replay `1.0`; session replay `0.1`.

## Pending Infrastructure & Setup

### Phase 1 — Environment & Secrets (DONE; snapshot in `INFRASTRUCTURE_READY.md`)

- [x] Domain (`sandolab.xyz` registered + DNS for prod and preview)
- [x] DigitalOcean Spaces — `sitelayer-blueprints-prod` provisioned in `tor1`, versioning enabled, scoped prod key wired
- [x] DigitalOcean Container Registry — `sitelayer` Starter registry in `tor1` for immutable runtime images
- [x] DigitalOcean managed Postgres 18 (`sitelayer_prod`, `sitelayer_preview`, `sitelayer_dev`)
- [x] Clerk app + OAuth credentials (env vars wired; enforcement gated on `CLERK_JWT_KEY` + `AUTH_ALLOW_HEADER_FALLBACK`)
- [x] `.env.example` scaffold; production `.env` lives at `/app/sitelayer/.env` (mode `600`); GitHub Actions injects build-time secrets at deploy
- [x] Docker Compose: api + web + postgres + worker + MinIO (local), prod and preview variants

### Phase 2 — Initial Deployment (DONE)

- [x] Build and promote immutable runtime image (api, web, worker commands share one image)
- [x] Postgres schema migration runner (`scripts/migrate-db.sh`) + schema checker (`scripts/check-db-schema.sh`)
- [x] Seed data (LA Operations template via `seedCompanyDefaults` in `apps/api/src/onboarding.ts`)
- [x] Sentry wired across api/web/worker with trace propagation
- [x] Logical backup, Postgres off-host copy, blueprint-volume fallback copy, restore-drill, and timer-monitor timers running with Postgres 18 tooling
- [ ] QBO OAuth flow validated end-to-end against sandbox (`scripts/qbo-sandbox-smoke.sh` exists; needs real creds)
- [x] Blueprint uploads stream multipart through the API into Spaces (`MAX_BLUEPRINT_UPLOAD_BYTES`, default 200MB); legacy base64 JSON still accepted as a fallback for already-queued offline mutations

### Phase 3 — Pilot Customer Onboarding

- [x] Cut over to enforced Clerk auth in prod (`AUTH_ALLOW_HEADER_FALLBACK=0`, `CLERK_JWT_KEY` set)
- [x] Inject `DO_SPACES_KEY/SECRET` into prod tier so storage flips off the local volume
- [ ] Provision first pilot company + memberships via `/api/companies` + `/api/companies/:id/memberships`
- [ ] Train on crew scheduling + labor entry
- [ ] Daily QBO sync running clean
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

## Decisions

### 5. Deterministic Workflows — Pure Reducers, Headless UI, Workflow Package (2026-04-28)

**Question (resolved):** How do we model multi-step business processes (rental billing, future estimate-push approval, ...) without scattering `if (status === 'foo')` across the codebase?

**Decision:** Every multi-step process is a deterministic state machine. Pure reducer + state version + headless UI + outbox-driven side effects. Documented in `docs/DETERMINISTIC_WORKFLOWS.md`.

**Mechanics:**

- Workflow definitions live in `packages/workflows/`. Each workflow exports state types, event types, snapshot type, pure transition function `(snapshot, event) → next_snapshot`, and a `nextEvents(state)` selector that the API uses to populate `WorkflowSnapshot.next_events`.
- API endpoints expose two routes per workflow: `GET /…/:id` returns a `WorkflowSnapshot { state, state_version, context, next_events }`, `POST /…/:id/events` takes `{ event, state_version }`, applies the reducer in one tx with optimistic version check, persists `state_version + 1`, and emits any side-effect intent (e.g. QBO push) into `mutation_outbox` with a stable per-entity idempotency key.
- Workers drain dedicated outbox mutation_types via `processRentalBillingInvoicePush(client, push)` etc. (added to `@sitelayer/queue`), check the entity's external-id field for idempotency before calling external APIs, and emit `*_SUCCEEDED` / `*_FAILED` events back through the same reducer.
- Frontend renders `state` + `context` + `next_events` straight from the snapshot. XState wraps **only** UI state (loading / submitting / showingError / outOfSync), never mirrors business state. 409s reload the fresh snapshot.
- Event request bodies are validated by Zod schemas exported from `@sitelayer/workflows` (e.g. `parseRentalBillingEventRequest`).

**Why this shape (not status toggles or Temporal-from-day-one):**

- Pure reducers are easy to reason about, test in isolation, and replay — the same transition table will move to Temporal activities when timers/retries justify it.
- Headless UI means a screen never accidentally invents new business states (e.g. an "approved-locally-pending-server" state that doesn't exist on the backend). The component is a thin renderer.
- One outbox row per workflow event keeps retries safe: stable idempotency_key per run id (not per state_version) so RETRY_POST replays upsert the same row.

**Scope:**

- First (and currently only) workflow: `rental_billing_runs`. States: `generated → approved → posting → posted | failed → voided`. Events: `APPROVE`, `POST_REQUESTED`, `POST_SUCCEEDED`, `POST_FAILED`, `RETRY_POST`, `VOID`. `POST_SUCCEEDED`/`POST_FAILED` are worker-only — rejected at the human event endpoint.
- Worker activates real QBO Invoice push when `QBO_LIVE_RENTAL_INVOICE=1`; otherwise a stub returns synthetic ids so dev/preview/fixtures still exercise the deterministic plumbing.
- Future workflows that fit this pattern: estimate push approval, schedule confirmation, blueprint review.

### 4. Offline Sync Conflict Resolution — Last-Write-Wins + Diagnostic Toast (2026-04-24)

**Question (resolved):** What if crew edits a measurement both online and offline?

**Decision:** Last-write-wins on the server, with a diagnostic toast on the offline client to surface that its local edit was discarded.

**Mechanics:**

- Each queued offline mutation captures a `client_updated_at` ISO timestamp at enqueue time (`OfflineMutation.clientUpdatedAt` in `apps/web/src/api.ts`).
- On replay the frontend sends `If-Unmodified-Since: <client_updated_at>` to the API.
- API endpoints for measurement updates (currently `PATCH /api/takeoff/measurements/:id`) consult the row's `updated_at`. If the server is strictly newer than the header, return `409` with the authoritative server value. Otherwise apply the write and bump `updated_at = now()`.
- On `409`, `replayOfflineMutations` drops the queued mutation and shows: "A newer change for {entity} was synced from another device — your local edit was discarded."

**Why LWW (not manual resolution):**

- Construction crews are mostly editing measurement quantities and notes; the cost of a lost local edit is small compared to UI complexity of a merge picker.
- LWW preserves the offline-first UX: queued writes either land or get discarded with a visible breadcrumb, never silently re-queue forever.
- The toast + Sentry breadcrumb (`offline_queue: lww conflict ...`) gives Taylor visibility into how often this fires; if the rate goes up we can revisit.

**Scope:**

- `takeoff_measurements` is the only entity wired through the LWW path today (its `updated_at` column was added in `012_takeoff_measurements_updated_at.sql`).
- Other entities (rentals, labor entries, estimate lines) still rely on optimistic-version `expected_version` checks. Those return `409` too but without an `If-Unmodified-Since`-driven toast; the offline replayer drops them on any 4xx as before.

**Tests:** `apps/api/src/lww.test.ts` covers parse, comparison, and the two-write race scenario.

## References

- **Domain Model**: See `packages/domain/src/index.ts`
- **Requirements**: See `docs/REQUIREMENTS_SPEC.md`
- **Deployment Plan**: See `PILOT_SETUP_PLAN.md`
- **QBO Integration**: See `docs/QBO_EXTRACTION_CANONICAL_REFERENCE.md`
- **Greenfield Architecture**: See `docs/GREENFIELD_ARCHITECTURE_PLAN.md`
