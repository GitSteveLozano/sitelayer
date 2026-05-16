import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetWorkflowRegistryForTests,
  getReducerByName,
  getWorkflow,
  listWorkflows,
  registerWorkflow,
  type WorkflowDefinition,
} from './registry.js'

type S = 'open' | 'closed'
type E = { type: 'CLOSE' }

function makeDef(
  name: string,
  schemaVersion: number,
  marker: string,
): WorkflowDefinition<S, E, 'CLOSE', { state: S; state_version: number; marker?: string }> {
  return {
    name,
    schemaVersion,
    initialState: 'open',
    terminalStates: ['closed'],
    allStates: ['open', 'closed'],
    allEventTypes: ['CLOSE'],
    reduce: (snapshot, event) => {
      if (event.type === 'CLOSE')
        return { ...snapshot, state: 'closed', state_version: snapshot.state_version + 1, marker }
      return snapshot
    },
    nextEvents: () => [],
    isHumanEvent: (t): t is 'CLOSE' => t === 'CLOSE',
    sideEffectTypes: [],
  }
}

describe('workflow registry — multi-version support', () => {
  afterEach(() => __resetWorkflowRegistryForTests())

  it('allows registering two versions of the same workflow', () => {
    registerWorkflow(makeDef('demo', 1, 'v1'))
    registerWorkflow(makeDef('demo', 2, 'v2'))
    expect(listWorkflows().filter((d) => d.name === 'demo')).toHaveLength(2)
  })

  it('returns the highest-version reducer when version is omitted', () => {
    registerWorkflow(makeDef('demo', 1, 'v1'))
    registerWorkflow(makeDef('demo', 3, 'v3'))
    registerWorkflow(makeDef('demo', 2, 'v2'))
    const def = getWorkflow('demo')!
    expect(def.schemaVersion).toBe(3)
  })

  it('returns the exact version when requested', () => {
    registerWorkflow(makeDef('demo', 1, 'v1'))
    registerWorkflow(makeDef('demo', 2, 'v2'))
    expect(getWorkflow('demo', 1)?.schemaVersion).toBe(1)
    expect(getWorkflow('demo', 2)?.schemaVersion).toBe(2)
    expect(getWorkflow('demo', 9)).toBeUndefined()
  })

  it('feeds replays through the matching reducer', () => {
    registerWorkflow(makeDef('demo', 1, 'v1'))
    registerWorkflow(makeDef('demo', 2, 'v2'))
    const v1 = getReducerByName('demo', 1)
    const v2 = getReducerByName('demo', 2)
    const snap1 = v1({ state: 'open', state_version: 0 }, { type: 'CLOSE' }) as { marker?: string }
    const snap2 = v2({ state: 'open', state_version: 0 }, { type: 'CLOSE' }) as { marker?: string }
    expect(snap1.marker).toBe('v1')
    expect(snap2.marker).toBe('v2')
  })

  it('throws a clear error when the reducer is missing', () => {
    expect(() => getReducerByName('demo', 1)).toThrow(/no reducer registered for demo@1/)
  })

  it('treats same-version re-registration as idempotent (hot-reload friendly)', () => {
    registerWorkflow(makeDef('demo', 1, 'v1'))
    registerWorkflow(makeDef('demo', 1, 'v1'))
    expect(listWorkflows().filter((d) => d.name === 'demo')).toHaveLength(1)
  })
})
