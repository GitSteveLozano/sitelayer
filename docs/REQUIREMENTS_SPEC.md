# Sitelayer Requirements Spec

## Purpose

Build a construction operations layer for L&A that connects estimating, project setup, field scheduling, time capture, accounting sync, and margin/bonus analysis.

The product is a derived-insight layer, not a replacement ERP.

## Core Principles

- QBO is authoritative for business taxonomy and accounting references.
- Sitelayer is authoritative for operational workflow and derived analytics.
- The system should be pull-first and insight-driven.
- The platform should normalize data across tools, not replace them.
- Field workflows must stay low-friction.

## Canonical Business Requirements

### Divisions

Support 9 fixed divisions/classes:

- D1 Stucco
- D2 Masonry
- D3 Siding
- D4 EIFS
- D5 Paper and Wire
- D6 Snow Removal
- D7 Warranty
- D8 Overhead
- D9 Scaffolding

These divisions are authoritative and must exist exactly as business taxonomy.

### Service Items

Support a curated takeoff catalog, not the full QBO service catalog.

The takeoff catalog must focus on measurable construction items, while QBO can retain a broader catalog for billing and accounting.

### Customers and Jobs

Support dynamic customers and job names from QBO, including:

- builder names
- contractor names
- address-based job names

The customer list must not be hardcoded.

### Pricing

Support layered pricing:

- company default rates
- project overrides
- labor hourly rates
- material/unit rates
- project bid total

Bid total is not the same thing as scope-item unit pricing.

### Bonuses

Support margin-based supervisor bonuses as a first-class feature.

Bonus logic must be able to generalize beyond EIFS and support company-wide reporting.

## Functional Requirements

### Project Management

The system must:

- create, search, and update projects
- assign one primary division per project
- link each project to one customer or builder
- preserve address, status, bid rate, labor rate, and cost metadata
- support project lifecycle transitions from lead to active to post-mortem

### Takeoff and Estimating

The system must:

- upload blueprint PDFs
- render plans
- support zoom, pan, scale calibration, and polygon drawing
- compute quantities from drawn zones
- generate live estimates from quantities and rates
- persist takeoff measurements back to the project record
- produce exportable estimate PDFs

### Field Workforce Operations

The system must:

- manage the worker roster
- support weekly scheduling
- prepopulate expected crew assignments
- create daily labor entries from schedules
- let a foreman confirm or edit the day quickly
- capture project, worker, service item, and hours for each entry
- support a low-friction mobile workflow

### Financial Tracking and Analysis

The system must:

- track actual labor hours against project budget
- compute actual labor rate and margin
- roll up costs by project and division
- support labor by item, labor by worker, and labor by week reporting
- track bonus eligibility and payout amounts
- support post-mortem analysis without manual spreadsheet assembly

### QBO Integration

The system must:

- authenticate with QuickBooks Online
- sync accepted estimates into projects or jobs
- sync bills into project material costs
- sync time activity into labor entries
- map QBO customer references to local projects
- preserve external IDs and sync metadata
- support sandbox and live environments

### Document and Storage Handling

The system must:

- store blueprint PDFs in object storage
- create signed URLs on demand
- preserve project-document linkage
- allow replacement or remeasurement without losing history

## Source-of-Truth Rules

### QBO Is Authoritative For

- divisions and classes
- customers
- service item catalog
- accounting references
- job and customer references

### Sitelayer Is Authoritative For

- blueprint measurement snapshots
- takeoff history
- schedule and daily confirmation
- crew assignment history
- derived margin and bonus analytics

### Shared Values Must Be Normalized

The app must normalize:

- division labels
- service item names
- rate units
- QBO references
- status values

## Non-Goals

- Do not build a replacement accounting system.
- Do not build a write-heavy workflow engine.
- Do not make the platform the source of truth for external accounting data.
- Do not expose the full QBO service catalog in takeoff.
- Do not treat rentals or inventory as part of the core product.

## Risks and Open Gaps

- QBO account mapping must be verified.
- Service item names can drift over time.
- Takeoff UX must be precise enough to earn trust.
- Daily confirmation must stay low-friction or adoption will fail.
- Bonus calculations must remain auditable and stable.

## Success Criteria

The product is successful if:

- project setup is fast and consistent
- takeoff data becomes reusable operational data
- field time entry is simple enough to adopt
- QBO sync is reliable and explainable
- margin and bonus views reflect real job economics
- the system improves visibility without becoming a second accounting stack

