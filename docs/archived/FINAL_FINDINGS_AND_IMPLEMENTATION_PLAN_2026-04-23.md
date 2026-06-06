# Sitelayer Final Findings and Implementation Plan

## Purpose

This document consolidates the source material, client intent, architecture findings, and implementation direction into one greenfield plan.

It is meant to keep the project grounded in what was originally wanted, while still leaving room for extensible architecture and practical offline support.

## 1. What the Client Actually Wanted

From the WhatsApp transcript, screenshot transcriptions, and workflow analysis, the client asked for a focused construction operations layer that could:

- connect blueprint intake and takeoff
- connect project setup and estimating
- connect field scheduling and time tracking
- connect QBO sync for accounting and job costing
- support performance analysis and bonus calculations

The concrete workflow pain was manual re-entry across:

- email and Google Drive for plans
- PlanSwift for takeoff
- QuickBooks Online for estimates, billing, and accounting
- T-Sheets / time tracking for labor

The direct asks included:

- a PlanSwift-like blueprint tool with PDF render, scale calibration, polygon drawing, sqft summary, and annotations
- QBO-backed divisions/classes
- QBO-backed customers and jobs
- a curated service-item/takeoff subset
- project-specific pricing support
- schedule-driven daily time capture with minimal friction
- margin and bonus tracking

## 2. Canonical Requirements

### 2.1 Fixed taxonomy

The 9 divisions are authoritative:

- D1 Stucco
- D2 Masonry
- D3 Siding
- D4 EIFS
- D5 Paper and Wire
- D6 Snow Removal
- D7 Warranty
- D8 Overhead
- D9 Scaffolding

### 2.2 Curated takeoff subset

QBO contains a broader service catalog, but the takeoff experience should only expose measurable construction items.

The curated subset is intentional and should not be replaced with the full QBO catalog.

### 2.3 Dynamic customers and jobs

Customers must be QBO-backed and dynamic.

The model must support:

- builder accounts
- address-based job names
- contractor/partner entities

### 2.4 Layered pricing

Pricing must support:

- company defaults
- project overrides
- labor hourly rates
- material/unit rates
- project bid totals

Bid total and scope-item unit pricing must remain distinct concepts.

### 2.5 Bonus logic

Bonus calculations are a first-class business requirement.

The business wants margin-based supervisor bonuses, with support for:

- actual vs bid margin
- tiered rules
- project-specific eligibility
- division-specific eligibility
- historical verification

### 2.6 Field workflow

Field capture must be low friction:

- schedule prepopulates expected work
- foreman confirms daily work
- edits are minimal
- worker participation is close to zero-touch

### 2.7 QBO sync

The system must support QBO auth and sync for:

- estimates
- bills
- time activities
- customers
- classes / divisions
- external IDs and provenance

## 3. Source-of-Truth Boundaries

### QBO is authoritative for

- divisions/classes
- customers
- service item catalog
- accounting references
- job/customer refs

### Sitelayer is authoritative for

- blueprint measurement snapshots
- takeoff history
- schedules and daily confirmation
- crew assignment history
- derived margin and bonus analytics

### Shared values must be normalized

Normalize:

- division labels
- service item names
- rate units
- QBO references
- status values

## 4. What Was Added by the Requirements Doc

The requirements doc formalized several things the client did not say as explicitly, but which are consistent with the workflow:

- explicit source-of-truth rules
- explicit data model entities
- explicit workflow stages
- explicit sync provenance and drift tracking
- explicit inventory/rental separation as a future bounded context

These are sensible formalizations, but they should be treated as architecture decisions, not sacred user quotes.

## 5. What Would Go Outside the Original Ask

These are valid future ideas, but they were not the original core request:

- broad ERP behavior
- write-back as the default pattern
- making Sitelayer the source of truth for external accounting data
- making rentals/inventory part of the core estimating flow
- overbuilding adjacent integrations too early
- making bonus rules hyper-configurable before the core job-costing flow is stable

## 5.1 Priority Order

Build the client-requested workflow first. Treat everything else as secondary until the core loop works end-to-end.

### Core first

1. project setup
2. blueprint upload and takeoff
3. estimate generation
4. QBO-backed customers, divisions, and service items
5. schedule-driven time capture
6. margin and bonus tracking
7. sync and reconciliation for the core accounting flow

### Later, only after the core is stable

1. blueprint version tracking
2. change order reconciliation
3. Bluebeam bridge
4. CompanyCam / daily report audit trail
5. builder templates
6. rentals / inventory as a separate bounded context
7. other adjacent integrations discovered in broader research

The key rule is that adjacent workflows are not the target until the client’s original operational loop is working cleanly.

## 6. Final Architecture Direction

### 6.1 Stack choice

Use a mostly TypeScript stack.

Recommended baseline:

- React + TypeScript frontend
- TypeScript API/backend
- TypeScript worker for sync and background jobs
- DigitalOcean Managed Postgres
- DigitalOcean Spaces
- Clerk for auth
- DigitalOcean App Platform for deployment

### 6.2 Why TypeScript

For this project, TypeScript is the right default because:

- the domain is not obviously performance-bound
- the hard problems are workflow correctness, sync, and domain coordination
- shared types reduce bugs and refactor cost
- one developer plus AI tooling benefits from a single language
- one language across frontend, API, and worker reduces boundary complexity

Go should only be introduced later if a real need appears, such as:

- heavy parsing or PDF/image processing
- massive background workloads
- a truly performance-critical worker

### 6.3 Architecture shape

Use a modular monolith plus one worker.

Do not split the core product into many internal services.

Core modules:

- identity and tenancy
- projects and customers
- takeoff and documents
- scheduling and time
- accounting sync
- costing, margin, and bonuses
- reporting and analytics
- integration adapters

### 6.4 Multi-company scaling

The architecture must be built for more than one company from day one.

That means:

- every record is tenant-scoped by company
- auth membership is company-aware, not global-only
- project, customer, worker, and integration data are isolated per company
- background jobs always carry a company context
- sync cursors are tracked per company and per integration
- file storage paths are namespaced by company and project
- per-company rates, mappings, bonus rules, and templates are first-class data

The key rule is that new companies should be a configuration problem, not a code fork.

Scaling expectations:

- small multi-tenant SaaS first
- shared-schema, single-cluster Postgres first
- many companies on one Postgres cluster
- per-tenant performance isolation through indexes, query discipline, and job partitioning
- only consider shard or database partition strategies later, after there is real load pressure

Operationally, this implies:

- tenant-aware authorization everywhere
- tenant-aware audit logging
- per-company sync retry queues
- per-company rate limits for external API calls
- tenant-specific feature flags where needed

Implementation rule:

- use `company_id` as the hard boundary on every tenant-owned row
- resolve an `active_company_id` for every authenticated request
- carry `company_id` through every worker job and webhook handler
- key sync cursors by `company_id + integration_connection_id`
- namespace storage keys by `company_id/project_id/document_id`

Auth model:

- use Clerk for identity
- map Clerk orgs or memberships to internal companies
- allow a user to belong to multiple companies
- require explicit company switching when needed
- keep internal `company_id` distinct from vendor org IDs so auth providers can change later

Data partition model:

- shared schema for companies, memberships, customers, projects, workers, schedules, labor, integrations, sync state, and audit logs
- blob storage for blueprint PDFs and photos
- partition later only if load forces it

Good later partition candidates:

- labor entries
- takeoff measurements
- sync events
- mutation outbox
- audit logs

Do not partition early:

- companies
- projects
- customers
- integration connections
- company settings

This is the safest way to scale the product without creating a 5-6 service architecture or a per-customer deployment model.

### 6.5 Core dependencies vs adapters

Core platform dependencies:

- DigitalOcean App Platform
- DigitalOcean Managed Postgres
- DigitalOcean Spaces
- Clerk
- your API
- your worker
- your sync protocol

Self-contained third-party services:

- QuickBooks Online
- Xero
- STACK
- Bluebeam
- Google Drive / OneDrive / Dropbox
- DocuSign / PandaDoc / Dropbox Sign
- CompanyCam
- QB Time / ClockShark / Workyard

The third-party systems should be adapters, not architectural pillars.

### 6.6 Extensibility guardrails

To avoid overfitting to the first customer while still supporting their real workflow:

- hard-code the workflow shape
- configure the business content
- adapter-ize the outside world

Product-wide invariants:

- company / tenant scoping
- core domain objects
- workflow stages
- sync model
- derived math
- audit and provenance
- permission model
- conflict policy classes

Tenant-configurable data:

- taxonomy and display names
- service catalog templates
- pricing and rates
- bonus policy knobs within a bounded formula framework
- workflow defaults
- external mappings
- onboarding templates

Adapter/plugin boundaries:

- QBO
- Xero
- time tools
- takeoff/file systems
- e-signature systems
- storage providers
- OCR/document extraction
- sync backends

Do not plugin-ize the core domain math, workflow stages, or company scoping.

Per-company config should include:

- pricing profiles
- labor rates
- project overrides
- bonus rules
- mapping rules
- service-item mappings
- division labels or templates
- feature flags
- import/export preferences

Per integration connection, store:

- provider name
- provider account ID
- access token / refresh token
- webhook secret
- sync cursor
- last sync timestamp
- retry state
- rate-limit state
- connection status

Worker rule:

- sync jobs run per company and per provider connection
- no global sync cursor shared across tenants
- retries are queued per company so one tenant cannot block others

## 7. Offline Strategy

Do not start with a full CRDT/local-first platform.

Use a simpler, practical offline strategy:

- cache read models locally
- queue writes locally as an outbox
- use client-generated UUIDs for offline mutations
- sync by cursor
- keep append-only entities append-only
- use explicit conflict rules instead of automatic merge magic

Good offline targets:

- daily schedule confirmation
- time entry drafts
- project notes
- takeoff annotations / measurements
- mapping review queues

Not worth forcing offline on day one:

- accounting sync
- vendor connector setup
- long-running reconciliation jobs

If stronger offline behavior becomes necessary later, wrap the app in a native shell or adopt a stronger sync layer, but do not start there.

## 8. Sync Model

Use a Postgres-backed push/pull sync model:

- `sync_pull(cursor)` returns changed records and tombstones
- `sync_push(mutations[])` accepts idempotent writes
- track `sync_cursors`, `entity_versions`, and `mutation_outbox`
- store provenance for imported external records
- keep sync retryable and idempotent

Conflict policy:

- time entries and measurements: append, then reconcile
- schedules and drafts: last-write-wins or reviewer resolution
- mappings and bonus rules: human review if conflicting edits happen

## 9. Greenfield Data Model

Core entities:

- Company
- User membership
- Customer
- Division
- Project
- Service item
- Blueprint document
- Takeoff measurement
- Estimate line
- Worker
- Crew schedule
- Labor entry
- Integration connection
- Sync event / provenance
- Bonus rule
- Material bill
- Rental item, later and separate

Storage principles:

- use relational columns for primary business data
- use metadata only for external refs, payload snapshots, sync state, and audit provenance
- do not make JSON blobs the primary domain model

## 10. Recommended Package Split

- `apps/web` - Next.js PWA, takeoff, field flows
- `apps/api` - HTTP API, auth guards, commands/queries
- `apps/worker` - sync jobs, reconciliation, imports/exports
- `packages/domain` - entities, invariants, calculations
- `packages/integrations` - QBO/Xero/STACK/etc adapters
- `packages/sync` - cursors, outbox, conflict rules
- `packages/ui` - shared components
- `packages/db` - schema, migrations, query helpers

## 11. Implementation Phases

### Phase 1: Foundation

- identity and tenancy
- canonical division/customer/service-item model
- project core
- storage and authorization
- basic API and data access layer

### Thin-slice prototype rule

Build the client-requested workflow as thin vertical slices:

1. tenant + project shell
2. blueprint takeoff core
3. field workflow
4. accounting sync core
5. margin and bonus analytics

For each slice:

- define a short spec card
- model the minimum domain objects
- build against fake data or a fake adapter
- run a fixture or contract check
- demo the slice end to end
- only then replace the fake adapter with a real one

Keep these simulated until the base loop is validated:

- QBO live sync
- Xero live sync
- Bluebeam
- CompanyCam
- rentals / inventory
- change orders
- blueprint version tracking
- cross-company benchmark exports
- advanced offline sync
- any write-back behavior

### Phase 2: Takeoff

- blueprint upload
- PDF rendering
- measurement capture
- estimate generation
- estimate PDF output
- save/load of measurement state

### Phase 3: Field Operations

- worker roster
- schedules
- daily confirmation
- labor entry capture
- draft-to-confirm workflow

### Phase 4: QBO Sync

- customers
- estimates
- bills
- time activities
- provenance and drift
- mapping review and exception handling

### Phase 5: Analytics

- margin dashboards
- division rollups
- labor efficiency
- bonus logic
- historical verification

### Phase 6: Extensions

- blueprint version tracking
- change order reconciliation
- Bluebeam bridge
- CompanyCam / daily report timeline
- builder templates
- forecasting
- rentals/inventory as a separate module

## 12. Build Order Summary

The strict order for the original client workflow is:

1. core platform foundation
2. project setup and division/customer selection
3. blueprint upload and takeoff
4. estimate generation
5. schedule-driven time capture
6. margin and bonus analysis
7. QBO sync and reconciliation

The later expansion set should stay deferred until that loop works:

- blueprint version tracking
- change order reconciliation
- Bluebeam
- CompanyCam
- builder templates
- rentals / inventory
- broader adjacent integrations

## 13. What To Keep Out Of The Core

- no write-back by default
- no broad ERP scope
- no rental/inventory inside estimating
- no direct UI coupling to external APIs
- no premature microservices
- no workflow SaaS sprawl unless it becomes unavoidable
- no separate deployment per company
- no hardcoded L&A divisions as global product constants
- no shared integration state across tenants
- no company-specific code forks

## 14. Practical Build Order

If starting fresh, build in this order:

1. canonical data model and auth
2. project, customer, and division management
3. takeoff and estimate engine
4. schedule-to-daily-confirm workflow
5. QBO sync with mapping and drift tracking
6. margin and bonus analytics
7. selective extensions only after the core is stable

## 15. Final Recommendation

The safest and cleanest path is:

- TypeScript end-to-end
- DigitalOcean for hosting, database, and storage
- Clerk for auth
- one API
- one worker
- offline through local cache + outbox sync first
- more advanced sync only if the field workflow proves it needs more

That gives you an extensible architecture without turning the product into a pile of versioned services and sync hell.
