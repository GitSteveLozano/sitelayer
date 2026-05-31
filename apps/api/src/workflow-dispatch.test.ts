import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { dispatchWorkflowEvent, toWorkflowSnapshot } from './workflow-dispatch.js'

type Snap = { state: 'start' | 'done'; state_version: number }
type Ev = { type: 'GO' | 'BAD' }
type Row = { id: string; state: string; state_version: number }

const definition = {
  name: 'test_wf',
  schemaVersion: 1,
  reduce: (s: Snap, e: Ev): Snap => {
    if (e.type === 'GO' && s.state === 'start') return { state: 'done', state_version: s.state_version + 1 }
    throw new Error(`illegal transition: ${e.type} from ${s.state}`)
  },
  nextEvents: (state: string) => (state === 'start' ? [{ type: 'GO', label: 'Go' }] : []),
}

/** Minimal fake PoolClient that records queries and never hits a DB. */
function fakeClient() {
  const calls: Array<{ text: string; values?: unknown[] | undefined }> = []
  const client = {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text: String(text), values })
      return { rows: [] }
    },
  }
  return client as unknown as PoolClient & { calls: typeof calls }
}

const baseOpts = (overrides: Record<string, unknown> = {}) => ({
  definition,
  companyId: 'co-1',
  entityType: 'test_entity',
  entityId: 'e-1',
  expectedStateVersion: 0,
  actorUserId: 'u-1',
  loadSnapshot: async () => ({ row: { id: 'e-1', state: 'start', state_version: 0 } as Row, snapshot: { state: 'start', state_version: 0 } as Snap }),
  buildEvent: (): Ev => ({ type: 'GO' }),
  persist: async (_c: PoolClient, next: Snap) => ({ id: 'e-1', state: next.state, state_version: next.state_version } as Row),
  ...overrides,
})

describe('dispatchWorkflowEvent', () => {
  it('ok: reduces, persists, and ALWAYS records the workflow event', async () => {
    const client = fakeClient()
    const result = await dispatchWorkflowEvent<Row, Snap, Ev>(client, baseOpts() as never)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.snapshot.state).toBe('done')
    expect(result.snapshot.state_version).toBe(1)
    // the event-log insert is the step routes forget — assert it ran
    const loggedInsert = client.calls.find((c) => /insert into workflow_event_log/i.test(c.text))
    expect(loggedInsert).toBeTruthy()
  })

  it('not_found: loadSnapshot returns null', async () => {
    const client = fakeClient()
    const result = await dispatchWorkflowEvent<Row, Snap, Ev>(client, baseOpts({ loadSnapshot: async () => null }) as never)
    expect(result.kind).toBe('not_found')
    // no event logged on a miss
    expect(client.calls.find((c) => /workflow_event_log/i.test(c.text))).toBeUndefined()
  })

  it('version_conflict: expected version mismatches the locked row', async () => {
    const client = fakeClient()
    const result = await dispatchWorkflowEvent<Row, Snap, Ev>(client, baseOpts({ expectedStateVersion: 7 }) as never)
    expect(result.kind).toBe('version_conflict')
    expect(client.calls.find((c) => /workflow_event_log/i.test(c.text))).toBeUndefined()
  })

  it('illegal_transition: reducer throws → no write, no event', async () => {
    const client = fakeClient()
    const result = await dispatchWorkflowEvent<Row, Snap, Ev>(client, baseOpts({ buildEvent: () => ({ type: 'BAD' }) }) as never)
    expect(result.kind).toBe('illegal_transition')
    if (result.kind !== 'illegal_transition') return
    expect(result.message).toMatch(/illegal transition/)
    expect(client.calls.find((c) => /workflow_event_log/i.test(c.text))).toBeUndefined()
  })

  it('runs sideEffects on ok', async () => {
    const client = fakeClient()
    let ran = false
    const result = await dispatchWorkflowEvent<Row, Snap, Ev>(
      client,
      baseOpts({ sideEffects: async () => { ran = true } }) as never,
    )
    expect(result.kind).toBe('ok')
    expect(ran).toBe(true)
  })
})

describe('toWorkflowSnapshot', () => {
  it('computes next_events from the reducer, never hand-listed', () => {
    const env = toWorkflowSnapshot(definition, { state: 'start', state_version: 0 } as Snap)
    expect(env.state).toBe('start')
    expect(env.state_version).toBe(0)
    expect(env.next_events).toEqual([{ type: 'GO', label: 'Go' }])
    expect(toWorkflowSnapshot(definition, { state: 'done', state_version: 1 } as Snap).next_events).toEqual([])
  })
})
