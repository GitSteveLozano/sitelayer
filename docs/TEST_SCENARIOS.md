# Test Scenarios — YAML-driven fixture builder

Stand up a tenant with arbitrary state in one command. Use this when:

- A test needs more than the single stuck-mid-flight row that
  `apps/api/scripts/seed-e2e-fixtures.ts` primes.
- A reproducer needs a specific deterministic-workflow event sequence
  walked through the registered reducer (so the `workflow_event_log`
  rows match what production would have written).
- A perf smoke needs a high-cardinality tenant (500 takeoffs, 50
  projects, ...).

## TL;DR

```bash
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer \
  npx tsx scripts/seed-scenario.ts scenarios/mid-flight-rental.yaml
```

The script prints a JSON summary mapping every YAML `ref` to the
materialized UUID, so a shell script can grep:

```bash
PROJECT_ID=$(npx tsx scripts/seed-scenario.ts scenarios/mid-flight-rental.yaml \
  | jq -r '.projects[] | select(.ref == "project-alpha") | .id')
```

## Starter scenarios

All live in `scenarios/`. Each top-of-file comment explains what the
scenario exercises and how to verify the state landed.

| File                        | Workflow under test           | Final state                                                                                   |
| --------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `mid-flight-rental.yaml`    | `rental_billing_run`          | One rental in `posting`, mutation_outbox backdated 15 min so worker retries on next heartbeat |
| `multi-crew-project.yaml`   | `field_event` (auto-escalate) | 2 foremen + 1 worker on one project; open `worker_issue` severity=stopped 20 min old          |
| `closeout-rentals-due.yaml` | `project_closeout` blockers   | Project lifecycle=`done` with three rentals in mixed unbilled states                          |
| `takeoff-bulk.yaml`         | takeoff index + render perf   | 500 `takeoff_measurements` rows hanging off one draft                                         |
| `estimate-push-failed.yaml` | `estimate_push`               | Estimate push in `failed` state with `error` column populated                                 |

## YAML grammar

```yaml
company: # required
  slug: <kebab-case>
  name: <display-name>

members: # optional; admin auto-created elsewhere
  - clerk_user_id: e2e-admin
    role: admin # admin | foreman | office | member | bookkeeper

customers: # optional
  - ref: <stable-name>
    name: <display>

workers: # optional
  - ref: <stable-name>
    name: <display>
    role: <crew|foreman>

inventory: # optional
  - ref: <stable-name>
    code: <SKU>
    default_rental_rate: <numeric>
    replacement_value: <numeric>

projects: # optional
  - ref: <stable-name>
    name: <display>
    customer_ref: <one-of-customers>
    status: <lead|active|completed>
    bid_total: <numeric>
    lifecycle_state: <draft|estimating|sent|accepted|declined|in_progress|done|archived>
    lifecycle_state_version: <int> # match the lifecycle reducer's count

rentals: # exercises rental_billing_run workflow
  - ref: <stable-name>
    project_ref: <one-of-projects>
    customer_ref: <one-of-customers>
    inventory_ref: <one-of-inventory>
    quantity: <numeric>
    billing_cycle_days: <int>
    period_start: 'YYYY-MM-DD'
    period_end: 'YYYY-MM-DD'
    subtotal: <numeric>
    billing_event_log: # optional; walks the reducer
      - type: APPROVE | POST_REQUESTED | POST_SUCCEEDED | POST_FAILED | RETRY_POST | VOID
        # event-specific fields per packages/workflows/src/rental-billing.ts
    outbox_next_attempt_offset_minutes: <int> # only meaningful when last event = POST_REQUESTED

estimates: # exercises estimate_push workflow
  - ref: <stable-name>
    project_ref: <one-of-projects>
    subtotal: <numeric>
    push_event_log: # optional
      - type: REVIEW | APPROVE | POST_REQUESTED | POST_SUCCEEDED | POST_FAILED | RETRY_POST | VOID

worker_issues: # exercises field_event workflow
  - ref: <stable-name>
    project_ref: <one-of-projects>
    worker_ref: <one-of-workers>
    reporter_clerk_user_id: <clerk-id>
    kind: <materials_out|crew_short|safety|other>
    severity: <question|slowing|stopped>
    message: <text>
    created_offset_minutes: <int> # backdate the row
    issue_event_log: # optional
      - type: RESOLVE | ESCALATE | DISMISS | REOPEN

clock_events: # raw rows, no workflow
  - worker_ref: <one-of-workers>
    project_ref: <one-of-projects>
    event_type: in | out
    occurred_at: '2026-01-15T08:00:00.000Z'

takeoff_measurements: # bulk-insert path for perf scenarios
  project_ref: <one-of-projects>
  count: 500
  service_item_code: EPS
  unit: sqft
```

## How the workflow event log is built

When a YAML section carries a `*_event_log:` list, the seeder walks
each event through the registered reducer in
`@sitelayer/workflows`, then:

1. Writes one `workflow_event_log` row per event with the correct
   `schema_version`, `state_version` (the version BEFORE the
   transition), and `snapshot_after`.
2. UPDATEs the entity row (`rental_billing_runs`, `estimate_pushes`,
   `worker_issues`) so the persisted columns match the final reducer
   snapshot.

This means `scripts/replay-workflow.ts` against a seeded entity must
pass — same invariant production cares about.

## Determinism

Every `ref` is hashed (sha256, scoped) into a stable UUIDv4. Same YAML
in, same row ids out. Re-running the same scenario is a no-op (every
INSERT carries `ON CONFLICT DO NOTHING`).

## Tier safety

The script refuses to run when `APP_TIER=prod` — same guard
`seed-e2e-fixtures.ts` uses. Scenarios are intentionally only safe in
local / dev / preview. Each scenario uses a unique `company.slug`
(`acme-midflight`, `acme-multicrew`, ...) so multiple scenarios can
share a single dev DB without colliding.

## Adding a new scenario

1. Drop a new file in `scenarios/<name>.yaml`.
2. Put a comment block at the top explaining what it exercises and
   how to verify the state landed.
3. Pick a unique `company.slug`.
4. If the scenario needs a workflow not yet plumbed into the seeder,
   add a per-section helper in `scripts/seed-scenario.ts` mirroring
   the existing `ensureRentals` / `ensureEstimates` shape and call
   `applyEventSequence` from `@sitelayer/workflows` to walk events.

## Related tooling

| Tool                                     | When to use                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/onboard-company.ts`             | Provision one customer (slug + admin + division seed). No fixture data.                                                                |
| `apps/api/scripts/seed-e2e-fixtures.ts`  | Fixed `e2e-fixtures` tenant with one stuck-state row per workflow. Used by the Playwright suite.                                       |
| `scripts/seed-scenario.ts` (this script) | Arbitrary tenants with arbitrary state for reproducers, perf smokes, multi-row fixtures.                                               |
| `scripts/replay-workflow.ts`             | Validates reducer ↔ persisted row alignment for a single entity. Run after seeding a workflow scenario to confirm the log + row agree. |

## Test-only helper: `applyEventSequence`

For Vitest tests that need to walk a workflow without going through
the seeder, import the helper directly:

```ts
import { applyEventSequence } from '@sitelayer/workflows'

const result = await applyEventSequence(client, {
  workflowName: 'rental_billing_run',
  entityType: 'rental_billing_run',
  entityId: someUuid,
  companyId: tenantId,
  initialSnapshot: { state: 'generated', state_version: 1 },
  events: [{ type: 'APPROVE', approved_at: '2026-...', approved_by: 'office-x' }, { type: 'POST_REQUESTED' }],
})
// result.finalSnapshot is the reducer output you'd UPDATE onto the row.
// result.steps lists every per-event snapshot, in order.
```

The helper writes one `workflow_event_log` row per event — same shape
as the API path — but leaves transaction management and entity-row
UPDATE to the caller. Unit coverage lives in
`packages/workflows/src/test-replay.test.ts`.
