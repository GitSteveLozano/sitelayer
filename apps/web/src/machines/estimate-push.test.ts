import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Tests for estimate-push.ts — a thin wrapper that binds the headless
 * workflow factory to the estimate-push API. We verify the factory
 * wiring: LOAD hits `fetchEstimatePush`, DISPATCH hits
 * `dispatchEstimatePushEvent`, and 409 conflicts trigger a reload.
 */

const fetchEstimatePushMock = vi.fn()
const dispatchEstimatePushEventMock = vi.fn()

vi.mock('@/lib/api', () => ({
  fetchEstimatePush: (...args: unknown[]) => fetchEstimatePushMock(...args),
  dispatchEstimatePushEvent: (...args: unknown[]) => dispatchEstimatePushEventMock(...args),
}))

import { estimatePushMachine } from './estimate-push.js'
import type { EstimatePushSnapshot } from '@/lib/api/estimate-pushes'

const baseSnapshot: EstimatePushSnapshot = {
  state: 'drafted',
  state_version: 2,
  next_events: [{ type: 'REVIEW', label: 'Review' }],
  context: {
    id: 'push-1',
    project_id: 'p-1',
    customer_id: 'c-1',
    subtotal: '500',
    qbo_estimate_id: null,
    reviewed_at: null,
    reviewed_by: null,
    approved_at: null,
    approved_by: null,
    posted_at: null,
    failed_at: null,
    error: null,
    workflow_engine: 'local',
    workflow_run_id: null,
    lines: [],
  },
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  fetchEstimatePushMock.mockReset()
  dispatchEstimatePushEventMock.mockReset()
})

describe('estimatePushMachine', () => {
  it('LOAD calls fetchEstimatePush and stashes snapshot', async () => {
    fetchEstimatePushMock.mockResolvedValueOnce(baseSnapshot)
    const actor = createActor(estimatePushMachine, { input: { entityId: 'push-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot).toEqual(baseSnapshot)
    // estimate-push wrapper forwards only (id) to fetchEstimatePush.
    expect(fetchEstimatePushMock).toHaveBeenCalledWith('push-1')
  })

  it('DISPATCH(REVIEW) calls dispatchEstimatePushEvent with id, event, version', async () => {
    fetchEstimatePushMock.mockResolvedValueOnce(baseSnapshot)
    const next: EstimatePushSnapshot = { ...baseSnapshot, state: 'reviewed', state_version: 3 }
    dispatchEstimatePushEventMock.mockResolvedValueOnce(next)
    const actor = createActor(estimatePushMachine, { input: { entityId: 'push-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: 'REVIEW' })
    await settle()
    expect(dispatchEstimatePushEventMock).toHaveBeenCalledWith('push-1', 'REVIEW', 2)
    expect(actor.getSnapshot().context.snapshot).toEqual(next)
  })

  it('409 from dispatchEstimatePushEvent triggers reload and outOfSync flag', async () => {
    fetchEstimatePushMock.mockResolvedValueOnce(baseSnapshot)
    const fresh: EstimatePushSnapshot = { ...baseSnapshot, state_version: 11 }
    fetchEstimatePushMock.mockResolvedValueOnce(fresh)
    dispatchEstimatePushEventMock.mockRejectedValueOnce(new Error('HTTP 409: stale'))
    const actor = createActor(estimatePushMachine, { input: { entityId: 'push-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: 'APPROVE' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.context.outOfSync).toBe(true)
    expect(snap.context.snapshot).toEqual(fresh)
  })
})
