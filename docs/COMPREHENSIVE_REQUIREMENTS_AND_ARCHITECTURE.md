# Sitelayer Requirements and High-Level Architecture

Source consolidation for the current Sitelayer/L&A workflow. This document merges the QBO extraction notes, workflow analysis, chat transcript requirements, and the current app shape into one implementation brief.

## 1. Product Goal

Sitelayer is an operations platform for L&A that connects:

- blueprint intake and takeoff
- project setup and estimating
- field scheduling and time tracking
- QBO sync for accounting and job costing
- performance analysis and bonus calculations

The core business problem is manual re-entry across disconnected tools:

- email and Google Drive for plans
- PlanSwift for takeoff
- QuickBooks Online for estimates, billing, and accounting
- T-Sheets/time tracking for labor

The intended result is a single operational layer where the estimate, project, crew activity, and financial performance stay linked.

## 2. Canonical Business Requirements

### 2.1 Divisions are fixed and authoritative

L&A operates with 9 QBO classes/divisions:

- D1 Stucco
- D2 Masonry
- D3 Siding
- D4 EIFS
- D5 Paper and Wire
- D6 Snow Removal
- D7 Warranty
- D8 Overhead
- D9 Scaffolding

EIFS is the core revenue driver, but the platform must support all 9 divisions for rollups and reporting.

### 2.2 Service items are broader than takeoff items

QBO contains 50+ service items, but they are not all estimating items.

There are two categories:

- curated measurable items used in takeoff and production
- accounting/admin items used for billing, deposits, holdbacks, credits, change orders, and similar transactions

The curated takeoff subset currently includes items like:

- EPS
- Basecoat
- Finish Coat
- Air Barrier
- Envelope Seal
- Cementboard
- Cultured Stone
- Caulking
- Flashing

The platform must treat the curated scope list as a deliberate subset, not as the full QBO catalog.

### 2.3 Customers come from QBO and can be builder names or addresses

The customer model needs to support:

- builder accounts like Foxridge Homes and Streetside Developments
- address-based job names such as 6 Thompson Court
- contractor/partner entities like Vulcan Construction

Customer search and selection must be dynamic and QBO-backed, not hardcoded.

### 2.4 Pricing is layered

Pricing needs to support:

- company default rates
- project-level overrides
- builder-specific or template-driven pricing in the future
- labor hourly rates
- material/unit rates
- bid rates at the project level

The bid rate is the project total pricing model. It is not the same as the scope-item rate used for breakdowns.

### 2.5 Bonus logic is a first-class business requirement

The business wants margin-based supervisor bonuses.

The platform must support:

- actual vs bid margin
- tiered bonus rules
- project-specific and division-specific eligibility
- historical reporting for bonus verification

The current bonus structure is EIFS-first, but the architecture needs to generalize to all divisions.

## 3. Functional Requirements

### 3.1 Project and customer management

The system must:

- create and search projects
- assign each project to one primary division
- link each project to a customer/builder
- preserve address, status, bid rate, labor rate, and cost metadata
- support project state transitions from lead to active to post-mortem

### 3.2 Takeoff and estimating

The system must:

- upload blueprint PDFs
- render and measure plans
- support zoom, pan, scale calibration, and polygon drawing
- compute quantities from drawn zones
- generate live estimates from quantities and rates
- persist takeoff measurements back to the project record
- produce exportable estimate PDFs

### 3.3 Field workforce operations

The system must:

- manage the worker roster
- support weekly scheduling
- prepopulate expected crew assignments
- create daily labor entries from schedules
- let a foreman confirm or edit the day quickly
- capture project, worker, service item, and hours for each entry
- support a low-friction mobile workflow

### 3.4 Financial tracking and analysis

The system must:

- track actual labor hours against project budget
- compute actual labor rate and margin
- roll up costs by project and division
- support labor by item, labor by worker, and labor by week reporting
- track bonus eligibility and payout amounts
- support post-mortem analysis without manual spreadsheet assembly

### 3.5 QBO integration

The system must:

- authenticate with QuickBooks Online
- sync accepted estimates into projects/jobs
- sync bills into project material costs
- sync time activity into labor entries
- map QBO customer refs to local projects
- preserve external IDs and sync metadata
- support sandbox and live environments

### 3.6 Document and storage handling

The system must:

- store blueprint PDFs in DigitalOcean Spaces (S3-compatible) when `DO_SPACES_*` are configured, otherwise on the local FS volume (`apps/api/src/storage.ts`)
- serve downloads via the API: `GET /api/blueprints/:id/file` proxies the file through the Node server (presigned-URL/direct-download is on the post-pilot roadmap, not shipped)
- preserve project-document linkage
- allow replacement/remeasurement without losing history

## 4. Current Implementation Shape

The codebase already has the skeleton of the product:

- `Projects` list and detail views
- `NewTakeoff` project creation flow
- `Documents` flow for blueprint upload and estimate generation
- `BlueprintCanvas` for PDF rendering and polygon takeoff
- `Schedule`, `Workers`, and `DailyConfirm` for crew operations
- `Settings` for company rates and QBO integration
- `/api/integrations/qbo/auth`, `/callback`, and `/sync` HTTP endpoints (`apps/api/src/server.ts`)

The current backend data model already includes (canonical source: `docker/postgres/init/*.sql`):

- `companies`, `company_memberships` — multi-tenant + Clerk role mapping
- `projects`, `customers`
- `labor_entries`, `workers`, `crew_schedules`, `clock_events`
- `blueprint_documents`, `takeoff_measurements`
- `estimate_lines`, `service_items`, `service_item_divisions`, `divisions`, `pricing_profiles`, `bonus_rules`
- `material_bills`, `rentals`
- `integration_connections`, `integration_mappings` — per-provider OAuth state and external entity refs
- `mutation_outbox`, `sync_events`, `audit_events`, `notifications` — outbox/sync/audit/notification ledgers (queue leasing is in-place on `mutation_outbox` and `sync_events` via `FOR UPDATE SKIP LOCKED`, not a separate `queue_leases` table)

The app is therefore not a blank slate. The main job is to tighten the domain model, finish the missing workflow edges, and harden sync/reconciliation.

## 5. Source-of-Truth Rules

### 5.1 QBO is authoritative for business taxonomy

Use QBO as the source of truth for:

- divisions/classes
- customers
- service item catalog
- accounting refs and job/customer refs

### 5.2 Sitelayer is authoritative for operational workflow

Use Sitelayer as the source of truth for:

- blueprint measurement snapshots
- project-level takeoff history
- schedule and daily confirmation
- crew assignment history
- derived margin and bonus analytics

### 5.3 Shared values must be normalized

The app should normalize:

- division labels
- service item names
- rate units
- QBO refs
- status values

This avoids the current risk of formatting differences like `Paper and Wire` vs `Paper & Wire`.

## 6. Data Model Architecture

### 6.1 Core entities

The domain should be centered on these entities:

- Company
- Division
- Customer
- Project
- Service Item
- Blueprint Document
- Takeoff Measurement
- Estimate Line
- Worker
- Crew Schedule
- Labor Entry
- Integration
- Bonus Rule
- Material Bill
- Rental/Inventory Item

### 6.2 Suggested relationship model

```text
Company
  ├── Customers
  ├── Projects
  │   ├── Division
  │   ├── Customer
  │   ├── Blueprint Documents
  │   ├── Takeoff Snapshots
  │   ├── Estimate Lines
  │   ├── Crew Schedules
  │   ├── Labor Entries
  │   ├── Material Bills
  │   ├── Bonus Calculations
  │   └── Sync Metadata
  ├── Workers
  ├── Integrations
  └── Pricing Profiles
```

### 6.3 Persistence guidance

Use relational columns for:

- primary business keys
- division
- customer
- project status
- labor hours
- dates
- rates

Use `jsonb` metadata for:

- QBO refs
- project-specific rates
- takeoff summary snapshots
- sync result payloads
- external document links

## 7. Workflow Architecture

### 7.1 Intake and estimating

Flow:

1. Lead enters from customer / blueprint / email source
2. Project is created with division, customer, bid rate, and labor assumptions
3. Blueprint PDF is uploaded
4. Scale is calibrated
5. Polygons are drawn against scope items
6. Estimate totals are generated
7. Estimate PDF is produced

### 7.2 Production and field confirmation

Flow:

1. Weekly schedule is created
2. Daily labor drafts are auto-created from schedule
3. Foreman reviews and edits hours/service items
4. Day is confirmed
5. Confirmed entries feed job costing and bonus calculations

### 7.3 Sync and reconciliation

Flow:

1. QBO accepted estimate is mapped to a project
2. QBO bills are imported into material cost
3. QBO time activity is imported into labor entries
4. Local records are compared to QBO refs for drift
5. Exceptions are surfaced for review

### 7.4 Closeout and analysis

Flow:

1. Project is closed
2. Final margin and bonus calculations are frozen
3. Division and supervisor analysis is generated
4. Historical data is retained for future estimating

## 8. High-Level Technical Architecture

### 8.1 Frontend

React/Vite should remain the primary client shell.

Recommended frontend structure:

- global shell and navigation
- dashboard
- project detail
- new project/takeoff flow
- blueprint measurement canvas
- documents and estimate output
- time tracking tabs
- schedule
- crew roster
- settings/integrations

The UX should stay mobile-first for the field workflows, but full desktop support is required for estimating and management.

### 8.2 Backend

Postgres should remain the operational store. The current app uses:

- managed Postgres (DigitalOcean) with raw `pg` driver — no ORM
- app-layer company scoping via `getCompany()` membership checks (Clerk JWT once `CLERK_JWT_KEY` is set + `AUTH_ALLOW_HEADER_FALLBACK` flipped off)
- plain Node HTTP handlers for QBO OAuth and sync (`apps/api/src/server.ts`)
- DigitalOcean Spaces (S3-compatible) for blueprint assets when configured; local FS fallback otherwise (`apps/api/src/storage.ts`)

Backend responsibilities:

- auth and multi-tenant access
- CRUD for company/project/time entities
- external sync jobs
- calculation queries and views
- audit and reconciliation metadata

### 8.3 Integration layer

Use explicit adapters for external systems:

- QBO adapter for accounting and customer/job sync
- blueprint/takeoff asset adapter for PDF storage and retrieval
- future PlanSwift adapter if import becomes necessary
- future inventory/rental adapter as a separate module

Do not embed integration assumptions into the UI. Keep all external refs behind the domain layer.

### 8.4 Calculation layer

All business math should be derived from persisted inputs:

- sqft from takeoff
- bid total from rates
- actual labor cost from hours × labor rate
- total job cost from labor + materials + subs
- margin from revenue − cost
- bonus from margin rules

This should be computed in shared utilities or DB views, not duplicated across components.

## 9. Key Product Decisions

### 9.1 Curated takeoff items are intentional

The takeoff UI should not expose all QBO service items.

It should expose only the measurable construction items that the crew and estimator actually use.

The broader QBO catalog remains available for accounting and sync.

### 9.2 Project-specific pricing overrides are required

Project-level rates override company defaults.
This is necessary for builder-specific pricing and special jobs.

### 9.3 Bid total and scope rates are different concepts

The app must keep these separate:

- bid total = total project pricing
- scope rate = item-level unit price

The current architecture and UI should continue to reinforce this distinction.

### 9.4 Daily confirmation must be low friction

The preferred workflow is:

- schedule prepopulates
- foreman confirms daily work
- edits are minimal
- worker participation is nearly zero-touch

This is important for adoption.

### 9.5 Inventory/rentals are a separate bounded context

Scaffolding/rentals should not be bolted into the core estimating model.

Treat it as a future extension with its own cost tracking and QBO mapping.

## 10. Recommended Implementation Phases

### Phase 1: Stabilize the domain model

- normalize divisions and service items
- formalize customer/project references
- add explicit pricing profile structures
- document QBO ref handling

### Phase 2: Harden takeoff and estimate generation

- finish save/load of blueprints and measurements
- support pointer-anchored zoom/pan behavior
- preserve measurement snapshots
- keep scope-item and bid-total logic separate

### Phase 3: Make field confirmation production-grade

- improve schedule-to-draft-entry generation
- support fast foreman review/edit/confirm
- add better handling for no-shows and subs
- make mobile time capture less brittle

### Phase 4: Harden QBO sync

- verify account mappings
- reconcile imported estimates, bills, and time activities
- track sync status and drift
- store sync provenance per entity

### Phase 5: Add management analytics

- live margin dashboard
- labor vs sqft efficiency
- division-level P&L
- bonus tracking and payout visibility
- crew/supervisor performance views

### Phase 6: Expand carefully

- inventory/rental module
- builder templates
- forecasting and planning
- richer reporting exports

## 11. Risks and Gaps

### 11.1 QBO account mapping is not fully verified

The screenshots verify divisions and service items, but not account mapping details.

That means bill/time posting rules still need a real QBO admin check.

### 11.2 Service item catalog could drift

If QBO item names change, the curated takeoff list could break or go stale.

This argues for a normalization layer and periodic validation.

### 11.3 Takeoff UX still has a few usability gaps

From the chat feedback:

- zoom should anchor more naturally to pointer position
- saved profiles/state would reduce rework
- the canvas should feel more like a usable takeoff tool, not a static PDF viewer

### 11.4 Adoption depends on low-friction field entry

If daily confirmation becomes too manual, users will resist it.

The architecture should bias toward schedule-derived defaults and one-tap confirmation.

## 12. What Already Looks Correct

- The 9 division taxonomy matches QBO.
- The takeoff catalog is correctly a curated subset.
- Customers are treated as dynamic QBO-backed data.
- Company and project rate overrides already exist.
- Schedule plus daily confirm is the right production workflow direction.
- QBO OAuth/sync already exists as a foundation.

## 13. Bottom Line

Sitelayer should be built as a job-costing and production-control layer for L&A, not a generic ERP.

The architecture should keep these boundaries clean:

- QBO = business/accounting source of truth
- Sitelayer = operational workflow and margin intelligence
- takeoff = curated measurable scope items
- time tracking = schedule-driven, low-friction crew confirmation
- analytics = derived from production history and cost data

That design matches the docs, matches the current codebase, and leaves room for rentals/inventory later without contaminating the core estimating workflow.
