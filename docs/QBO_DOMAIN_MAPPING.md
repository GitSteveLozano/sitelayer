# QBO Domain Mapping

## Source-Of-Truth Rules

QuickBooks Online is authoritative for accounting identifiers and accounting taxonomy. Sitelayer stores local operational records and maps them to QBO references through `integration_mappings`.

Do not overload one QBO identifier for multiple concepts. In particular, the QBO realm/company ID belongs on the integration connection and must not be used as a customer, item, class, or estimate reference.

## Entity Mapping

| QBO Concept | Sitelayer Concept | Mapping Rule |
| --- | --- | --- |
| Realm / Company ID | `integration_connections.provider_account_id` | One QBO company per connection. Used only as API realm context. |
| Class | `divisions` | QBO Class maps to division code/name, e.g. D1-D9. Store external class ID in `integration_mappings` with `entity_type='division'`. |
| Item | `service_items` | QBO Item maps to service item. Classify locally as measurable, billing/accounting, or future cost category. Store external item ID with `entity_type='service_item'`. |
| Customer / Job | `customers` and `projects` | QBO customer/job records can represent builders, contractors, or address-style jobs. Store customer refs separately from project/estimate refs. |
| Estimate | `estimate_lines` plus project mapping | Sitelayer generates estimate lines from takeoff/pricing. QBO estimate ID maps to the local project with `entity_type='project'` or a future `estimate` entity. |
| Bill | `material_bills` | Inbound actual material/sub cost. Store QBO bill ID on `material_bills.external_id` and/or mapping row. |
| TimeActivity | `labor_entries` | Inbound or reconciled labor actuals. Preserve worker/date/project/service item where available. |

## Estimate Push Contract

Estimate push should use generated `estimate_lines`, not a single total-only line. Each pushed line needs:

- mapped QBO item reference
- quantity
- unit price
- amount
- description
- optional class/division reference

If any required mapping is missing, the UI should surface a mapping review step instead of guessing.

## Pricing Precedence

Use this precedence when generating local estimate lines:

1. project override
2. customer/builder pricing profile
3. company default pricing profile
4. QBO item rate
5. seeded fallback rate

The chosen source should be visible in the estimate line or audit payload so margin/bonus calculations are explainable later.

## Sync Behavior

Local development can simulate sync by backfilling mappings and marking local sync status. Live QBO sync must use:

- signed OAuth state
- company-scoped connection lookup
- token refresh handling
- row-level retry/error state
- explicit mapping records for every external reference

Background sync should not silently write to QBO. Any write-back must be a deliberate user action.
