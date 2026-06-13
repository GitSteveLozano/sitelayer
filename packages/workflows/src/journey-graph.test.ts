// Journey-graph gap ratchet + recreateState tests (2026-06-13 PR2).
//
// The journey graph is the reducer's transition relation, materialized. These
// tests turn three of its derived sets into HARD invariants over every
// registered workflow, and pin the one SOFT set to a reviewed allowlist so a
// NEW gap forces a look. This is the "catch undefined / underspecified behavior"
// guard from the correctness-architecture review — it runs on every reducer for
// free, with no per-workflow test authoring.
import { describe, expect, it } from 'vitest'
import './index.js' // side-effect: every workflow self-registers
import { buildAllJourneyGraphs, buildJourneyGraph, recreateState } from './journey-graph.js'
import { getWorkflow } from './registry.js'

const graphs = buildAllJourneyGraphs()

function unofferedKeys(g: { acceptedButUnoffered: Array<{ from: string; eventType: string }> }): string[] {
  return g.acceptedButUnoffered.map((x) => `${x.from}/${x.eventType}`).sort()
}

/**
 * Reviewed allowlist of human transitions the reducer ACCEPTS but the UI does
 * not offer from that state. Every entry is INTENTIONAL — `nextEvents` is a
 * curated UI subset while the reducer is the permissive truth. A new entry
 * appearing here (test failure) means: either wire a UI affordance, or add the
 * pair below with a one-line justification. Audited 2026-06-13.
 */
const INTENTIONAL_UNOFFERED: Record<string, string[]> = {
  // `failed` offers RETRY_POST (failed→approved) then POST_REQUESTED; the direct
  // repost-from-failed edge exists for the worker/API retry path, not a button.
  rental_billing_run: ['failed/POST_REQUESTED'],
  estimate_push: ['failed/POST_REQUESTED'],
  labor_payroll_run: ['failed/POST_REQUESTED'],
  // UI walks BEGIN_RETURN → returning → COMPLETE_RETURN; the direct
  // complete-from-out/overdue edge is an import/API shortcut.
  asset_deployment: ['out/COMPLETE_RETURN', 'overdue/COMPLETE_RETURN'].sort(),
  // CREATE_COMPANY is auto-driven at row creation and offered only as "Try
  // again" from `failed`; it is not a company_pending button (that state waits
  // on the create-company worker drain).
  tenant_provision: ['company_pending/CREATE_COMPANY'],
}

/**
 * Reviewed allowlist of states that are NOT reachable by transition from
 * `initialState` because rows are CREATED directly in them (seeded by a create
 * endpoint). Empty today — every registered workflow's states are transition-
 * reachable from its initial state. A new unreachable state must either be a
 * real reachability bug to fix, or a create-seeded state declared here.
 */
const CREATE_SEEDED_UNREACHABLE: Record<string, string[]> = {}

describe('journey-graph gap ratchet', () => {
  it('walks every registered workflow (anti-vacuous)', () => {
    expect(new Set(graphs.map((g) => g.workflow)).size).toBeGreaterThanOrEqual(20)
  })

  for (const g of graphs) {
    describe(g.workflow, () => {
      it('has no non-terminal dead-end state (a row that can never leave)', () => {
        expect(
          g.deadEndStates,
          `${g.workflow}: states ${JSON.stringify(g.deadEndStates)} are non-terminal but have no ` +
            `outgoing transition — a row entering them is stuck forever. Add an exit event, or ` +
            `declare them in the workflow's terminalStates.`,
        ).toEqual([])
      })

      it('offers no UI event the reducer would reject (no dead buttons)', () => {
        expect(
          g.offeredButRejected,
          `${g.workflow}: nextEvents() offers ${JSON.stringify(g.offeredButRejected)} but the ` +
            `reducer rejects those transitions — the UI would render a button that 409s/throws ` +
            `the moment it's pressed. Fix nextEvents() or the reducer's allow-list.`,
        ).toEqual([])
      })

      it('has every state reachable from the initial state (modulo create-seeded)', () => {
        const allowed = new Set(CREATE_SEEDED_UNREACHABLE[g.workflow] ?? [])
        const unexpected = g.unreachableStates.filter((s) => !allowed.has(s))
        expect(
          unexpected,
          `${g.workflow}: states ${JSON.stringify(unexpected)} are unreachable from "${g.initialState}". ` +
            `Either a transition is missing, or (if rows are created directly in that state) declare ` +
            `it in CREATE_SEEDED_UNREACHABLE.`,
        ).toEqual([])
      })

      it('accepts-but-does-not-offer only the reviewed intentional set', () => {
        const expected = (INTENTIONAL_UNOFFERED[g.workflow] ?? []).slice().sort()
        expect(
          unofferedKeys(g),
          `${g.workflow}: the set of human transitions the reducer accepts but the UI does not ` +
            `offer changed. Review each new pair (wire an affordance or add it to ` +
            `INTENTIONAL_UNOFFERED with a justification).`,
        ).toEqual(expected)
      })
    })
  }
})

describe('recreateState', () => {
  it('returns [] for a fresh entity already in the initial state', () => {
    expect(recreateState('rental_billing_run', 'generated')).toEqual([])
  })

  it('returns the shortest event-type path to a reachable state', () => {
    expect(recreateState('rental_billing_run', 'posted')).toEqual(['APPROVE', 'POST_REQUESTED', 'POST_SUCCEEDED'])
    // BFS picks the 4-hop declined→archived route over the 6-hop done→archived one.
    expect(recreateState('project_lifecycle', 'archived')).toEqual(['START_ESTIMATING', 'SEND', 'DECLINE', 'ARCHIVE'])
  })

  it('reaches a PAYLOAD-discriminated terminal only because of sampleEvents', () => {
    // failed_clerk_not_found is reachable ONLY via SEND_FAILED{kind:'clerk_not_found'};
    // a payload-less probe would surface only failed_provider. This asserts the
    // sampler is doing its job.
    expect(recreateState('notification', 'failed_clerk_not_found')).toEqual(['SEND_FAILED'])
    expect(recreateState('notification', 'failed_clerk_unreachable')).toEqual(['SEND_FAILED'])
  })

  it('every reachable state has an edge path that actually replays to it through the reducer', () => {
    // Closes the loop: the shortestEdgePaths sequence, fed event-by-event
    // through the reducer from the initial snapshot using each hop's exact
    // sampleIndex payload, must land in the target state. This is the property
    // the scenario harness relies on — and it exercises the payload-discriminated
    // notification terminals that a type-only path can't disambiguate.
    for (const g of graphs) {
      const def = getWorkflow(g.workflow)
      if (!def) throw new Error(`missing def ${g.workflow}`)
      for (const target of g.reachableStates) {
        const edgePath = g.shortestEdgePaths[target]
        expect(edgePath, `no edge path for reachable ${g.workflow}/${target}`).toBeTruthy()
        let snapshot: { state: string; state_version: number } = { state: def.initialState, state_version: 1 }
        for (const edge of edgePath as Array<{ eventType: string; sampleIndex: number }>) {
          const samples = def.sampleEvents?.(edge.eventType) ?? [{ type: edge.eventType }]
          const sample = samples[edge.sampleIndex] as { type: string }
          snapshot = def.reduce(snapshot, { ...sample, type: edge.eventType })
        }
        expect(snapshot.state, `${g.workflow}: shortestEdgePath landed in "${snapshot.state}", not "${target}"`).toBe(
          target,
        )
      }
    }
  })

  it('returns null for an unknown workflow or unreachable state', () => {
    expect(recreateState('does_not_exist', 'whatever')).toBeNull()
    expect(recreateState('rental_billing_run', 'not_a_state')).toBeNull()
  })
})

describe('buildJourneyGraph', () => {
  it('is deterministic — same definition yields identical edges', () => {
    const def = getWorkflow('shipment')
    if (!def) throw new Error('missing shipment')
    expect(buildJourneyGraph(def).edges).toEqual(buildJourneyGraph(def).edges)
  })
})
