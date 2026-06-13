// Journey graph — the Layer-0 view DERIVED from the reducer (2026-06-13
// correctness-architecture PR2).
//
// A workflow reducer IS its statechart; the only thing missing was a readable
// view of the transition relation it implies. This module materializes that
// relation by executing the (pure, total, deterministic) reducer over
// `allStates × allEventTypes` — a finite, exhaustive walk, NOT a sample. The
// single resulting structure answers four of the questions the
// correctness-architecture review posed, through different lenses:
//
//   • the readable Layer-0 diagram        → `edges`
//   • the gap report ("undefined behavior   → `unreachableStates`,
//     we aren't seeing")                       `deadEndStates`, `acceptedButUnoffered`
//   • "get into a state for debugging"     → `recreateState()` = `shortestPaths[X]`
//   • the test-case generator              → enumerate `shortestPaths` → drive a row
//
// SOUNDNESS / LIMITS. The walk is exhaustive over (state, eventType) because the
// FSMs are finite and the reducer is pure + total + deterministic — so this is a
// real model-check of the transition relation, not a fuzz. Its one blind spot is
// PAYLOAD-discriminated branches (a reducer whose next state depends on an event
// FIELD, not just `event.type` — e.g. notification's SEND_FAILED.kind). Those are
// covered by `WorkflowDefinition.sampleEvents`, which hands the walk one payload
// per distinct target. What this still does NOT model — by construction, because
// the reducer pushed them out to stay pure — is time/timers, multi-writer
// concurrency, and cross-entity invariants. See the §8 "what it won't catch"
// note in the architecture doc; do not mistake a clean gap report for those.

import { getWorkflow, listWorkflows, type WorkflowDefinition } from './registry.js'

type AnyDefinition = WorkflowDefinition<string, { type: string }, string, { state: string; state_version: number }>

export interface JourneyEdge {
  from: string
  eventType: string
  to: string
  /** `isHumanEvent(eventType)` — distinguishes UI-dispatchable edges from
   *  worker-only / client-portal ones. */
  human: boolean
  /** True when `from === to` (an idempotent self-loop, e.g. estimate_share
   *  re-VIEW or asset_deployment CONFIRM_HANDOFF). */
  selfLoop: boolean
  /**
   * Index into `sampleEvents(eventType)` for the payload that drives THIS edge.
   * Always 0 for the common case; only > 0 for payload-discriminated events
   * (notification's SEND_FAILED, whose `kind` selects the target). Lets a caller
   * reconstruct the exact event payload that produces this transition.
   */
  sampleIndex: number
}

export interface JourneyGraph {
  workflow: string
  schemaVersion: number
  initialState: string
  states: readonly string[]
  terminalStates: readonly string[]
  /** Every accepted (from, eventType, to) transition the reducer implies. */
  edges: JourneyEdge[]
  /** States reachable from `initialState` by following edges (includes
   *  `initialState`). */
  reachableStates: string[]
  /**
   * States in `allStates` NOT reachable from `initialState`. A genuine dead
   * state is a bug; but a state into which rows are CREATED directly (seeded by
   * a create endpoint rather than reached by a transition) legitimately appears
   * here. The ratchet test carries a reviewed allowlist of the latter.
   */
  unreachableStates: string[]
  /**
   * Non-terminal states with NO outgoing edge — a row that lands here is stuck
   * forever. Always a defect: either the state needs an exit transition, or it
   * should be declared in `terminalStates`. This set must be empty.
   */
  deadEndStates: string[]
  /**
   * Human-dispatchable (from, eventType) transitions the reducer ACCEPTS but
   * `nextEvents(from)` does not offer — a backend-allowed move the UI can never
   * trigger. Usually INTENTIONAL: `nextEvents` is a curated UI subset, while the
   * reducer is the permissive truth (it must also accept worker / API / import /
   * replay events, and often routes a `failed`-state retry through a different
   * guided button). Reviewed via an allowlist in the ratchet test; a NEW entry
   * appearing is what warrants a look, not the set being non-empty.
   */
  acceptedButUnoffered: Array<{ from: string; eventType: string }>
  /**
   * The INVERSE and a HARD defect: (from, eventType) pairs `nextEvents(from)`
   * OFFERS but the reducer REJECTS — the UI renders a button that 409s / throws
   * the moment it's pressed. This set must always be empty; a non-empty entry is
   * a guaranteed broken affordance.
   */
  offeredButRejected: Array<{ from: string; eventType: string }>
  /**
   * Shortest event-TYPE path from `initialState` to each reachable state (BFS,
   * so minimal hop count). `shortestPaths[initialState] === []`. This is the
   * readable data behind `recreateState`. For payload-discriminated events the
   * type list under-specifies the exact target — use `shortestEdgePaths` when
   * you need the precise payload to replay to a discriminated terminal.
   */
  shortestPaths: Record<string, string[]>
  /**
   * The same shortest paths as full `JourneyEdge[]` sequences, carrying
   * `sampleIndex` per hop — enough to reconstruct the exact event payloads and
   * replay deterministically to ANY reachable state (including the three
   * notification failure terminals that share the SEND_FAILED type).
   */
  shortestEdgePaths: Record<string, JourneyEdge[]>
}

function samplesFor(def: AnyDefinition, eventType: string): ReadonlyArray<Record<string, unknown>> {
  const provided = def.sampleEvents?.(eventType)
  if (provided && provided.length > 0) return provided
  return [{ type: eventType }]
}

/**
 * Build the journey graph for one workflow definition by executing its reducer
 * over every (state, event-sample) pair. Pure: constructs only in-memory
 * probes; never touches IO. The reducer's own purity is what makes this safe to
 * run thousands of times.
 */
export function buildJourneyGraph(def: AnyDefinition): JourneyGraph {
  const edges: JourneyEdge[] = []
  const seenEdge = new Set<string>()

  for (const from of def.allStates) {
    for (const eventType of def.allEventTypes) {
      const samples = samplesFor(def, eventType)
      for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        // Force `type` to the event under test even if a sample omitted it.
        const event = { ...samples[sampleIndex], type: eventType } as { type: string }
        let next: { state: string; state_version: number }
        try {
          next = def.reduce({ state: from, state_version: 1 }, event)
        } catch {
          // Illegal transition from this state (assertTransition threw) — no edge.
          continue
        }
        const to = next.state
        const key = `${from}|${eventType}|${to}`
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({
          from,
          eventType,
          to,
          human: def.isHumanEvent(eventType),
          selfLoop: from === to,
          sampleIndex,
        })
      }
    }
  }

  // BFS from initialState → reachable set + shortest event-type paths.
  const adjacency = new Map<string, JourneyEdge[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.from)
    if (list) list.push(edge)
    else adjacency.set(edge.from, [edge])
  }
  const shortestEdgePaths: Record<string, JourneyEdge[]> = { [def.initialState]: [] }
  const queue: string[] = [def.initialState]
  while (queue.length > 0) {
    const state = queue.shift() as string
    const basePath = shortestEdgePaths[state] ?? []
    for (const edge of adjacency.get(state) ?? []) {
      if (edge.to in shortestEdgePaths) continue
      shortestEdgePaths[edge.to] = [...basePath, edge]
      queue.push(edge.to)
    }
  }
  const shortestPaths: Record<string, string[]> = Object.fromEntries(
    Object.entries(shortestEdgePaths).map(([state, path]) => [state, path.map((e) => e.eventType)]),
  )

  const reachableStates = Object.keys(shortestEdgePaths)
  const reachableSet = new Set(reachableStates)
  const unreachableStates = def.allStates.filter((s) => !reachableSet.has(s))

  const statesWithOutgoing = new Set(edges.filter((e) => !e.selfLoop).map((e) => e.from))
  const terminalSet = new Set(def.terminalStates)
  // A self-loop is not an exit, so a state whose only edges loop back to itself
  // is still a dead end (can never leave). Hence statesWithOutgoing excludes
  // self-loops above.
  const deadEndStates = def.allStates.filter((s) => !statesWithOutgoing.has(s) && !terminalSet.has(s))

  const acceptedButUnoffered: Array<{ from: string; eventType: string }> = []
  const offeredButRejected: Array<{ from: string; eventType: string }> = []
  for (const from of def.allStates) {
    const offered = new Set(def.nextEvents(from).map((n) => n.type))
    const acceptedHumanEvents = new Set(edges.filter((e) => e.from === from && e.human).map((e) => e.eventType))
    for (const eventType of acceptedHumanEvents) {
      if (!offered.has(eventType)) acceptedButUnoffered.push({ from, eventType })
    }
    for (const eventType of offered) {
      if (!acceptedHumanEvents.has(eventType)) offeredButRejected.push({ from, eventType })
    }
  }

  return {
    workflow: def.name,
    schemaVersion: def.schemaVersion,
    initialState: def.initialState,
    states: def.allStates,
    terminalStates: def.terminalStates,
    edges,
    reachableStates,
    unreachableStates,
    deadEndStates,
    acceptedButUnoffered,
    offeredButRejected,
    shortestPaths,
    shortestEdgePaths,
  }
}

/**
 * Build journey graphs for every registered workflow (latest schemaVersion per
 * name). Importing `./index.js` first guarantees every reducer has
 * self-registered.
 */
export function buildAllJourneyGraphs(): JourneyGraph[] {
  const byName = new Map<string, AnyDefinition>()
  for (const def of listWorkflows()) {
    const existing = byName.get(def.name)
    if (!existing || def.schemaVersion > existing.schemaVersion) byName.set(def.name, def)
  }
  return [...byName.values()].map(buildJourneyGraph)
}

/**
 * The debug primitive: the shortest sequence of EVENT TYPES that drives a fresh
 * entity (created in `initialState`) into `targetState`. Returns `[]` for the
 * initial state, an ordered list for any reachable state, and `null` if the
 * workflow is unknown or the state is unreachable by transition (e.g. a
 * create-seeded state).
 *
 * Feed the result to the scenario harness / `runJourney` to materialize a row
 * in exactly `targetState` for a bug repro or a generated test case, instead of
 * hand-authoring the event sequence.
 */
export function recreateState(workflowName: string, targetState: string, schemaVersion?: number): string[] | null {
  const def = getWorkflow(workflowName, schemaVersion)
  if (!def) return null
  const graph = buildJourneyGraph(def)
  return graph.shortestPaths[targetState] ?? null
}

/**
 * Render a journey graph as a Mermaid `stateDiagram-v2` block — the human-
 * readable Layer-0 view, derived (so it can never drift from the reducer).
 * Intentionally a plain string builder with no Mermaid dependency; callers can
 * embed it in docs or a debug page. Worker-only / client-portal edges are
 * dashed so the operator can see at a glance which transitions a UI can drive.
 */
export function journeyGraphToMermaid(graph: JourneyGraph): string {
  const lines: string[] = ['stateDiagram-v2', `  [*] --> ${graph.initialState}`]
  for (const edge of graph.edges) {
    // Worker-only / client-portal edges are tagged "(auto)" so the operator can
    // see at a glance which transitions a company-role UI can actually drive.
    const label = edge.human ? edge.eventType : `${edge.eventType} (auto)`
    lines.push(`  ${edge.from} --> ${edge.to}: ${label}`)
  }
  for (const terminal of graph.terminalStates) {
    lines.push(`  ${terminal} --> [*]`)
  }
  return lines.join('\n')
}
