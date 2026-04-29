# SiteLayer

Construction operations platform: blueprint takeoff, estimation, crew scheduling, rental/inventory management, and QuickBooks Online sync.

Built for exterior cladding contractors (EIFS, stucco, masonry, siding) to manage projects from bid through closeout — measure blueprints, generate estimates, track crews, manage equipment rentals, and sync costs to QBO.

## Features

### Blueprint Takeoff

- **PDF upload and storage** — Upload construction blueprints (PDF) with dual-mode storage (DigitalOcean Spaces or local filesystem). Blueprint versioning and revision tracking.
- **Interactive measurement canvas** — Draw polygons, lines, and volumes directly on blueprints in the browser. Calibrate scale against known dimensions. Supports area (sqft), lineal (lf), and volume measurements.
- **Scope item management** — 9 pre-configured scope items (EPS, Basecoat, Finish Coat, Cultured Stone, Air Barrier, Cementboard, Envelope Seal, Caulking, Flashing) with per-item colors, units, and default rates. Assignable to divisions per project.
- **Multi-draft system** — Multiple measurement drafts per project. Create, rename, duplicate, switch between drafts. Each draft has its own canvas state and estimate. Auto-saves polygons and calibration. Extensible `type` column supports future tools (scaffolding design).
- **Zoom and pan** — Ctrl+scroll zooms to cursor position. Right-click drag pans the blueprint. Full horizontal and vertical scrolling.

### Estimation & Costing

- **Auto-generated estimates** — Estimate line items computed from measured quantities and scope rates. Subtotal, GST, and total calculations.
- **Bid vs scope comparison** — Color-coded comparison between the project bid total (bid_psf x sqft) and the scope subtotal. Green = under bid, red = over bid.
- **Project-specific rate overrides** — Each project can override company default rates. Rates cascade: SCOPE_ITEMS defaults -> company Settings -> project overrides.
- **Pricing profiles** — Baseline rates and per-division adjustments. Multiple profiles per company.
- **Estimate PDF export** — Generate downloadable PDF quotes from estimate data.
- **Scope vs bid analysis** — `GET /api/projects/:id/estimate/scope-vs-bid` with delta threshold detection (1%, 5% warning bands).
- **Hours forecasting** — Project labor hours from productivity rates and measured quantities.

### Project Management

- **Create-then-upload wizard** — 3-step project creation: Details (creates project immediately) -> Blueprint upload + canvas measurement (or skip) -> Summary with "Open Project" navigation.
- **Project dashboard** — List all projects with status, bid total, division, and client. Filter and search.
- **Project detail** — Tabbed view: Overview (bid vs actual PSF, margin, bonus), Labor, Rentals, Documents.
- **Status tracking** — Projects move through bid -> active -> closed lifecycle.
- **Closeout workflow** — `POST /api/projects/:id/closeout` with summary locking.

### Labor & Time Tracking

- **Clock in/out** — GPS-enabled punch clock with geolocation capture, accuracy metrics, and geofence detection. Event types: in, out, auto_out_geo, auto_out_idle.
- **Labor entries** — Track hours per worker per service item per project. Links to divisions and cost calculations.
- **Daily confirmation** — Crew manifest confirmation workflow with XState machine for state management. Aggregates schedules and labor entries for single-day sign-off.
- **Productivity analytics** — sqft/hr by scope item, by worker, by week. Division rollups and time-series history.

### Crew Scheduling

- **Weekly grid** — Monday-Sunday scheduling grid with multiple crew assignments per (project, day) cell.
- **Schedule confirmation** — Foreman confirms daily schedule via `POST /api/schedules/:id/confirm`.
- **Copy week** — Duplicate previous week's schedule to current week.

### Rental & Inventory Management

- **Inventory catalog** — Master catalog of rental equipment with part numbers, names, categories, and multi-tier pricing (25-day cycle, daily, weekly rates). Replacement cost tracking for lost/damaged items.
- **Stock availability** — Real-time available stock calculation via Postgres function: total_stock minus items currently on active rentals.
- **Inventory locations** — Track where equipment is stored.
- **Movement ledger** — Full audit trail of inventory movements (dispatch, return, loss, transfer).
- **Rental contracts** — Per-project rental contracts with line items. Link inventory items to jobs.
- **Billing workflow** — Deterministic state machine: generated -> approved -> posting -> posted (or failed/void). Headless UI with API-owned reducer. Events: APPROVE, POST_REQUESTED, POST_SUCCEEDED, POST_FAILED, RETRY_POST, VOID.
- **Billing runs** — List and review billing runs with state filtering. Per-run line items with amounts.
- **CSV/Excel import** — Upload inventory catalog from CSV with auto-column detection, preview, and batch upsert (up to 1000 items).

### QuickBooks Online Integration

- **OAuth flow** — Full QBO OAuth 2.0 connection with token exchange, refresh, and realm ID tracking. Sandbox and production environment support.
- **Integration mappings** — Map SiteLayer entities (customers, service items, divisions, projects) to QBO external IDs. Auto-backfill on first sync.
- **Sync operations** — Pull bills, time activities, and estimates from QBO. Push material bills and rental invoices to QBO. Mutation outbox with retry tracking.
- **Estimate push** — Push project estimates to QBO as estimates/invoices.
- **Rental invoice push** — Worker-driven QBO invoice creation from rental billing runs.

### Bonus Rules & Simulation

- **Configurable bonus tiers** — Margin-based bonus rules with payout percentages. Multiple tiers per rule.
- **Bonus simulator** — What-if analysis on revenue, cost, and bonus pool. Shows next tier threshold and revenue gap.
- **Core math** — `calculateBonusPayout()`, `simulateBonusScenario()` pure functions in domain package.

### Authentication & Multi-Tenancy

- **Clerk integration** — JWT verification, SignIn/SignUp UI, webhook handler for user/org events. Roles: admin, foreman, office, member.
- **Company management** — Create companies, invite members, switch between companies. Auto-seed LA template with divisions and service items.
- **Role-based access** — Route-level RBAC. Admin/office for writes, foreman for scheduling and confirmation.
- **Audit trail** — Every mutation creates an audit event with actor, entity, action, before/after snapshots, request ID, and Sentry trace.

### Offline-First

- **Offline queue** — Mutations enqueued to localStorage when offline. Automatic replay on reconnect with 15s heartbeat checks.
- **Last-write-wins conflict resolution** — `If-Unmodified-Since` header for timestamp-based conflict detection. Diagnostic toast when local edits are discarded.
- **Sync status badge** — Visual indicator of offline state and pending mutation count.

### Observability

- **Sentry** — OpenTelemetry-native tracing across API, worker, and web. Lazy-loaded in frontend. Trace propagation through queue hops.
- **Structured logging** — Pino JSON logs with request context (request ID, company ID, user ID, trace ID) via AsyncLocalStorage.
- **Prometheus metrics** — `GET /api/metrics` with request count, latency, error rate, and pool stats. Token-gated.
- **Debug trace endpoint** — `GET /api/debug/traces/:traceId` with queue row correlation. Rate-limited.

## Architecture

```
apps/
  api/       — Node.js HTTP server (plain http module, no framework)
  web/       — React 19 + Vite SPA with Clerk auth
  worker/    — Background job processor (rental invoicing, QBO sync)

packages/
  config/    — Tier/env loading and deployment safety checks
  domain/    — Shared types, business logic, pure calculation functions
  logger/    — Pino logger with request and Sentry trace context
  queue/     — Postgres-backed queue lease/transaction helpers
  workflows/ — Deterministic workflow definitions (rental billing)

docker/
  postgres/init/  — SQL migration files (001-016)
```

| Component     | Technology                                       |
| ------------- | ------------------------------------------------ |
| Backend       | Node.js (plain http module) + PostgreSQL         |
| Frontend      | React 19 + Vite SPA (no SSR)                     |
| Worker        | Node.js background processor                     |
| Database      | Postgres 18 (direct SQL, no ORM)                 |
| Auth          | Clerk (JWT + webhooks)                           |
| Storage       | DigitalOcean Spaces (S3-compatible) or local FS  |
| State         | XState v5 machines (frontend)                    |
| UI            | Radix UI primitives (shadcn-style)               |
| Observability | Sentry v10 + Pino + Prometheus                   |
| Deployment    | Docker Compose + Caddy (prod), Traefik (preview) |

## Quickstart

```bash
npm ci
npm run dev
```

Local ports: web `:3000`, API `:3001`, MinIO `:9000` (console `:9001`)

Frontend-only with fixture data:

```bash
VITE_FIXTURES=1 npm run dev:web
```

Full Docker stack:

```bash
docker compose up --build
```

## Quality

```bash
npm run ci:quality    # Full release gate
npm run typecheck     # Type checking only
npm run test          # Unit tests
npm run build         # Full build
npm run e2e           # Playwright e2e tests
```

## Environment

Env files loaded from cwd upward: `.env` -> `.env.local` -> `.env.sentry.local` -> `.env.qbo.local`. See `.env.example` for the full scaffold.

**Key variables**: `APP_TIER` (local/dev/preview/prod), `DATABASE_URL`, `CLERK_JWT_KEY`, `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`, `DO_SPACES_KEY`/`DO_SPACES_SECRET`/`DO_SPACES_BUCKET`, `SENTRY_DSN`, `API_METRICS_TOKEN`.

## Docs

- `DEVELOPMENT.md` — Local development loop and routes
- `DEPLOYMENT.md` — Production deploy, tiers, caching, backups
- `CLAUDE.md` — Architecture and agent coordination source of truth
- `docs/RELEASE_GATES.md` — CI/release requirements
- `docs/PREVIEW_DEPLOYMENTS.md` — Preview droplet and PR preview flow
- `docs/SECRET_ROTATION.md` — Credential rotation
- `docs/DR_RESTORE.md` — Disaster recovery
- `docs/RENTALS_INVENTORY_REPLACEMENT_SPEC.md` — Rental/inventory system design
- `docs/DETERMINISTIC_WORKFLOWS.md` — Workflow engine design
