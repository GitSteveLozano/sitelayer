import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Tests for billing-review.ts — a thin wrapper that binds the headless
 * workflow factory to the rental-billing API. We verify the factory
 * wiring resolves: the machine fetches via the mocked `fetchBillingRun`
 * and submits via the mocked `dispatchBillingRunEvent` with the right
 * arguments.
 */

const fetchBillingRunMock = vi.fn()
const dispatchBillingRunEventMock = vi.fn()

vi.mock('@/lib/api', () => ({
  fetchBillingRun: (...args: unknown[]) => fetchBillingRunMock(...args),
  dispatchBillingRunEvent: (...args: unknown[]) => dispatchBillingRunEventMock(...args),
}))

import { billingReviewMachine } from './billing-review.js'
import type { RentalBillingSnapshot } from '@/lib/api/billing-runs'

const baseSnapshot: RentalBillingSnapshot = {
  state: 'generated',
  state_version: 4,
  next_events: [{ type: 'APPROVE', label: 'Approve' }],
  context: {
    id: 'run-1',
    contract_id: 'c-1',
    project_id: 'p-1',
    customer_id: 'cust-1',
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    subtotal: '1234.00',
    qbo_invoice_id: null,
    approved_at: null,
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
  fetchBillingRunMock.mockReset()
  dispatchBillingRunEventMock.mockReset()
})

describe('billingReviewMachine', () => {
  it('LOAD calls fetchBillingRun and stashes snapshot in context', async () => {
    fetchBillingRunMock.mockResolvedValueOnce(baseSnapshot)
    const actor = createActor(billingReviewMachine, { input: { entityId: 'run-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot).toEqual(baseSnapshot)
    // billing-review wraps the factory and only forwards (runId) — the
    // companySlug is intentionally dropped because rental-billing isn't
    // company-slug-scoped at the HTTP layer.
    expect(fetchBillingRunMock).toHaveBeenCalledWith('run-1')
  })

  it('DISPATCH(APPROVE) calls dispatchBillingRunEvent with run id, event, and version', async () => {
    fetchBillingRunMock.mockResolvedValueOnce(baseSnapshot)
    const next: RentalBillingSnapshot = {
      ...baseSnapshot,
      state: 'approved',
      state_version: 5,
    }
    dispatchBillingRunEventMock.mockResolvedValueOnce(next)
    const actor = createActor(billingReviewMachine, { input: { entityId: 'run-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: 'APPROVE' })
    await settle()
    expect(dispatchBillingRunEventMock).toHaveBeenCalledWith('run-1', 'APPROVE', 4)
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot).toEqual(next)
  })

  it('409 from dispatchBillingRunEvent triggers reload and outOfSync flag', async () => {
    fetchBillingRunMock.mockResolvedValueOnce(baseSnapshot)
    const fresh: RentalBillingSnapshot = { ...baseSnapshot, state_version: 9 }
    fetchBillingRunMock.mockResolvedValueOnce(fresh)
    dispatchBillingRunEventMock.mockRejectedValueOnce(new Error('HTTP 409: state_version'))
    const actor = createActor(billingReviewMachine, { input: { entityId: 'run-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', event: 'APPROVE' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.context.outOfSync).toBe(true)
    expect(snap.context.snapshot).toEqual(fresh)
  })
})
