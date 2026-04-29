# Rentals / Inventory Replacement Spec

Last updated: 2026-04-28

## Working Assumption

Sitelayer is not intended to integrate deeply with Avontus as the source of truth. Avontus is the reference workflow the scaffolding/rental side wants to replace:

- track rentable inventory
- know what gear is out on each job
- bill rentals on a 25-day cycle per job
- bill selected items at an agreed job price
- reduce manual re-entry into QuickBooks

The existing Sitelayer rental module is a useful proof of concept, but it is not a full replacement for this workflow.

## Current Sitelayer State

Implemented:

- `rentals` table with one row per rental entry
- optional `project_id` and `customer_id`
- `daily_rate`, `delivered_on`, `returned_on`
- configurable `invoice_cadence_days`
- manual invoice trigger
- worker-driven automatic billing for due rental rows
- rental billing currently creates `material_bills` rows with `bill_type='rental'`

Important limitation:

Current rental billing behaves like a job-cost/material ledger. It is not yet a customer-facing rental invoice system.

## Required Replacement Capability

### Inventory Catalog

Track rentable items independently from jobs.

Minimum fields:

- item code / SKU
- description
- category
- unit of measure
- default rental rate
- replacement value
- active/inactive status
- serialized vs non-serialized flag

Future fields:

- barcode / QR code
- inspection requirements
- weight
- dimensions
- purchase cost
- vendor

### Inventory Balances

Track available and deployed quantities.

Minimum location types:

- yard / branch
- job site
- in transit
- repair / unavailable
- lost / damaged

For non-serialized scaffold parts, quantity movement is enough. For serialized assets, the system needs per-asset identity.

### Job Rental Contract

Each job should have rental billing settings.

Minimum fields:

- project id
- customer id
- billing cycle days, default `25`
- billing mode, initially `arrears`
- billing start date
- next billing date
- status: draft, active, paused, closed
- notes

This should replace the current pattern where every rental row carries its own independent billing cadence.

### Job Rental Lines

Track what item quantities are rented on the job and at what agreed price.

Minimum fields:

- contract id
- inventory item id
- quantity
- agreed rental rate
- rate unit: day, cycle, week, month, each
- on-rent date
- off-rent date
- taxable flag
- billable flag

This handles “select items by agreed price.”

### Delivery / Return Events

Inventory movement should be auditable.

Minimum event types:

- deliver to job
- partial return
- full return
- transfer between jobs
- mark damaged
- mark lost
- adjust count

Each event should record:

- project / job
- inventory item
- quantity
- event date
- user
- notes
- optional document/ticket number

### Rental Billing Runs

A billing run should group billable job rental lines for one billing period.

Minimum behavior:

- one billing run per job per cycle
- default cycle length is 25 days
- include selected billable lines only
- calculate charge from agreed price, quantity, and billable period
- record billing period start/end
- produce invoice draft lines
- mark what period each line has been billed through

The system must avoid double-billing the same item/period.

Billing runs should be modeled as deterministic workflows, not only database status updates. See
`docs/DETERMINISTIC_WORKFLOWS.md`.

The billing review UI should be a headless workflow surface: render the current
billing-run snapshot, show allowed next events, collect human input, and dispatch
events back to the API. React components should not carry hidden billing-process
transitions.

Initial billing-run states:

- `generated`
- `approved`
- `posting`
- `posted`
- `failed`
- `voided`

Allowed events:

- `APPROVE`
- `POST_REQUESTED`
- `POST_SUCCEEDED`
- `POST_FAILED`
- `RETRY_POST`
- `VOID`

### QuickBooks Direction

Likely target:

- create customer-facing QuickBooks invoices for rental charges
- map rental income to configured QBO service items/accounts
- keep job-cost visibility separate from customer invoice creation

The current `material_bills` path is not enough because it represents cost-side bills, not revenue invoices to customers.

## MVP Data Model

Proposed new tables:

- `inventory_items`
- `inventory_locations`
- `inventory_movements`
- `job_rental_contracts`
- `job_rental_lines`
- `rental_billing_runs`
- `rental_billing_run_lines`

The existing `rentals` table can remain as a legacy/prototype ledger until the replacement flow is stable.

## MVP Screens

### Inventory

- searchable item list
- available / out / damaged counts
- create/edit item
- import CSV

### Job Rentals

- pick a project
- show active rental contract
- add items and quantities
- set agreed price
- record delivery and return
- view current billable items

### Billing

- due jobs list
- preview 25-day billing run
- select/exclude lines
- create invoice draft
- push/sync to QBO after review

## Build Order

1. Add inventory catalog and movement tables.
2. Add job rental contracts with default 25-day cycle.
3. Add job rental lines with agreed pricing.
4. Add delivery/return movement endpoints.
5. Add billing-run calculation in domain tests first.
6. Add billing-run API and review UI.
7. Add QBO invoice draft/push path.
8. Migrate or retire the existing lightweight `rentals` ledger.

## Implementation Progress

2026-04-28:

- Added rental/inventory replacement schema migration:
  - `inventory_items`
  - `inventory_locations`
  - `inventory_movements`
  - `job_rental_contracts`
  - `job_rental_lines`
  - `rental_billing_runs`
  - `rental_billing_run_lines`
- Added domain billing helpers for job rental contracts:
  - 25-day default billing cycle
  - cycle/day/week/month/each rate units
  - line-level on/off-rent clipping
  - line-level last-billed-through clipping to avoid double billing
  - deterministic rental billing workflow transitions
- Added backend API routes for:
  - inventory item CRUD
  - inventory locations
  - inventory movements
  - project rental contracts
  - job rental lines
  - billing run preview
  - billing run generation
- Added workflow-state columns on rental billing runs for eventual XState/Temporal ownership:
  - `state_version`
  - `approved_at`
  - `approved_by`
  - `posted_at`
  - `failed_at`
  - `error`
  - `workflow_engine`
  - `workflow_run_id`
- Added `docs/DETERMINISTIC_WORKFLOWS.md`.
- Documented the headless UI process model for rental billing screens:
  - backend workflow state remains authoritative
  - XState can interpret the same state/event vocabulary on the frontend
  - future Temporal workflows should coordinate the same deterministic process
- QBO invoice push remains environment-gated; the catalog/rentals UI has been polished for the current internal workflow.

2026-04-29:

- Expanded inventory availability from active-rental rollups only to movement-ledger stock totals plus active rentals:
  - `total_stock_quantity`
  - `available_quantity`
  - `yard_quantity`
  - existing `on_rent_*` rollups
- Added `019_inventory_availability_totals.sql` to replace `get_inventory_availability(company_uuid)` with the expanded return shape.
- Updated the inventory catalog UI to show tracked stock, available quantity, and on-rent quantity.
- Expanded import UX to handle CSV/TSV uploads and rows copied from Excel/Sheets.

## Open Questions

- Are rental charges daily-rated but invoiced every 25 days, or flat-priced per 25-day cycle?
- Do some items bill by quantity while others bill as a bundle/package?
- Are scaffold parts tracked mostly by quantity, or do any assets require serial numbers immediately?
- Should delivery tickets be printable/exportable in MVP?
- Should customer invoices be pushed directly to QBO, or staged for office approval first?
- Is the 25-day cycle universal, per customer, or per job?
- Do returns stop billing on return date, end of cycle, or next billing run?

## Recommendation

Treat this as a separate rentals/inventory module, not as an extension of estimating. The shared connection point should be the project/job and QBO customer mapping. That keeps scaffold rental billing from contaminating the existing takeoff/estimate workflow while still giving Sitelayer job-cost and margin visibility.
