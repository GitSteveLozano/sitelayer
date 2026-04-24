# Sitelayer Greenfield Architecture Plan

## Architecture Summary

Build a modular, pull-first construction operations platform with three layers:

1. source connectors
2. normalized operational model
3. derived insight and workflow UI

The design should avoid coupling the UI directly to external systems.

## Top-Level Domains

- identity and tenancy
- projects and customers
- takeoff and documents
- scheduling and time
- accounting sync
- costing, margin, and bonuses
- reporting and analytics
- future extensions such as rentals, inventory, and blueprint change tracking

## Recommended Data Model

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
- Sync event or sync provenance
- Bonus rule
- Material bill
- Rental item, kept separate later

## Storage Principles

Use relational columns for:

- IDs
- company, project, customer, division
- status
- dates
- hours
- rates
- amounts

Use structured metadata for:

- external references
- payload snapshots
- per-project overrides
- takeoff summaries
- sync state
- audit provenance

## Service Boundaries

### 1. Authentication and Tenancy

- user login
- company membership
- row-level authorization

### 2. Project Core

- create, edit, and search projects
- customer selection
- division assignment
- lifecycle state

### 3. Takeoff Service

- PDF upload
- rendering
- measurement capture
- estimate calculation
- estimate PDF generation

### 4. Field Operations Service

- worker roster
- schedule generation
- daily confirmation
- labor entry persistence

### 5. Accounting Connector

- QBO OAuth
- sync jobs
- mapping tables
- drift detection
- provenance tracking

### 6. Analytics Engine

- project margin
- division rollups
- labor efficiency
- bonus computation

### 7. Reporting Layer

- dashboard
- project views
- division views
- audit and exception views

## Integration Architecture

Build each external system as an adapter.

Adapter rules:

- keep adapters narrow and explicit
- normalize external objects into internal canonical records
- store the normalized record and the original external payload
- do not let the UI infer business meaning directly from external APIs

## Important Adapters

- QBO adapter
  - divisions and classes
  - customers
  - estimates
  - bills
  - time activities
  - job and customer references

- Document storage adapter
  - blueprint PDFs
  - signed URLs
  - versioned file history

- Future time tool adapter
  - schedule and labor hours
  - job code mappings

- Future takeoff import adapter
  - STACK export
  - Bluebeam upload bridge

- Future audit trail adapters
  - CompanyCam
  - daily reports
  - blueprint version tracking

## Workflow Architecture

### Intake and Estimating

1. receive blueprint
2. create project
3. assign division and customer
4. measure plan
5. generate estimate

### Production and Time Capture

1. create weekly schedule
2. generate daily drafts
3. foreman confirms
4. persist labor entries

### Sync and Reconciliation

1. pull QBO data
2. map external references to local projects
3. detect drift and missing records
4. surface exceptions for review

### Closeout and Analysis

1. freeze project results
2. compute final margin
3. compute bonus eligibility
4. retain history for future estimating

## Frontend Architecture

Primary screens:

- global shell
- dashboard
- projects
- project detail
- takeoff workspace
- documents
- time tracking
- settings
- reporting and exceptions

## UX Principles

- mobile-first for field workflows
- desktop-first for takeoff and management
- one-tap daily confirmation
- visible separation between bid total, scope rate, actual cost, and derived margin
- clear review states for mappings and sync exceptions

## Analytic Primitives

- bid total
- actual labor cost
- material cost
- sub cost
- gross margin
- labor efficiency
- division rollup
- bonus pool
- exception or drift flag

## Implementation Phases

### Phase 1: Foundation

- tenancy
- core entities
- canonical division/customer/service-item model
- storage and authorization

### Phase 2: Takeoff

- blueprint upload
- measurement capture
- estimate generation
- estimate PDF output

### Phase 3: Field Operations

- workers
- schedules
- daily confirmation
- labor entry capture

### Phase 4: QBO Sync

- customers
- estimates
- bills
- time activities
- provenance and drift

### Phase 5: Analytics

- margin dashboards
- division rollups
- labor efficiency
- bonus logic

### Phase 6: Extensions

- blueprint version tracking
- change order reconciliation
- Bluebeam bridge
- CompanyCam and daily report timeline
- rentals and inventory as a separate module

## What to Keep Out of the Core

- Do not add write-back by default.
- Do not merge rentals into estimating.
- Do not let the UI own canonical business meaning.
- Do not make external APIs the primary data model.
- Do not let bonus rules become hardcoded in the UI.

## First Five Things To Build

1. canonical data model and auth
2. project, customer, and division management
3. PDF takeoff and estimate engine
4. schedule-to-daily-confirm workflow
5. QBO sync with mapping and drift tracking

## Practical Rule

If a feature increases normalized cross-tool visibility without introducing new state ownership, it fits this architecture.

If it turns the platform into a system of record for someone else’s data, it does not.
