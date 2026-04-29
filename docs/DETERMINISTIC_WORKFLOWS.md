# Deterministic Workflow Design

Last updated: 2026-04-29

## Direction

Sitelayer should model complex operational flows as deterministic state machines now, even while execution still runs through the current API + Postgres worker path.

The target path is compatible with:

- XState for frontend statecharts and local UI orchestration
- Temporal.io for durable backend workflows with timers, retries, cancellation, and human approval steps
- the current Postgres queue/outbox while workflow volume and complexity are still modest

The goal is to avoid embedding workflow meaning in scattered `if` statements. Business states, allowed events, idempotency keys, and side-effect boundaries should be explicit.

## Design Rules

1. State transitions are pure.

   A transition function receives `(currentState, event)` and returns `nextState`. It must not read the clock, generate ids, query the database, call external APIs, or perform IO.

2. Side effects happen outside the transition.

   Examples: sending email, pushing a QuickBooks invoice, writing files, syncing with another system. The workflow records intent first, then an activity/worker performs the effect with an idempotency key.

3. Every external effect has an idempotency boundary.

   Examples:
   - billing run uniqueness: `(company_id, contract_id, period_start, period_end)`
   - QBO invoice push key: billing run id
   - inventory movement key: movement id or import row id

4. Persist state and state version.

   Rows that participate in workflows should have:
   - `status` as the current business state
   - `state_version` for optimistic transition checks
   - explicit timestamps/actor ids for important transitions
   - error fields for failed external effects

5. Prefer event names over method names.

   Use names like `APPROVE`, `POST_REQUESTED`, `POST_SUCCEEDED`, `POST_FAILED`, `VOID`, not `updateStatus`.

6. Workflow input must be replayable.

   Temporal workflows replay code. Anything nondeterministic must be passed in as event data or activity result, not computed inside workflow transition code.

## Runtime Path

### Now: Postgres + Pure Reducers

The API validates commands, loads the current row, applies the pure transition, writes the new state/version, and records ledger/outbox rows in the same transaction.

This keeps the system simple while preserving deterministic semantics.

### Next: XState for UI

Frontend screens can use the same state/event names as backend workflow rows.

Example:

- `generated`
- `approved`
- `posting`
- `posted`
- `failed`
- `voided`

UI state should be separate from persisted business state, but the labels and transitions should align.

## Headless UI Process Model

The product workflow should live in a headless statechart, not inside React
components. A screen should be the visual representation of a workflow snapshot:
it renders the current state, shows the human what actions are allowed, collects
input, and dispatches workflow events.

For complex processes, start from the durable backend semantics first. In other
words, design the statechart as if Temporal might run it later, even when the
first implementation is still Postgres + API routes. The frontend XState machine
should derive from that same vocabulary and should not invent separate business
states.

Business workflow state and UI interaction state are separate:

- Business state: `generated`, `approved`, `posting`, `posted`, `failed`,
  `voided`
- UI state: `idle`, `loading`, `editing`, `submitting`, `showingError`

React components can own UI state. They should not own business process
transitions.

The API should return workflow snapshots that are rich enough for the UI to
render without reconstructing the process from scattered conditionals.

```ts
export type WorkflowSnapshot<State extends string, EventType extends string, Context> = {
  state: State
  stateVersion: number
  context: Context
  nextEvents: Array<{
    type: EventType
    label: string
    disabledReason?: string
  }>
  commands?: WorkflowCommand[]
}

export type WorkflowCommand =
  | {
      type: 'POST_QBO_INVOICE'
      idempotencyKey: string
      payload: unknown
    }
  | {
      type: 'SEND_NOTIFICATION'
      idempotencyKey: string
      payload: unknown
    }
```

The normal interaction loop should be:

1. Backend loads the persisted workflow row.
2. Backend returns a `WorkflowSnapshot`.
3. UI renders `snapshot.state`, `snapshot.context`, and `snapshot.nextEvents`.
4. Human chooses an available event.
5. UI sends `{ event, stateVersion, payload }` to the API.
6. Backend checks the version, applies the pure transition, persists the result,
   records any command/outbox intent, and returns the next snapshot.

This lets the UI become a human-friendly visualization of the same statechart
that a Temporal workflow would eventually coordinate.

## Shared Workflow Package Target

If more than one runtime needs a workflow definition, move the definition into a
shared package before duplicating it.

Proposed structure:

```text
packages/workflows/src/rental-billing.workflow.ts
packages/workflows/src/rental-billing.workflow.test.ts
apps/web/src/machines/rental-billing-ui.ts
apps/api/src/routes/rental-inventory.ts
```

`packages/workflows` should hold:

- state and event types
- workflow context types
- pure transition functions
- guards and validation helpers
- selectors such as `nextEvents(state, context)` and `can(event)`
- command/effect intent types
- transition tests and replay tests

`apps/api` should be authoritative for persisted business state. It validates
commands, applies the shared reducer, writes state/version changes, and records
effect intents.

`apps/web` should interpret or wrap the same state/event model with XState for
local user experience concerns: loading, optimistic affordances, form editing,
error display, and resubmission. It may preview transitions for ergonomics, but
the persisted backend result is the source of truth.

Temporal, when added, should coordinate durable waits and activities around the
same workflow vocabulary. It should not introduce a third set of state names.

## Rules For Future Agents

- Do not put business process transitions in React components.
- Do not call APIs, read the clock, generate ids, or perform IO inside pure
  transition functions.
- Do not let the frontend be the source of truth for workflow state.
- Do not add a second copy of a workflow definition without tests proving it
  matches the shared reducer.
- Prefer event dispatches such as `APPROVE` and `POST_REQUESTED` over direct
  status mutation.
- Keep local UI states distinct from business states.
- Return workflow snapshots from API routes when a screen needs to guide a human
  through a process.

### Later: Temporal for Durable Backend Workflows

Temporal should become attractive when we have multiple workflows that need:

- timers across days/weeks
- multi-step retries against QBO or other APIs
- human approval waits
- cancellation
- clear step-level observability
- durable recovery after process restarts

At that point, the pure reducer becomes the workflow's deterministic state transition core, and external API calls become Temporal activities.

## Rental Billing Statechart

Initial backend slice uses this state model for rental billing runs.

```text
generated
  APPROVE -> approved
  VOID    -> voided

approved
  POST_REQUESTED -> posting
  VOID           -> voided

posting
  POST_SUCCEEDED -> posted
  POST_FAILED    -> failed

failed
  RETRY_POST -> approved
  VOID       -> voided

posted
  terminal

voided
  terminal
```

Persisted row fields:

- `rental_billing_runs.status`
- `rental_billing_runs.state_version`
- `rental_billing_runs.approved_at`
- `rental_billing_runs.approved_by`
- `rental_billing_runs.posted_at`
- `rental_billing_runs.failed_at`
- `rental_billing_runs.error`
- `rental_billing_runs.workflow_engine`
- `rental_billing_runs.workflow_run_id`

Current `workflow_engine` value should be `postgres`. If/when Temporal owns a workflow, use `temporal` and store the Temporal workflow id in `workflow_run_id`.

## Temporal Shape

The eventual Temporal rental billing workflow should look like:

```text
wait until contract.next_billing_date
generate billing preview
persist billing run as generated
wait for office approval
post invoice to QBO
record success/failure
schedule next cycle
```

Important: Temporal should not be the source of billing truth. Database rows remain the source of truth. Temporal coordinates durable execution and retries.

## When To Introduce Temporal

Do not add Temporal only because a workflow exists.

Add it when at least one production workflow has all of these characteristics:

- more than three durable steps
- one or more external systems
- waits/retries over minutes, hours, or days
- meaningful operator-facing status
- painful recovery if the API/worker process dies mid-flow

The rental billing + QBO invoice flow is likely the first candidate once office approval and QBO posting are implemented.

## Regression-Locking Infrastructure (2026-04-29)

The pieces below let us freeze business behavior for stable customers without freezing the codebase. They ship before the second paying customer.

### Workflow Registry — `packages/workflows/src/registry.ts`

Every reducer self-registers via `registerWorkflow({ name, schemaVersion, initialState, terminalStates, allStates, allEventTypes, reduce, nextEvents, isHumanEvent, sideEffectTypes })`. Cross-cutting tooling (replay harness, event-log writers, golden tests, future Temporal worker) operates against this one surface, not per-reducer imports.

The registry refuses double-registration with a different `schemaVersion`. Bumping `schemaVersion` is the explicit signal that the reducer's transition table has changed.

Currently registered: `rental_billing_run` (v1), `estimate_push` (v1).

### Append-Only Event Log — `workflow_event_log` table

Migration `020_workflow_event_log.sql`. Every transition appends one row in the same tx as the state update:

```text
(workflow_name, schema_version, entity_id, state_version,
 event_type, event_payload, snapshot_after, actor_user_id,
 applied_at, request_id, sentry_trace)
```

`(entity_id, state_version)` is unique, so duplicate writes for the same transition are rejected at the DB layer rather than at the application layer. `state_version` is the version BEFORE the transition (the version the event was dispatched against).

The rental-billing event handler in `apps/api/src/routes/rental-inventory.ts` calls `recordWorkflowEvent(client, ...)` (`apps/api/src/mutation-tx.ts`) inside `withMutationTx`. Estimate-push will follow the same pattern when its API route lands.

### Replay Harness — `packages/workflows/src/replay.ts`

`applyEventLog(initial, log)` feeds the `event_payload` values back through the registered reducer and asserts:

1. all entries belong to the same `workflow_name`
2. `schema_version` on every row matches the registered reducer
3. `state_version` increments by exactly 1 per row, no gaps
4. reducer output equals the persisted `snapshot_after` (canonicalized JSON compare)

The harness is what turns the event log into a regression net. Test usage: synthesize a log, replay, assert the final snapshot. Production usage: pull a customer's row history out of `workflow_event_log`, replay, compare to live state — bit-for-bit divergence flags a bug.

### Property-Based Tests — `*.property.test.ts` and integrated into per-workflow `*.test.ts`

`fast-check` generators for every state and every event. Invariants asserted:

- `state_version` strictly increments by 1
- terminal states reject every event
- reducer output state always within `allStates`
- reducer is deterministic (same input → same output)
- `nextEvents(state)` returns only events the reducer accepts from that state
- approval/review metadata survives later transitions

Catches drift the hand-written tests miss. ~50 lines per workflow.

### Per-State `next_events` Golden Snapshots

Inline `toMatchInlineSnapshot` for the full `nextEvents(state)` map. Drift in UI affordances (which buttons appear) becomes a visible diff in PR review — the PR author has to acknowledge "yes, I meant to remove the Approve button from `generated`".

### Worker-Emitted Events Are Logged Too

`POST_SUCCEEDED` and `POST_FAILED` are dispatched by the worker, not a human, so they never hit `recordWorkflowEvent` in `mutation-tx.ts`. The queue package's `appendWorkflowEvent` handles the worker side: every `applyWorkerEmittedEvent` (rental-billing) and `applyEstimatePushWorkerEvent` (estimate-push) appends one row to `workflow_event_log` in the same tx as the state update. `on conflict (entity_id, state_version) do nothing` makes worker retries safe — duplicate writes for the same transition are silently absorbed by the unique constraint.

### CLI Replay Tool — `scripts/replay-workflow.ts`

Ops-facing companion to the in-process replay harness. Reads `workflow_event_log` for one entity, runs `applyEventLog`, and compares the reducer output to the live row in `rental_billing_runs` or `estimate_pushes`:

```sh
DATABASE_URL=postgres://... npx tsx scripts/replay-workflow.ts \
  rental_billing_run 11111111-1111-1111-1111-111111111111
```

Exit code `2` on divergence — wire this into a periodic cron once we want continuous replay verification.

### Schema-Versioned Reducers (planned)

When changing `transitionRentalBillingWorkflow` for live customers:

1. Bump `RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION` from 1 to 2.
2. Keep the v1 reducer reachable for replay against existing event-log rows.
3. Run v2 in shadow against the v1 event log; diff outputs reveal regressions.
4. New transitions persist with `schema_version = 2`. Replay tooling reads `schema_version` per row and routes to the matching reducer.

The `schema_version` column already exists on `workflow_event_log`; multi-version reducer dispatch is a follow-up for when we actually need to change v1.

## Workflow Inventory

| Workflow | Status | Schema | States | Side effects |
|---|---|---|---|---|
| `rental_billing_run` | Live in API + worker, event log enabled in both human and worker paths | v1 | generated, approved, posting, posted, failed, voided | `post_qbo_invoice` |
| `estimate_push` | Live in API + worker (worker uses stub QBO push until `qbo-estimate-push.ts` ships and `QBO_LIVE_ESTIMATE_PUSH=1` is set) | v1 | drafted, reviewed, approved, posting, posted, failed, voided | `post_qbo_estimate` |

Implicit state machines that are next on the workflow-ization list (today they live as `set status = '...'` in scattered handlers):

- `crew_schedules` — `routes/schedules.ts:97`
- `projects` closeout — `routes/projects.ts:270`
- `rentals` — `routes/rentals.ts:32-40` (active / returned / invoiced_pending / closed)
- `integration_connections` / QBO sync runs — implicit retry state
- `blueprint_documents` revisions
