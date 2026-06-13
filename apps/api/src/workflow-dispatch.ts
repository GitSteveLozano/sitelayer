/**
 * Generic deterministic-workflow dispatch primitive.
 *
 * Codifies the `received → validated → version_checked → reduced →
 * persisted → logged → effects_enqueued` pipeline that docs/
 * DETERMINISTIC_WORKFLOWS.md describes and that every workflow event
 * route (rental-billing, time-review, labor-payroll, estimate-push,
 * project-lifecycle, crew-schedule, …) currently re-hand-rolls. The
 * canonical exemplar this codifies is
 * `apps/api/src/routes/rental-billing-state.ts`.
 *
 * The win is that the load-bearing step routes forget —
 * `recordWorkflowEvent` (the append-only event-log row that the replay
 * harness regression-tests against) — is always run, and the reducer is
 * always the registered pure transition. The reducer stays pure: the
 * caller supplies the clock/actor inside `buildEvent`, and all IO
 * (lock, persist, outbox) is in the caller-provided callbacks, executed
 * inside an already-open `withMutationTx` transaction.
 *
 * Routes shrink to: parse body → call this → map the discriminated
 * result to 200/404/409. The matching thin client renderer is
 * `apps/web/src/machines/headless-workflow.ts`.
 */
import type { PoolClient } from 'pg'
import { recordWorkflowEvent } from './mutation-tx.js'

/** Minimal snapshot contract every workflow row satisfies. */
export interface WorkflowSnapshotBase {
  state: string
  state_version: number
}

/**
 * The slice of a registered `WorkflowDefinition` the primitive needs.
 * Structurally typed so callers can pass the registry definition
 * directly without this module importing `@sitelayer/workflows`
 * (keeps the build graph flat).
 */
export interface DispatchDefinition<Snap extends WorkflowSnapshotBase, Event extends { type: string }> {
  /** Stable workflow_event_log.workflow_name. */
  name: string
  /** Reducer signature version persisted alongside the row. */
  schemaVersion: number
  /** The pure transition. Must not read clock/db/random. */
  reduce: (snapshot: Snap, event: Event) => Snap
  /**
   * The open-world boundary: the full set of event types this reducer models.
   * When present, the primitive rejects an event whose `type` is NOT a member
   * BEFORE calling `reduce`, returning `illegal_transition` with
   * `unknownEvent: true` (vs. a real-event-illegal-state rejection). Passing the
   * registry workflow object directly (which carries `allEventTypes`) opts in
   * for free. When omitted, the reducer's own exhaustiveness throw is the
   * backstop (it lands in `illegal_transition` all the same).
   */
  allEventTypes?: readonly string[]
}

/** Pure membership check for inbound boundaries (replay, agent callbacks, …)
 *  that hold an event-type string from an open world. */
export function isKnownWorkflowEvent(allEventTypes: readonly string[], eventType: string): boolean {
  return allEventTypes.includes(eventType)
}

export type DispatchResult<Row, Snap> =
  | { kind: 'ok'; row: Row; snapshot: Snap }
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; row: Row; snapshot: Snap }
  | {
      kind: 'illegal_transition'
      row: Row
      snapshot: Snap
      message: string
      /** True when the event TYPE isn't modeled by the workflow at all (open-world
       *  boundary hit), vs. a modeled event illegal from the current state. Lets a
       *  caller answer 422 (unprocessable) + emit telemetry, instead of 409. */
      unknownEvent?: boolean
    }

export interface DispatchOptions<Row, Snap extends WorkflowSnapshotBase, Event extends { type: string }> {
  definition: DispatchDefinition<Snap, Event>
  companyId: string
  entityType: string
  entityId: string
  /** state_version the client believes it is acting on (from the POST body). */
  expectedStateVersion: number
  actorUserId?: string | null
  /** Lock + shape the current row → snapshot (the only workflow-specific read). Return null for 404. */
  loadSnapshot: (client: PoolClient) => Promise<{ row: Row; snapshot: Snap } | null>
  /** Build the reducer event server-side (clock/actor live here; reducer stays pure). */
  buildEvent: (snapshot: Snap) => Event
  /** The single workflow-specific UPDATE that flips status/state_version/version+1 and transition columns. */
  persist: (client: PoolClient, next: Snap, prevRow: Row) => Promise<Row>
  /** Optional outbox enqueue(s) / ledger rows for the transition (with the workflow's idempotency key). */
  sideEffects?: (client: PoolClient, next: Snap, row: Row, event: Event) => Promise<void>
  /**
   * Telemetry hook fired exactly once when the open-world boundary is hit — an
   * event type not in the definition's `allEventTypes`. The "one telemetry row"
   * for an unmodeled event so the operator can see an integration sending
   * something we don't understand. No-op when omitted.
   */
  onUnknownEvent?: (eventType: string) => void
}

/**
 * Apply one human event to a workflow entity inside `client`'s transaction.
 * Call from within `withMutationTx(async (client) => dispatchWorkflowEvent(client, {...}))`.
 */
export async function dispatchWorkflowEvent<Row, Snap extends WorkflowSnapshotBase, Event extends { type: string }>(
  client: PoolClient,
  opts: DispatchOptions<Row, Snap, Event>,
): Promise<DispatchResult<Row, Snap>> {
  // 1. load (workflow-specific FOR UPDATE lock + row→snapshot)
  const loaded = await opts.loadSnapshot(client)
  if (!loaded) return { kind: 'not_found' }
  const { row, snapshot } = loaded

  // 2. post-lock optimistic version check
  if (snapshot.state_version !== opts.expectedStateVersion) {
    return { kind: 'version_conflict', row, snapshot }
  }

  // 3. pure reduce (clock/actor supplied by buildEvent, never inside reduce)
  const event = opts.buildEvent(snapshot)

  // 3a. Open-world boundary: reject an event type the workflow doesn't model at
  //     all, distinctly from a modeled event that's illegal from this state. The
  //     reducer's own exhaustiveness throw would also catch this (and lands in
  //     the same result), but checking here yields a clearer message + the
  //     `unknownEvent` flag + the telemetry hook — the cheapest open-world signal.
  if (opts.definition.allEventTypes && !isKnownWorkflowEvent(opts.definition.allEventTypes, event.type)) {
    opts.onUnknownEvent?.(event.type)
    return {
      kind: 'illegal_transition',
      row,
      snapshot,
      unknownEvent: true,
      message:
        `unknown event type "${event.type}" — not a modeled event of workflow ` +
        `"${opts.definition.name}" (known: ${opts.definition.allEventTypes.join(', ')})`,
    }
  }

  let next: Snap
  try {
    next = opts.definition.reduce(snapshot, event)
  } catch (err) {
    return { kind: 'illegal_transition', row, snapshot, message: err instanceof Error ? err.message : String(err) }
  }

  // 4. persist the single workflow-specific UPDATE
  const updated = await opts.persist(client, next, row)

  // 5. ALWAYS append the event-log row — the step hand-rolled routes forget.
  //    Keyed UNIQUE (entity_id, state_version) on the BEFORE version.
  await recordWorkflowEvent(client, {
    companyId: opts.companyId,
    workflowName: opts.definition.name,
    schemaVersion: opts.definition.schemaVersion,
    entityType: opts.entityType,
    entityId: opts.entityId,
    stateVersion: opts.expectedStateVersion,
    eventType: event.type,
    eventPayload: event as unknown as object,
    snapshotAfter: next as unknown as object,
    actorUserId: opts.actorUserId ?? null,
  })

  // 6. optional side effects (ledger row + outbox enqueue with idempotency key)
  if (opts.sideEffects) await opts.sideEffects(client, next, updated, event)

  return { kind: 'ok', row: updated, snapshot: next }
}

export interface WorkflowSnapshotEnvelope<Snap> {
  state: string
  state_version: number
  context: Snap
  next_events: unknown[]
}

/**
 * Build the `GET snapshot` response so `next_events` is ALWAYS computed
 * from the registered reducer's `nextEvents(state)`, never hand-listed
 * in the route. The screen renders only `snapshot.next_events` — this is
 * the UI-bypass guard (the UI can't invent a transition the machine
 * doesn't allow).
 */
export function toWorkflowSnapshot<Snap extends WorkflowSnapshotBase>(
  definition: { nextEvents?: (state: string) => unknown[] },
  snapshot: Snap,
): WorkflowSnapshotEnvelope<Snap> {
  return {
    state: snapshot.state,
    state_version: snapshot.state_version,
    context: snapshot,
    next_events: definition.nextEvents ? definition.nextEvents(snapshot.state) : [],
  }
}
