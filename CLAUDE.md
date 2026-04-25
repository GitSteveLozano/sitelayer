# Sitelayer

Construction operations platform: blueprint takeoff, estimation, crew scheduling, and QBO sync.

## Agent Coordination Source of Truth

**Last reconciled:** 2026-04-24

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

These are currently tracked as deployment verification items, not global task blockers. After the first successful droplet deploy, promote the production-critical deps to required in Mesh.

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

**Verified with `doctl` and production smoke checks on 2026-04-24.**

| Resource                         | Current State                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production droplet               | `sitelayer`, ID `566798325`, Ubuntu 22.04, Toronto `tor1`, 4 vCPU, 8GB RAM, public IPv4 `165.245.230.3`                                                                          |
| Reserved production IP           | `159.203.51.158`, assigned to droplet `566798325`                                                                                                                                |
| Preview droplet                  | `sitelayer-preview`, ID `566806040`, Ubuntu 22.04, Toronto `tor1`, 2 vCPU, 4GB RAM, reserved IPv4 `159.203.53.218`                                                               |
| Managed Postgres                 | `sitelayer-db`, ID `9948c96b-b6b6-45ad-adf7-d20e4c206c66`, Postgres 18, `db-s-1vcpu-1gb`, Toronto `tor1`, online                                                                 |
| Managed Postgres databases       | `defaultdb`, `sitelayer_prod`, `sitelayer_preview`, `sitelayer_dev`                                                                                                              |
| Managed Postgres trusted sources | Droplet `566798325` (`sitelayer`) and droplet `566806040` (`sitelayer-preview`)                                                                                                  |
| Production deploy path           | GitHub Actions runs on the self-hosted `sitelayer-preview` runner, SSHs to `sitelayer@10.118.0.4`, deploys `/app/sitelayer` with Docker Compose, `.env` at `/app/sitelayer/.env` |
| Preview deploy path              | `docker-compose.preview.yml` behind Traefik on `sitelayer-preview`; shared env at `/app/previews/.env.shared`; smoke stack at `main.preview.sitelayer.sandolab.xyz`              |
| Public edge                      | Containerized Caddy on ports 80/443; automatic Let's Encrypt TLS for `sitelayer.sandolab.xyz`; HTTP redirects to HTTPS                                                           |
| Backups                          | DO managed Postgres automatic backups exist; independent logical backup scripts are added and production timer uses `postgres:18-alpine` pg_dump                                 |
| Optional integrations            | Clerk, DigitalOcean Spaces, QBO, and Sentry can stay blank/placeholders for bootable deploy; `DATABASE_URL` is the hard requirement                                              |

Security note: the deploy user is in the Docker group. That avoids root SSH but Docker access is root-equivalent. Treat `DEPLOY_SSH_KEY` as production-root-equivalent.

Database migrations use `scripts/migrate-db.sh`; schema readiness uses `scripts/check-db-schema.sh`. Production deploy runs both before container rebuilds. For local Docker verification without exposing Postgres on the host, run with `PSQL_DOCKER_NETWORK=sitelayer_default DATABASE_URL=postgres://sitelayer:sitelayer@db:5432/sitelayer`.

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

| Component           | Technology                                                | Notes                                                                                                         |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Backend**         | Node.js (plain http module) + Postgres                    | No framework; minimal HTTP server                                                                             |
| **Frontend**        | React 19 + Vite SPA                                       | Client-side only; no SSR                                                                                      |
| **Worker**          | Node.js background tasks                                  | Postgres-backed leased queue; no Hatchet yet                                                                  |
| **Monorepo**        | npm workspaces                                            | apps: api, web, worker; packages: config, domain, logger, queue                                               |
| **Database**        | Postgres (pg driver)                                      | Direct SQL queries in server.ts; no ORM                                                                       |
| **Auth**            | TBD (hardcoded demo user)                                 | Clerk planned but not yet integrated                                                                          |
| **File Storage**    | Local Docker volume fallback; DigitalOcean Spaces planned | Blueprint PDFs persist under `BLUEPRINT_STORAGE_ROOT`; Spaces/off-host copy still needed before customer data |
| **QBO Integration** | OAuth + REST API (direct HTTP)                            | Connector layer; sync state in `integration_mappings` table                                                   |
| **Observability**   | Sentry v10 + Pino                                         | Trace propagation through browser/API/worker; request-scoped JSON logs via `@sitelayer/logger`                |

## Project Structure

```
sitelayer/
├── apps/
│   ├── api/                 # Backend HTTP server (2917 lines)
│   ├── web/                 # Frontend React SPA (2444 lines)
│   └── worker/              # Background job processor
├── packages/
│   ├── config/              # Tier/env loading and deployment safety checks
│   ├── domain/              # Shared types, business logic, constants
│   ├── logger/              # Pino logger with request and Sentry trace context
│   └── queue/               # Shared Postgres queue claiming/apply helpers
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

**Endpoints**:

- POST `/api/projects` — create project
- GET `/api/bootstrap` — list projects and app seed data
- POST `/api/projects/:id/blueprints` — upload blueprint PDF/image to local storage fallback
- GET `/api/blueprints/:id/file` — stream stored blueprint file inline
- POST `/api/projects/:id/takeoff/measurement` — append one polygon/manual measurement
- POST `/api/projects/:id/takeoff/measurements` — replace a project's measurement set
- GET `/api/projects/:id/summary` — retrieve estimate/operations summary
- GET `/api/integrations/qbo/auth` — OAuth initiation
- POST `/api/integrations/qbo/sync` — trigger QBO sync queue work
- GET `/api/sync/status` — sync state

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

### Queue Package (packages/queue/src/index.ts)

Shared Postgres queue lease implementation used by both API-triggered sync and the background worker:

- Claims `mutation_outbox` and `sync_events` with `FOR UPDATE SKIP LOCKED`.
- Uses short processing leases through `next_attempt_at` so stale work can be retried.
- Wraps claim/apply/update in one transaction and rolls back on failure.
- Has unit coverage in `packages/queue/src/index.test.ts`; do not fork this SQL back into app code.

### Worker (apps/worker/src/worker.ts)

Background job processor:

- Calls `@sitelayer/queue` for the shared Postgres queue lease/transaction behavior.
- Marks simulated local queue work as `applied`; live QBO sync still needs sandbox credential validation.

### Database Schema

**Core Tables**:

- `companies` — multi-tenant isolation
- `users` — user accounts
- `projects` — construction projects (customer, location, divisions)
- `blueprint_documents` — uploaded PDF/image documents with local storage path and revision lineage
- `takeoff_measurements` — measurements extracted from blueprints, including persisted polygon geometry
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

**Recommendation**: Plan **Prisma migration** before production. It gives you:

- Type safety for queries
- Auto-migration generation from schema changes
- Clear schema-of-record (schema.prisma)
- Generator plugins for seed data

### Authentication

**Current**: Hardcoded demo user  
**Verdict**: 🔴 **Must implement before pilot**

| Solution          | Upside                            | Downside                             | Fit for Sitelayer                   |
| ----------------- | --------------------------------- | ------------------------------------ | ----------------------------------- |
| **Clerk**         | Multi-tenant orgs, RBAC, webhooks | Per-action pricing (~$0.02 per user) | ✅ Matches requirements             |
| **Auth0**         | Mature, flexible rules            | Higher pricing than Clerk            | 🟡 More expensive                   |
| **Supabase Auth** | Open-source, free tier exists     | Limited multi-tenant features        | 🟡 OK for single-tenant MVP         |
| **NextAuth.js**   | Self-hosted, flexible             | OAuth provider setup overhead        | 🟡 Consider if avoiding third-party |

**Recommendation**: **Integrate Clerk before pilot** (required for multi-tenant demo). Estimated cost: ~$20-50/month for pilot scale.

### File Storage

**Current**: Local filesystem fallback implemented and persisted by Docker Compose through the `blueprint_storage` volume.
**Verdict**: 🟡 **Off-host/object storage still needed before customer data**

| Service                 | Upside                               | Downside                                | Cost     | Fit                  |
| ----------------------- | ------------------------------------ | --------------------------------------- | -------- | -------------------- |
| **DigitalOcean Spaces** | $5/mo, 250GB included, S3-compatible | Smaller ecosystem                       | $5-15/mo | ✅ Planned choice    |
| **AWS S3**              | Industry standard, mature            | Per-request pricing, more complex setup | $10+/mo  | 🟡 Overkill for MVP  |
| **Supabase Storage**    | Built on S3, PostgreSQL-native       | Different S3 endpoint                   | ~$10/mo  | 🟡 Adds dependency   |
| **Cloudinary**          | Image optimization built-in          | Per-request pricing, vendor lock-in     | $10+/mo  | ❌ Overkill for PDFs |

**Recommendation**: **Use DigitalOcean Spaces** as planned ($5/mo, S3-compatible, simple setup) for off-host retention and backup. Keep the local volume fallback for dev, preview, and early smoke testing.

### Background Jobs

**Current**: Inline worker.ts backed by `mutation_outbox` and `sync_events` leases.  
**Verdict**: 🟡 **OK for pilot simulation; live QBO connector still needs validation**

| Solution             | Upside                                | Downside                             | Cost     | Fit                  |
| -------------------- | ------------------------------------- | ------------------------------------ | -------- | -------------------- |
| **Hatchet**          | Purpose-built for workflows, no infra | Pricing TBD (currently free)         | Free?    | ✅ Planned choice    |
| **Bull** (Redis)     | Lightweight, mature                   | Need Redis instance                  | $0-15/mo | 🟡 Works, adds Redis |
| **Postgres pg-boss** | No external dep, uses your DB         | Less mature than Bull, slower        | $0       | 🟡 Simpler for MVP   |
| **Temporal.io**      | Enterprise-grade, durable             | Significant overhead, learning curve | $0 (OSS) | ❌ Too much for MVP  |

**Recommendation**: Keep the current Postgres-backed queue for pilot unless sync complexity grows. Revisit pg-boss or Hatchet after live QBO behavior is known.

### Monitoring & Observability

**Current**: Sentry (v10, OpenTelemetry-native) across `api`, `worker`, and `web`; Pino JSON logs stamped with `trace_id` / `span_id` / `request_id` via AsyncLocalStorage.
**Verdict**: ✅ **Live as of 2026-04-24.** Keep `tracesSampleRate=1.0` through pilot; revisit once volume justifies sampling.

**What is wired:**

- `apps/api/src/instrument.ts` and `apps/worker/src/instrument.ts` are imported first and enable `httpIntegration`, `nativeNodeFetchIntegration`, `postgresIntegration`, and `contextLinesIntegration`. HTTP server spans and `pg` query spans are automatic.
- Every request gets a UUID `x-request-id` (echoed in response headers and error bodies), attached to the active Sentry scope and to an AsyncLocalStorage slot consumed by `@sitelayer/logger`.
- `recordSyncEvent` and `recordMutationOutbox` persist `sentry_trace`, `sentry_baggage`, and `request_id` on every enqueue (migration `005_trace_propagation.sql`). The worker calls `Sentry.continueTrace()` on each applied row so the queue hop shows up as a child span of the originating HTTP request.
- Web SDK ships `reactRouterV7BrowserTracingIntegration` + `replayIntegration` (masks text, inputs, and media). `Sentry.ErrorBoundary` wraps the app in `main.tsx`. Offline-queue replay emits an `offline_queue.replay` span with depth/replayed/dropped/conflict counts.

**Agent trace lookup:** `GET /api/debug/traces/:traceId` (or `?by=request_id`) — Bearer `DEBUG_TRACE_TOKEN`, tier-gated against prod unless `DEBUG_ALLOW_PROD=1`, rate-limited. Proxies Sentry's `events-trace` API and joins local `mutation_outbox` and `sync_events` rows matching the trace or request id.

**Required env** (see `.env.example`): `SENTRY_DSN`, `VITE_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_AUTH_TOKEN`, `DEBUG_TRACE_TOKEN`. Trace sample rate defaults to `1.0`; on-error replay `1.0`; session replay `0.1`.

## Pending Infrastructure & Setup

### Phase 1 — Environment & Secrets (Week 1, Day 1-2)

- [ ] Domain registration (sitelayer.{local|site})
- [ ] DigitalOcean Spaces buckets (`sitelayer-blueprints-dev`, `sitelayer-blueprints-preview`, `sitelayer-blueprints-prod`)
- [ ] DigitalOcean database (Postgres 15+, 1GB RAM minimum)
- [ ] Clerk organization setup + OAuth credentials
- [ ] Environment file (`.env.local`)
- [ ] Docker Compose: api + web + postgres + redis-equivalent (pg-boss)

### Phase 2 — Initial Deployment (Week 1, Day 3-5)

- [x] Build Docker images (api, web, worker)
- [x] Postgres schema migration runner and schema checker
- [x] Seed data (LA Operations template)
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

## Decisions

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
