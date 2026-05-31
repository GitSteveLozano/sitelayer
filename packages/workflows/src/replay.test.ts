import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyEventLog, snapshotsEqual, type WorkflowEventLogEntry } from './replay.js'
import { __resetWorkflowRegistryForTests, registerWorkflow, type WorkflowDefinition } from './registry.js'

// ---------------------------------------------------------------------------
// Direct unit coverage for the production replay harness (replay.ts). The
// issue branches (unknown_workflow / schema_version_mismatch / gap /
// illegal_transition / snapshot_divergence) and the empty-log early return
// are otherwise only exercised indirectly via per-workflow golden tests, so
// this file pins each branch independently against a small fixture reducer.
// ---------------------------------------------------------------------------

const FIXTURE_NAME = 'replay_fixture'
const FIXTURE_SCHEMA = 1

type FixtureState = 'open' | 'closed'
type FixtureEvent = { type: 'CLOSE' } | { type: 'BOOM' }
interface FixtureSnapshot {
  state: FixtureState
  state_version: number
  closed_by?: string | null
}

function fixtureReduce(snapshot: FixtureSnapshot, event: FixtureEvent): FixtureSnapshot {
  if (event.type === 'CLOSE') {
    if (snapshot.state !== 'open') throw new Error(`CLOSE not allowed from ${snapshot.state}`)
    return { ...snapshot, state: 'closed', state_version: snapshot.state_version + 1, closed_by: 'tester' }
  }
  // BOOM always throws — used to exercise the illegal_transition branch.
  throw new Error('boom: reducer rejected event')
}

function makeFixtureDef(
  schemaVersion = FIXTURE_SCHEMA,
): WorkflowDefinition<FixtureState, FixtureEvent, 'CLOSE', FixtureSnapshot> {
  return {
    name: FIXTURE_NAME,
    schemaVersion,
    initialState: 'open',
    terminalStates: ['closed'],
    allStates: ['open', 'closed'],
    allEventTypes: ['CLOSE', 'BOOM'],
    reduce: fixtureReduce,
    nextEvents: () => [],
    isHumanEvent: (t): t is 'CLOSE' => t === 'CLOSE',
    sideEffectTypes: [],
  }
}

function entry(
  state_version: number,
  event_payload: WorkflowEventLogEntry['event_payload'],
  snapshot_after: FixtureSnapshot,
  overrides: Partial<WorkflowEventLogEntry> = {},
): WorkflowEventLogEntry {
  return {
    workflow_name: FIXTURE_NAME,
    schema_version: FIXTURE_SCHEMA,
    entity_id: '00000000-0000-0000-0000-000000000001',
    state_version,
    event_payload,
    snapshot_after: snapshot_after as unknown as WorkflowEventLogEntry['snapshot_after'],
    ...overrides,
  }
}

describe('replay — applyEventLog issue branches', () => {
  beforeEach(() => {
    __resetWorkflowRegistryForTests()
    registerWorkflow(makeFixtureDef())
  })
  afterEach(() => __resetWorkflowRegistryForTests())

  it('happy path: a valid single-event log replays cleanly', () => {
    const initial: FixtureSnapshot = { state: 'open', state_version: 1 }
    const after: FixtureSnapshot = { state: 'closed', state_version: 2, closed_by: 'tester' }
    const result = applyEventLog<FixtureSnapshot>(initial, [entry(1, { type: 'CLOSE' }, after)])
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot).toEqual(after)
  })

  it('empty log returns ok with the initial snapshot unchanged', () => {
    const initial: FixtureSnapshot = { state: 'open', state_version: 7 }
    const result = applyEventLog<FixtureSnapshot>(initial, [])
    expect(result).toEqual({ ok: true, finalSnapshot: initial, issues: [] })
  })

  it('unknown_workflow: an unregistered workflow_name yields one issue and null final', () => {
    const initial: FixtureSnapshot = { state: 'open', state_version: 1 }
    const log = [
      entry(1, { type: 'CLOSE' }, { state: 'closed', state_version: 2 }, { workflow_name: 'does_not_exist' }),
    ]
    const result = applyEventLog<FixtureSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.finalSnapshot).toBeNull()
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.reason).toBe('unknown_workflow')
  })

  it('schema_version_mismatch: row schema_version != reducer stops immediately', () => {
    const initial: FixtureSnapshot = { state: 'open', state_version: 1 }
    const log = [entry(1, { type: 'CLOSE' }, { state: 'closed', state_version: 2 }, { schema_version: 99 })]
    const result = applyEventLog<FixtureSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.finalSnapshot).toBeNull()
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.reason).toBe('schema_version_mismatch')
    expect(result.issues[0]?.detail).toContain('reducer schema=1')
  })

  it('gap: a skipped state_version is detected', () => {
    const initial: FixtureSnapshot = { state: 'open', state_version: 1 }
    // state_version 2 instead of the expected 1 → gap.
    const log = [entry(2, { type: 'CLOSE' }, { state: 'closed', state_version: 2 })]
    const result = applyEventLog<FixtureSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('gap')
    expect(result.issues[0]?.detail).toContain('expected state_version=1')
  })

  it('illegal_transition: a reducer throw propagates as an issue', () => {
    const initial: FixtureSnapshot = { state: 'open', state_version: 1 }
    const log = [entry(1, { type: 'BOOM' }, { state: 'open', state_version: 2 })]
    const result = applyEventLog<FixtureSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('illegal_transition')
    expect(result.issues[0]?.detail).toContain('boom: reducer rejected event')
  })

  it('snapshot_divergence: persisted snapshot_after != reducer output', () => {
    const initial: FixtureSnapshot = { state: 'open', state_version: 1 }
    // Reducer produces closed_by='tester'; tamper the persisted snapshot.
    const tampered: FixtureSnapshot = { state: 'closed', state_version: 2, closed_by: 'someone-else' }
    const log = [entry(1, { type: 'CLOSE' }, tampered)]
    const result = applyEventLog<FixtureSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('snapshot_divergence')
    expect(result.issues[0]?.detail).toContain('persisted')
  })

  it('stops at the first issue across a multi-event log', () => {
    const initial: FixtureSnapshot = { state: 'open', state_version: 1 }
    const after1: FixtureSnapshot = { state: 'closed', state_version: 2, closed_by: 'tester' }
    const log = [
      entry(1, { type: 'CLOSE' }, after1),
      // CLOSE from closed → reducer throws → illegal_transition.
      entry(2, { type: 'CLOSE' }, { state: 'closed', state_version: 3, closed_by: 'tester' }),
    ]
    const result = applyEventLog<FixtureSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.reason).toBe('illegal_transition')
  })
})

describe('replay — snapshotsEqual semantic equality rule', () => {
  it('treats missing-key vs explicit-null as equal (either direction)', () => {
    expect(snapshotsEqual({ state: 'x', state_version: 1 }, { state: 'x', state_version: 1, extra: null })).toBe(true)
    expect(snapshotsEqual({ state: 'x', state_version: 1, extra: null }, { state: 'x', state_version: 1 })).toBe(true)
  })

  it('treats null and undefined symmetrically', () => {
    expect(snapshotsEqual({ a: null }, { a: undefined })).toBe(true)
    expect(snapshotsEqual({ a: undefined }, { a: null })).toBe(true)
  })

  it('flags a non-null scalar mismatch', () => {
    expect(snapshotsEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(snapshotsEqual({ a: 'foo' }, { a: 'bar' })).toBe(false)
  })

  it('flags an array length mismatch and compares element-wise', () => {
    expect(snapshotsEqual({ a: [1, 2] }, { a: [1] })).toBe(false)
    expect(snapshotsEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true)
    expect(snapshotsEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false)
  })

  it('compares nested objects structurally', () => {
    expect(snapshotsEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true)
    expect(snapshotsEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false)
  })

  it('treats null vs {} as not equal', () => {
    expect(snapshotsEqual(null, {})).toBe(false)
    expect(snapshotsEqual({}, null)).toBe(false)
  })

  it('treats top-level null vs null as equal', () => {
    expect(snapshotsEqual(null, null)).toBe(true)
  })
})
