import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Tests for the changeOrder XState machine.
 *
 * The machine reads via `fetchChangeOrderSnapshot` and writes via
 * `request` (`/api/change-orders/:id/events`). We mock both so the tests
 * stay pure state-machine. The machine NEVER stores a business state of
 * its own — `state.value` is only loading|idle|submitting and the CO's
 * business state lives at `context.snapshot.state`.
 */

const fetchChangeOrderSnapshotMock = vi.fn()
const requestMock = vi.fn<(path: string, options?: unknown) => Promise<unknown>>()

vi.mock('../lib/api/change-orders', () => ({
  fetchChangeOrderSnapshot: (...args: unknown[]) => fetchChangeOrderSnapshotMock(...args),
}))

vi.mock('../lib/api/client', () => ({
  request: (path: string, options?: unknown) => requestMock(path, options),
}))

import { changeOrderMachine } from './change-order.js'
import type { ChangeOrderSnapshot } from '../lib/api/change-orders'

const baseSnapshot: ChangeOrderSnapshot = {
  state: 'sent',
  state_version: 4,
  context: {
    id: 'co-1',
    company_id: 'co-corp',
    project_id: 'p-1',
    number: 3,
    description: 'Added stone veneer on south wall',
    value_delta: 5280,
    schedule_impact_days: 2,
    status: 'sent',
    state_version: 4,
    sent_at: '2026-05-08T00:00:00.000Z',
    accepted_at: null,
    rejected_at: null,
    voided_at: null,
    reject_reason: null,
    created_by: 'u-1',
    approved_by: null,
    version: 4,
    created_at: '2026-05-07T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
  },
  next_events: [
    { type: 'ACCEPT', label: 'Mark accepted' },
    { type: 'REJECT', label: 'Mark rejected' },
    { type: 'VOID', label: 'Void' },
  ],
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  fetchChangeOrderSnapshotMock.mockReset()
  requestMock.mockReset()
})

describe('changeOrderMachine', () => {
  it('starts in loading then settles to idle with the sent snapshot', async () => {
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce(baseSnapshot)
    const actor = createActor(changeOrderMachine, { input: { coId: 'co-1' } })
    actor.start()
    expect(actor.getSnapshot().value).toBe('loading')
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot).toEqual(baseSnapshot)
    expect(snap.context.snapshot?.state).toBe('sent')
    expect(fetchChangeOrderSnapshotMock).toHaveBeenCalledWith('co-1')
  })

  it('never stores a business state of its own (state.value is loading|idle|submitting only)', async () => {
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce(baseSnapshot)
    const actor = createActor(changeOrderMachine, { input: { coId: 'co-1' } })
    actor.start()
    await settle()
    const value = actor.getSnapshot().value
    expect(['loading', 'idle', 'submitting']).toContain(value)
    // The business state is on the snapshot, never on state.value.
    expect(value).not.toBe('sent')
  })

  it('DISPATCH(ACCEPT) → submitting → idle with accepted snapshot', async () => {
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce(baseSnapshot)
    const accepted: ChangeOrderSnapshot = {
      ...baseSnapshot,
      state: 'accepted',
      state_version: 5,
      context: {
        ...baseSnapshot.context,
        status: 'accepted',
        state_version: 5,
        accepted_at: '2026-05-09T00:00:00.000Z',
        approved_by: 'u-2',
      },
      next_events: [],
    }
    requestMock.mockResolvedValueOnce(accepted)
    const actor = createActor(changeOrderMachine, { input: { coId: 'co-1' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'ACCEPT' } })
    expect(actor.getSnapshot().value).toBe('submitting')
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot?.state).toBe('accepted')
    expect(snap.context.snapshot?.next_events).toEqual([])
    const [path, options] = requestMock.mock.calls[0]!
    expect(path).toBe('/api/change-orders/co-1/events')
    const opts = options as { method: string; json: Record<string, unknown> }
    expect(opts.method).toBe('POST')
    expect(opts.json).toEqual({ event: 'ACCEPT', state_version: 4 })
  })

  it('DISPATCH(REJECT) with a reason puts the reason in the request body', async () => {
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce(baseSnapshot)
    const rejected: ChangeOrderSnapshot = {
      ...baseSnapshot,
      state: 'rejected',
      state_version: 5,
      context: {
        ...baseSnapshot.context,
        status: 'rejected',
        state_version: 5,
        rejected_at: '2026-05-09T00:00:00.000Z',
        reject_reason: 'over budget',
      },
      next_events: [],
    }
    requestMock.mockResolvedValueOnce(rejected)
    const actor = createActor(changeOrderMachine, { input: { coId: 'co-1' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'REJECT', reason: 'over budget' } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.context.snapshot?.state).toBe('rejected')
    const [, options] = requestMock.mock.calls[0]!
    const opts = options as { method: string; json: Record<string, unknown> }
    expect(opts.json).toEqual({ event: 'REJECT', state_version: 4, reason: 'over budget' })
  })

  it('409 from dispatch triggers reload and outOfSync with the fresh snapshot', async () => {
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce(baseSnapshot)
    const fresh: ChangeOrderSnapshot = { ...baseSnapshot, state_version: 99 }
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce(fresh)
    requestMock.mockRejectedValueOnce(new Error('HTTP 409: state_version'))
    const actor = createActor(changeOrderMachine, { input: { coId: 'co-1' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'ACCEPT' } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.outOfSync).toBe(true)
    expect(snap.context.snapshot).toEqual(fresh)
    expect(snap.context.error).toMatch(/409/)
  })

  it('non-409 failure leaves prior snapshot and records error', async () => {
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce(baseSnapshot)
    requestMock.mockRejectedValueOnce(new Error('network down'))
    const actor = createActor(changeOrderMachine, { input: { coId: 'co-1' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'ACCEPT' } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.error).toBe('network down')
    expect(snap.context.outOfSync).toBe(false)
    expect(snap.context.snapshot).toEqual(baseSnapshot)
  })

  it('DISMISS_ERROR clears the error and outOfSync, stays in idle', async () => {
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce(baseSnapshot)
    fetchChangeOrderSnapshotMock.mockResolvedValueOnce({ ...baseSnapshot, state_version: 99 })
    requestMock.mockRejectedValueOnce(new Error('409 stale'))
    const actor = createActor(changeOrderMachine, { input: { coId: 'co-1' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'ACCEPT' } })
    await settle()
    expect(actor.getSnapshot().context.outOfSync).toBe(true)
    actor.send({ type: 'DISMISS_ERROR' })
    const snap = actor.getSnapshot()
    expect(snap.context.error).toBeNull()
    expect(snap.context.outOfSync).toBe(false)
    expect(snap.value).toBe('idle')
  })

  it('initial load failure records error in context', async () => {
    fetchChangeOrderSnapshotMock.mockRejectedValueOnce(new Error('not found'))
    const actor = createActor(changeOrderMachine, { input: { coId: 'co-1' } })
    actor.start()
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.error).toBe('not found')
    expect(snap.context.snapshot).toBeNull()
  })
})
