import { describe, it, expect } from 'vitest'
import {
  QBO_SYNC_RUN_ALL_STATES,
  QBO_SYNC_RUN_TERMINAL_STATES,
  qboSyncRunWorkflow,
  isHumanQboSyncRunEvent,
  nextQboSyncRunEvents,
  parseQboSyncRunEventRequest,
  transitionQboSyncRunWorkflow,
  type QboSyncRunWorkflowSnapshot,
} from './qbo-sync-run.js'

describe('transitionQboSyncRunWorkflow — happy path', () => {
  it('walks pending → syncing → succeeded', () => {
    const pending: QboSyncRunWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const syncing = transitionQboSyncRunWorkflow(pending, {
      type: 'START_SYNC',
      started_at: '2026-05-01T08:00:00.000Z',
      triggered_by: 'admin-user',
    })
    expect(syncing).toMatchObject({ state: 'syncing', state_version: 2, triggered_by: 'admin-user' })
    const succeeded = transitionQboSyncRunWorkflow(syncing, {
      type: 'SYNC_SUCCEEDED',
      succeeded_at: '2026-05-01T08:01:00.000Z',
      snapshot: { syncedCustomers: 3 },
    })
    expect(succeeded).toMatchObject({
      state: 'succeeded',
      state_version: 3,
      snapshot: { syncedCustomers: 3 },
    })
  })

  it('walks syncing → failed → retrying → syncing → succeeded', () => {
    const syncing: QboSyncRunWorkflowSnapshot = { state: 'syncing', state_version: 2 }
    const failed = transitionQboSyncRunWorkflow(syncing, {
      type: 'SYNC_FAILED',
      failed_at: '2026-05-01T08:01:00.000Z',
      error: 'token expired',
    })
    expect(failed).toMatchObject({ state: 'failed', error: 'token expired' })
    const retrying = transitionQboSyncRunWorkflow(failed, {
      type: 'RETRY',
      retried_at: '2026-05-01T08:02:00.000Z',
      triggered_by: 'admin-user',
    })
    expect(retrying.state).toBe('retrying')
    const syncing2 = transitionQboSyncRunWorkflow(retrying, {
      type: 'START_SYNC',
      started_at: '2026-05-01T08:03:00.000Z',
    })
    // START_SYNC clears prior error.
    expect(syncing2).toMatchObject({ state: 'syncing', error: null })
  })

  it('rejects illegal transitions', () => {
    expect(() =>
      transitionQboSyncRunWorkflow({ state: 'succeeded', state_version: 3 }, { type: 'START_SYNC', started_at: 'x' }),
    ).toThrow(/illegal transition/)
    expect(() =>
      transitionQboSyncRunWorkflow(
        { state: 'pending', state_version: 1 },
        { type: 'SYNC_SUCCEEDED', succeeded_at: 'x' },
      ),
    ).toThrow(/illegal transition/)
    expect(() =>
      transitionQboSyncRunWorkflow({ state: 'syncing', state_version: 2 }, { type: 'RETRY', retried_at: 'x' }),
    ).toThrow(/illegal transition/)
  })
})

describe('qboSyncRun registry + helpers', () => {
  it('exposes reducer + metadata', () => {
    expect(qboSyncRunWorkflow.name).toBe('qbo_sync_run')
    expect(qboSyncRunWorkflow.initialState).toBe('pending')
    expect(qboSyncRunWorkflow.terminalStates).toEqual(QBO_SYNC_RUN_TERMINAL_STATES)
    expect(qboSyncRunWorkflow.allStates).toEqual(QBO_SYNC_RUN_ALL_STATES)
  })

  it('partitions human vs worker-only events', () => {
    expect(isHumanQboSyncRunEvent('START_SYNC')).toBe(true)
    expect(isHumanQboSyncRunEvent('RETRY')).toBe(true)
    expect(isHumanQboSyncRunEvent('SYNC_SUCCEEDED')).toBe(false)
    expect(isHumanQboSyncRunEvent('SYNC_FAILED')).toBe(false)
  })

  it('nextEvents exposes correct human options per state', () => {
    expect(nextQboSyncRunEvents('pending').map((e) => e.type)).toEqual(['START_SYNC'])
    expect(nextQboSyncRunEvents('retrying').map((e) => e.type)).toEqual(['START_SYNC'])
    expect(nextQboSyncRunEvents('failed').map((e) => e.type)).toEqual(['RETRY'])
    expect(nextQboSyncRunEvents('syncing')).toEqual([])
    expect(nextQboSyncRunEvents('succeeded')).toEqual([])
  })

  it('parseQboSyncRunEventRequest rejects worker-only events on the human endpoint', () => {
    expect(parseQboSyncRunEventRequest({ event: 'START_SYNC', state_version: 1 }).ok).toBe(true)
    expect(parseQboSyncRunEventRequest({ event: 'RETRY', state_version: 1 }).ok).toBe(true)
    expect(parseQboSyncRunEventRequest({ event: 'SYNC_SUCCEEDED', state_version: 1 }).ok).toBe(false)
    expect(parseQboSyncRunEventRequest({ event: 'SYNC_FAILED', state_version: 1 }).ok).toBe(false)
  })
})
