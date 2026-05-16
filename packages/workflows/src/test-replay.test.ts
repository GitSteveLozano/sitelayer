import { afterEach, describe, expect, it } from 'vitest'
import { __resetWorkflowRegistryForTests, registerWorkflow, type WorkflowDefinition } from './registry.js'
import { applyEventSequence, type QueryExecutor } from './test-replay.js'

type DemoState = 'open' | 'reviewed' | 'closed'
type DemoEvent = { type: 'REVIEW'; reviewer: string } | { type: 'CLOSE'; closer: string }

interface DemoSnapshot {
  state: DemoState
  state_version: number
  reviewer?: string | null
  closer?: string | null
  [k: string]: unknown
}

function demoDefinition(): WorkflowDefinition<DemoState, DemoEvent, 'REVIEW' | 'CLOSE', DemoSnapshot> {
  return {
    name: 'demo_replay',
    schemaVersion: 1,
    initialState: 'open',
    terminalStates: ['closed'],
    allStates: ['open', 'reviewed', 'closed'],
    allEventTypes: ['REVIEW', 'CLOSE'],
    reduce: (snapshot, event) => {
      const nextVersion = snapshot.state_version + 1
      if (event.type === 'REVIEW') {
        if (snapshot.state !== 'open') throw new Error(`REVIEW illegal from ${snapshot.state}`)
        return { ...snapshot, state: 'reviewed', state_version: nextVersion, reviewer: event.reviewer }
      }
      if (snapshot.state !== 'reviewed' && snapshot.state !== 'open') {
        throw new Error(`CLOSE illegal from ${snapshot.state}`)
      }
      return { ...snapshot, state: 'closed', state_version: nextVersion, closer: event.closer }
    },
    nextEvents: () => [],
    isHumanEvent: (t): t is 'REVIEW' | 'CLOSE' => t === 'REVIEW' || t === 'CLOSE',
    sideEffectTypes: [],
  }
}

function makeRecordingExecutor(): { executor: QueryExecutor; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = []
  const executor: QueryExecutor = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] })
      return { rows: [] }
    },
  }
  return { executor, calls }
}

describe('applyEventSequence', () => {
  afterEach(() => __resetWorkflowRegistryForTests())

  it('walks the reducer and emits one workflow_event_log row per event', async () => {
    registerWorkflow(demoDefinition())
    const { executor, calls } = makeRecordingExecutor()

    const result = await applyEventSequence<DemoSnapshot, DemoEvent>(executor, {
      workflowName: 'demo_replay',
      entityId: '00000000-0000-4000-8000-000000000001',
      entityType: 'demo',
      companyId: '00000000-0000-4000-8000-000000000099',
      initialSnapshot: { state: 'open', state_version: 1 },
      events: [
        { type: 'REVIEW', reviewer: 'office-a' },
        { type: 'CLOSE', closer: 'office-b' },
      ],
      actorUserId: 'office-a',
    })

    expect(result.finalSnapshot.state).toBe('closed')
    expect(result.finalSnapshot.state_version).toBe(3)
    expect(result.finalSnapshot.reviewer).toBe('office-a')
    expect(result.finalSnapshot.closer).toBe('office-b')

    expect(calls).toHaveLength(2)
    // Both inserts target workflow_event_log
    for (const call of calls) {
      expect(call.text).toMatch(/insert into workflow_event_log/i)
      expect(call.text).toMatch(/on conflict \(entity_id, state_version\) do nothing/i)
    }
    // state_version BEFORE the transition is what gets persisted
    expect(calls[0]!.values[5]).toBe(1)
    expect(calls[1]!.values[5]).toBe(2)
    // event_type column receives the event type
    expect(calls[0]!.values[6]).toBe('REVIEW')
    expect(calls[1]!.values[6]).toBe('CLOSE')
    // event_payload is the raw event as JSON
    expect(JSON.parse(calls[0]!.values[7] as string)).toEqual({ type: 'REVIEW', reviewer: 'office-a' })
    // snapshot_after column reflects post-reducer state
    expect(JSON.parse(calls[0]!.values[8] as string)).toMatchObject({ state: 'reviewed', state_version: 2 })
    expect(JSON.parse(calls[1]!.values[8] as string)).toMatchObject({ state: 'closed', state_version: 3 })
  })

  it('records per-step audit trail in returned `steps`', async () => {
    registerWorkflow(demoDefinition())
    const { executor } = makeRecordingExecutor()

    const result = await applyEventSequence<DemoSnapshot, DemoEvent>(executor, {
      workflowName: 'demo_replay',
      entityId: '00000000-0000-4000-8000-000000000002',
      entityType: 'demo',
      companyId: '00000000-0000-4000-8000-000000000099',
      initialSnapshot: { state: 'open', state_version: 1 },
      events: [{ type: 'CLOSE', closer: 'office-direct' }],
    })

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]!.stateVersionBefore).toBe(1)
    expect(result.steps[0]!.eventType).toBe('CLOSE')
    expect(result.steps[0]!.snapshotAfter.state_version).toBe(2)
  })

  it('throws when the workflow is not registered', async () => {
    const { executor } = makeRecordingExecutor()
    await expect(() =>
      applyEventSequence(executor, {
        workflowName: 'nonexistent',
        entityId: '00000000-0000-4000-8000-000000000001',
        entityType: 'demo',
        companyId: '00000000-0000-4000-8000-000000000099',
        initialSnapshot: { state: 'open', state_version: 1 },
        events: [{ type: 'CLOSE', closer: 'x' }],
      }),
    ).rejects.toThrow(/no workflow registered/)
  })

  it('propagates illegal-transition errors from the reducer', async () => {
    registerWorkflow(demoDefinition())
    const { executor, calls } = makeRecordingExecutor()
    await expect(() =>
      applyEventSequence<DemoSnapshot, DemoEvent>(executor, {
        workflowName: 'demo_replay',
        entityId: '00000000-0000-4000-8000-000000000003',
        entityType: 'demo',
        companyId: '00000000-0000-4000-8000-000000000099',
        initialSnapshot: { state: 'closed', state_version: 5 },
        events: [{ type: 'REVIEW', reviewer: 'too-late' }],
      }),
    ).rejects.toThrow(/REVIEW illegal/)
    // No row was written because the reducer threw before the insert.
    expect(calls).toHaveLength(0)
  })

  it('passes appliedAt through verbatim when supplied', async () => {
    registerWorkflow(demoDefinition())
    const { executor, calls } = makeRecordingExecutor()
    await applyEventSequence<DemoSnapshot, DemoEvent>(executor, {
      workflowName: 'demo_replay',
      entityId: '00000000-0000-4000-8000-000000000004',
      entityType: 'demo',
      companyId: '00000000-0000-4000-8000-000000000099',
      initialSnapshot: { state: 'open', state_version: 1 },
      events: [{ type: 'REVIEW', reviewer: 'r' }],
      appliedAt: '2026-05-01T10:00:00.000Z',
    })
    // 11th positional value (index 10) is appliedAt
    expect(calls[0]!.values[10]).toBe('2026-05-01T10:00:00.000Z')
  })
})
