import type { WorkflowNextEvent } from './index.js'

/**
 * Generic descriptor for a deterministic workflow.
 *
 * Every workflow definition (rental-billing, estimate-push, ...) is
 * registered here so that cross-cutting tooling — replay harness, event
 * log writers, golden-snapshot tests, future Temporal worker — operates
 * against one stable surface instead of importing each reducer by name.
 *
 * The reducer remains pure (no IO, no clock reads, no random ids). The
 * registry only stores the function references and metadata that
 * surrounds it.
 */
export interface WorkflowDefinition<
  State extends string,
  Event extends { type: string },
  HumanEventType extends string,
  Snapshot extends { state: State; state_version: number },
> {
  /** Stable identifier persisted in workflow_event_log.workflow_name. */
  name: string
  /** Reducer signature version. Bump when the transition table changes. */
  schemaVersion: number
  /** Initial state for newly created entities of this workflow. */
  initialState: State
  /** Terminal states — no further events accepted. */
  terminalStates: readonly State[]
  /** All states the reducer can produce. Drives exhaustive testing. */
  allStates: readonly State[]
  /** All event type names the reducer accepts. */
  allEventTypes: readonly string[]
  /** Pure transition function. */
  reduce: (snapshot: Snapshot, event: Event) => Snapshot
  /** Returns events a human can dispatch from a given state. */
  nextEvents: (state: State) => Array<WorkflowNextEvent<HumanEventType>>
  /** Discriminator for human vs worker-only events. */
  isHumanEvent: (eventType: string) => eventType is HumanEventType
  /** Side-effect command types this workflow may emit. Used by the
   * outbox layer for routing and by the future Temporal worker for
   * activity registration. */
  sideEffectTypes: readonly string[]
}

type AnyDefinition = WorkflowDefinition<string, { type: string }, string, { state: string; state_version: number }>

/**
 * Registry is keyed by `${name}@${schemaVersion}` so multiple reducer
 * versions of the same workflow can coexist. Replay tooling uses
 * `getWorkflow(name, persistedSchemaVersion)` to feed each persisted
 * event through the reducer that wrote it — bumping a workflow's
 * schemaVersion no longer breaks the event_log of older entities.
 *
 * `getWorkflow(name)` (no version) returns the highest-version
 * registered reducer, which is the path the API uses for new events.
 */
const REGISTRY = new Map<string, AnyDefinition>()

function registryKey(name: string, schemaVersion: number): string {
  return `${name}@${schemaVersion}`
}

export function registerWorkflow<
  State extends string,
  Event extends { type: string },
  HumanEventType extends string,
  Snapshot extends { state: State; state_version: number },
>(
  definition: WorkflowDefinition<State, Event, HumanEventType, Snapshot>,
): WorkflowDefinition<State, Event, HumanEventType, Snapshot> {
  const key = registryKey(definition.name, definition.schemaVersion)
  if (REGISTRY.has(key)) {
    // Same name + same version — idempotent re-import (e.g. hot reload).
    return definition
  }
  // Existential erasure: the registry must hold heterogeneous workflow
  // definitions, and TS can't prove the variance is sound across
  // different Snapshot/Event types. Callers re-narrow via getWorkflow().
  REGISTRY.set(key, definition as unknown as AnyDefinition)
  return definition
}

/**
 * Look up a workflow. With `schemaVersion` omitted, returns the
 * highest-version registered reducer (canonical "current" path). With
 * a version supplied, returns the exact match or undefined — replay
 * tooling and per-entity dispatch use this form.
 */
export function getWorkflow(name: string, schemaVersion?: number): AnyDefinition | undefined {
  if (schemaVersion !== undefined) {
    return REGISTRY.get(registryKey(name, schemaVersion))
  }
  let latest: AnyDefinition | undefined
  for (const def of REGISTRY.values()) {
    if (def.name !== name) continue
    if (!latest || def.schemaVersion > latest.schemaVersion) latest = def
  }
  return latest
}

/**
 * Reducer-only lookup. Equivalent to `getWorkflow(name, version)?.reduce`
 * with a typed throw on miss. Useful for replay code that wants a clear
 * error path when an event log references a reducer that's been deleted.
 */
export function getReducerByName(name: string, schemaVersion: number): AnyDefinition['reduce'] {
  const def = getWorkflow(name, schemaVersion)
  if (!def) {
    throw new Error(`no reducer registered for ${name}@${schemaVersion}`)
  }
  return def.reduce
}

export function listWorkflows(): ReadonlyArray<AnyDefinition> {
  return Array.from(REGISTRY.values())
}

/**
 * Test-only: clear the registry. Use in test setups that re-register
 * workflows with mocked schemas.
 */
export function __resetWorkflowRegistryForTests(): void {
  REGISTRY.clear()
}
