import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Tests for project-lifecycle.ts — wraps the headless factory with the
 * discriminated DECLINE envelope shape (DECLINE optionally carries a
 * `reason`; every other event is just the type tag).
 */

const fetchProjectLifecycleMock = vi.fn()
const dispatchProjectLifecycleEventMock = vi.fn()

vi.mock('@/lib/api', () => ({
  fetchProjectLifecycle: (...args: unknown[]) => fetchProjectLifecycleMock(...args),
  dispatchProjectLifecycleEvent: (...args: unknown[]) => dispatchProjectLifecycleEventMock(...args),
}))

import { projectLifecycleMachine } from './project-lifecycle.js'
import type { ProjectLifecycleSnapshot } from '@/lib/api/project-lifecycle'

const baseSnapshot: ProjectLifecycleSnapshot = {
  state: 'sent',
  state_version: 3,
  context: {
    project_id: 'p-1',
    name: 'Main St',
    customer_name: 'ACME',
    sent_at: '2026-05-01T00:00:00.000Z',
    accepted_at: null,
    declined_at: null,
    decline_reason: null,
    started_at: null,
    completed_at: null,
    archived_at: null,
  },
  next_events: [
    { type: 'ACCEPT', label: 'Accept' },
    { type: 'DECLINE', label: 'Decline' },
  ],
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  fetchProjectLifecycleMock.mockReset()
  dispatchProjectLifecycleEventMock.mockReset()
})

describe('projectLifecycleMachine', () => {
  it('LOAD calls fetchProjectLifecycle and stashes snapshot', async () => {
    fetchProjectLifecycleMock.mockResolvedValueOnce(baseSnapshot)
    const actor = createActor(projectLifecycleMachine, { input: { entityId: 'p-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot).toEqual(baseSnapshot)
    expect(fetchProjectLifecycleMock).toHaveBeenCalledWith('p-1')
  })

  it('DISPATCH({ type: ACCEPT }) forwards the envelope verbatim', async () => {
    fetchProjectLifecycleMock.mockResolvedValueOnce(baseSnapshot)
    const next: ProjectLifecycleSnapshot = {
      ...baseSnapshot,
      state: 'accepted',
      state_version: 4,
      context: { ...baseSnapshot.context, accepted_at: '2026-05-02T00:00:00.000Z' },
    }
    dispatchProjectLifecycleEventMock.mockResolvedValueOnce(next)
    const actor = createActor(projectLifecycleMachine, { input: { entityId: 'p-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: { type: 'ACCEPT' } })
    await settle()
    expect(dispatchProjectLifecycleEventMock).toHaveBeenCalledWith('p-1', { type: 'ACCEPT' }, 3)
    expect(actor.getSnapshot().context.snapshot).toEqual(next)
  })

  it('DISPATCH DECLINE carries the reason on the envelope', async () => {
    fetchProjectLifecycleMock.mockResolvedValueOnce(baseSnapshot)
    const next: ProjectLifecycleSnapshot = {
      ...baseSnapshot,
      state: 'declined',
      state_version: 4,
      context: {
        ...baseSnapshot.context,
        declined_at: '2026-05-02T00:00:00.000Z',
        decline_reason: 'Customer postponed',
      },
    }
    dispatchProjectLifecycleEventMock.mockResolvedValueOnce(next)
    const actor = createActor(projectLifecycleMachine, { input: { entityId: 'p-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: { type: 'DECLINE', reason: 'Customer postponed' } })
    await settle()
    // The reason rides along on the event envelope, not a side channel.
    expect(dispatchProjectLifecycleEventMock).toHaveBeenCalledWith(
      'p-1',
      { type: 'DECLINE', reason: 'Customer postponed' },
      3,
    )
    expect(actor.getSnapshot().context.snapshot?.context.decline_reason).toBe('Customer postponed')
  })

  it('409 from dispatchProjectLifecycleEvent triggers reload and outOfSync', async () => {
    fetchProjectLifecycleMock.mockResolvedValueOnce(baseSnapshot)
    const fresh: ProjectLifecycleSnapshot = { ...baseSnapshot, state_version: 17 }
    fetchProjectLifecycleMock.mockResolvedValueOnce(fresh)
    dispatchProjectLifecycleEventMock.mockRejectedValueOnce(new Error('409 stale'))
    const actor = createActor(projectLifecycleMachine, { input: { entityId: 'p-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: { type: 'ACCEPT' } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.context.outOfSync).toBe(true)
    expect(snap.context.snapshot).toEqual(fresh)
  })
})
