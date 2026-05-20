import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Unit tests for the `portalEstimateLoad` machine. The machine is a
 * one-shot loader that wraps `fetchPortalEstimate` so the
 * `EstimateAcceptedView` screen can stay a thin renderer. We assert
 * the load + error + RELOAD transitions and that errors get translated
 * through `PortalApiError.message_for_user()` for user-facing copy.
 */

const fetchPortalEstimateMock = vi.fn()

vi.mock('@/portal/api', async () => {
  const actual = await vi.importActual<typeof import('@/portal/api')>('@/portal/api')
  return {
    ...actual,
    fetchPortalEstimate: (...args: unknown[]) => fetchPortalEstimateMock(...args),
  }
})

import { portalEstimateLoadMachine } from './portal-estimate-load.js'
import { PortalApiError, type PortalEstimateView } from '@/portal/api'

const baseView: PortalEstimateView = {
  id: 'share-1',
  project_name: 'Acme HQ',
  company_name: 'ACME Builders',
  recipient_email: 'jane@example.com',
  recipient_name: 'Jane Doe',
  sent_at: '2026-05-01T00:00:00Z',
  expires_at: '2026-06-01T00:00:00Z',
  status: 'accepted',
  estimate: { bid_total: 1000, scope_total: 1000, lines: [], captured_at: '2026-05-01T00:00:00Z' },
  accepted_at: '2026-05-02T00:00:00Z',
  declined_at: null,
  decline_reason: null,
  signer_name: 'Jane Doe',
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

function startActor(shareToken = 'tok-123') {
  const actor = createActor(portalEstimateLoadMachine, { input: { shareToken } })
  actor.start()
  return actor
}

describe('portalEstimateLoadMachine', () => {
  beforeEach(() => {
    fetchPortalEstimateMock.mockReset()
  })

  it('starts in loading state', () => {
    fetchPortalEstimateMock.mockImplementation(() => new Promise(() => {}))
    const actor = startActor()
    expect(actor.getSnapshot().value).toBe('loading')
  })

  it('lands in idle with view populated once load resolves', async () => {
    fetchPortalEstimateMock.mockResolvedValue(baseView)
    const actor = startActor()
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.view).toEqual(baseView)
    expect(snap.context.error).toBeNull()
    expect(fetchPortalEstimateMock).toHaveBeenCalledWith('tok-123')
  })

  it('lands in idle with translated error on PortalApiError', async () => {
    fetchPortalEstimateMock.mockRejectedValue(
      new PortalApiError({ status: 410, path: '/api/portal/estimates/tok-123', body: null }),
    )
    const actor = startActor()
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.error).toBe('This link has expired.')
    expect(snap.context.view).toBeNull()
  })

  it('lands in idle with raw message on plain Error', async () => {
    fetchPortalEstimateMock.mockRejectedValue(new Error('network down'))
    const actor = startActor()
    await settle()
    expect(actor.getSnapshot().context.error).toBe('network down')
  })

  it('RELOAD from idle re-invokes the loader', async () => {
    fetchPortalEstimateMock.mockResolvedValue(baseView)
    const actor = startActor()
    await settle()
    expect(fetchPortalEstimateMock).toHaveBeenCalledTimes(1)
    actor.send({ type: 'RELOAD' })
    expect(actor.getSnapshot().value).toBe('loading')
    await settle()
    expect(actor.getSnapshot().value).toBe('idle')
    expect(fetchPortalEstimateMock).toHaveBeenCalledTimes(2)
  })

  it('successful RELOAD clears a prior error', async () => {
    fetchPortalEstimateMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(baseView)
    const actor = startActor()
    await settle()
    expect(actor.getSnapshot().context.error).toBe('boom')
    actor.send({ type: 'RELOAD' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.context.error).toBeNull()
    expect(snap.context.view).toEqual(baseView)
  })
})
