import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Tests for daily-log.ts — a thin wrapper binding the headless workflow
 * factory to the daily-log /snapshot + /events API. Verifies the wiring:
 * LOAD fetches via the mocked `fetchDailyLogSnapshot`, DISPATCH(SUBMIT)
 * submits via the mocked `dispatchDailyLogEvent`, and a 409 reloads.
 */

const fetchDailyLogSnapshotMock = vi.fn()
const dispatchDailyLogEventMock = vi.fn()

vi.mock('@/lib/api', () => ({
  fetchDailyLogSnapshot: (...args: unknown[]) => fetchDailyLogSnapshotMock(...args),
  dispatchDailyLogEvent: (...args: unknown[]) => dispatchDailyLogEventMock(...args),
}))

import { dailyLogMachine } from './daily-log.js'
import type { DailyLogSnapshot } from '@/lib/api/daily-logs'

const draftSnapshot: DailyLogSnapshot = {
  state: 'draft',
  state_version: 1,
  next_events: [{ type: 'SUBMIT', label: 'Submit daily log' }],
  context: {
    id: 'log-1',
    project_id: 'p-1',
    occurred_on: '2026-05-09',
    foreman_user_id: 'fm-1',
    status: 'draft',
    scope_progress: [],
    weather: null,
    notes: null,
    schedule_deviations: [],
    crew_summary: [],
    photo_keys: [],
    submitted_at: null,
    version: 0,
    state_version: 1,
    origin: null,
    created_at: '2026-05-09T08:00:00.000Z',
    updated_at: '2026-05-09T08:00:00.000Z',
  },
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  fetchDailyLogSnapshotMock.mockReset()
  dispatchDailyLogEventMock.mockReset()
})

describe('dailyLogMachine', () => {
  it('LOAD calls fetchDailyLogSnapshot and stashes the snapshot', async () => {
    fetchDailyLogSnapshotMock.mockResolvedValueOnce(draftSnapshot)
    const actor = createActor(dailyLogMachine, { input: { entityId: 'log-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot).toEqual(draftSnapshot)
    expect(fetchDailyLogSnapshotMock).toHaveBeenCalledWith('log-1')
  })

  it('DISPATCH(SUBMIT) calls dispatchDailyLogEvent with id, event, version → submitted', async () => {
    fetchDailyLogSnapshotMock.mockResolvedValueOnce(draftSnapshot)
    const submitted: DailyLogSnapshot = {
      ...draftSnapshot,
      state: 'submitted',
      state_version: 2,
      next_events: [],
      context: {
        ...draftSnapshot.context,
        status: 'submitted',
        state_version: 2,
        submitted_at: '2026-05-09T17:00:00Z',
      },
    }
    dispatchDailyLogEventMock.mockResolvedValueOnce(submitted)
    const actor = createActor(dailyLogMachine, { input: { entityId: 'log-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: 'SUBMIT' })
    await settle()
    expect(dispatchDailyLogEventMock).toHaveBeenCalledWith('log-1', 'SUBMIT', 1)
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot).toEqual(submitted)
  })

  it('409 from dispatchDailyLogEvent reloads the snapshot and sets outOfSync', async () => {
    fetchDailyLogSnapshotMock.mockResolvedValueOnce(draftSnapshot)
    const fresh: DailyLogSnapshot = { ...draftSnapshot, state_version: 5 }
    fetchDailyLogSnapshotMock.mockResolvedValueOnce(fresh)
    dispatchDailyLogEventMock.mockRejectedValueOnce(new Error('HTTP 409: state_version mismatch'))
    const actor = createActor(dailyLogMachine, { input: { entityId: 'log-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: 'SUBMIT' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.context.outOfSync).toBe(true)
    expect(snap.context.snapshot).toEqual(fresh)
  })
})
