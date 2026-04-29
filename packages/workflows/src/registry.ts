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

const REGISTRY = new Map<
  string,
  WorkflowDefinition<string, { type: string }, string, { state: string; state_version: number }>
>()

export function registerWorkflow<
  State extends string,
  Event extends { type: string },
  HumanEventType extends string,
  Snapshot extends { state: State; state_version: number },
>(
  definition: WorkflowDefinition<State, Event, HumanEventType, Snapshot>,
): WorkflowDefinition<State, Event, HumanEventType, Snapshot> {
  if (REGISTRY.has(definition.name)) {
    const existing = REGISTRY.get(definition.name)!
    if (existing.schemaVersion !== definition.schemaVersion) {
      throw new Error(
        `workflow "${definition.name}" already registered at schema_version=${existing.schemaVersion}; refusing to overwrite with ${definition.schemaVersion}`,
      )
    }
    return definition
  }
  REGISTRY.set(
    definition.name,
    definition as unknown as WorkflowDefinition<
      string,
      { type: string },
      string,
      { state: string; state_version: number }
    >,
  )
  return definition
}

export function getWorkflow(
  name: string,
): WorkflowDefinition<string, { type: string }, string, { state: string; state_version: number }> | undefined {
  return REGISTRY.get(name)
}

export function listWorkflows(): ReadonlyArray<
  WorkflowDefinition<string, { type: string }, string, { state: string; state_version: number }>
> {
  return Array.from(REGISTRY.values())
}

/**
 * Test-only: clear the registry. Use in test setups that re-register
 * workflows with mocked schemas.
 */
export function __resetWorkflowRegistryForTests(): void {
  REGISTRY.clear()
}
