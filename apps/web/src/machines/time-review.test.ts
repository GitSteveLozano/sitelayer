import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Tests for the timeReview XState machine.
 *
 * The machine reads via `fetchTimeReviewRun` and writes via `request`
 * (`/api/time-review-runs/:id/events`). We mock both so the tests stay
 * pure state-machine.
 */

const fetchTimeReviewRunMock = vi.fn()
const requestMock = vi.fn<(path: string, options?: unknown) => Promise<unknown>>()

vi.mock('../lib/api/time-review', () => ({
  fetchTimeReviewRun: (...args: unknown[]) => fetchTimeReviewRunMock(...args),
}))

vi.mock('../lib/api/client', () => ({
  request: (path: string, options?: unknown) => requestMock(path, options),
}))

import { timeReviewMachine } from './time-review.js'
import type { TimeReviewSnapshot } from '../lib/api/time-review'

const baseSnapshot: TimeReviewSnapshot = {
  state: 'pending',
  state_version: 6,
  context: {
    id: 'tr-1',
    company_id: 'co-1',
    project_id: 'p-1',
    period_start: '2026-05-01',
    period_end: '2026-05-07',
    covered_entry_ids: ['le-1', 'le-2'],
    total_hours: '80',
    total_entries: 2,
    anomaly_count: 0,
    reviewer_user_id: null,
    approved_at: null,
    rejected_at: null,
    rejection_reason: null,
    reopened_at: null,
    workflow_engine: 'local',
    workflow_run_id: null,
    origin: 'manual',
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
  },
  next_events: [
    { type: 'APPROVE', label: 'Approve' },
    { type: 'REJECT', label: 'Reject' },
  ],
}

async function settle() {
  // Walk multiple microtask turns to flush nested awaits (e.g. the
  // conflict-reload path that awaits a second `fetchTimeReviewRun`).
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  fetchTimeReviewRunMock.mockReset()
  requestMock.mockReset()
})

describe('timeReviewMachine', () => {
  it('starts in loading then settles to idle with the pending snapshot', async () => {
    fetchTimeReviewRunMock.mockResolvedValueOnce(baseSnapshot)
    const actor = createActor(timeReviewMachine, { input: { runId: 'tr-1', companySlug: 'acme' } })
    actor.start()
    expect(actor.getSnapshot().value).toBe('loading')
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot).toEqual(baseSnapshot)
    expect(snap.context.snapshot?.state).toBe('pending')
    expect(fetchTimeReviewRunMock).toHaveBeenCalledWith('tr-1')
  })

  it('DISPATCH(APPROVE) → submitting → idle with approved snapshot', async () => {
    fetchTimeReviewRunMock.mockResolvedValueOnce(baseSnapshot)
    const approved: TimeReviewSnapshot = {
      ...baseSnapshot,
      state: 'approved',
      state_version: 7,
      context: { ...baseSnapshot.context, approved_at: '2026-05-09T00:00:00.000Z' },
    }
    requestMock.mockResolvedValueOnce(approved)
    const actor = createActor(timeReviewMachine, { input: { runId: 'tr-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'APPROVE' } })
    expect(actor.getSnapshot().value).toBe('submitting')
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.snapshot?.state).toBe('approved')
    const [path, options] = requestMock.mock.calls[0]!
    expect(path).toBe('/api/time-review-runs/tr-1/events')
    const opts = options as { method: string; json: Record<string, unknown> }
    expect(opts.method).toBe('POST')
    expect(opts.json).toEqual({ event: 'APPROVE', state_version: 6 })
  })

  it('DISPATCH(REJECT) with a reason puts the reason in the request body', async () => {
    fetchTimeReviewRunMock.mockResolvedValueOnce(baseSnapshot)
    const rejected: TimeReviewSnapshot = {
      ...baseSnapshot,
      state: 'rejected',
      state_version: 7,
      context: { ...baseSnapshot.context, rejected_at: '2026-05-09T00:00:00.000Z', rejection_reason: 'fix entries' },
    }
    requestMock.mockResolvedValueOnce(rejected)
    const actor = createActor(timeReviewMachine, { input: { runId: 'tr-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'REJECT', reason: 'fix entries' } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.context.snapshot?.state).toBe('rejected')
    const [, options] = requestMock.mock.calls[0]!
    const opts = options as { method: string; json: Record<string, unknown> }
    expect(opts.json).toEqual({ event: 'REJECT', state_version: 6, reason: 'fix entries' })
  })

  it('409 from dispatch triggers reload and outOfSync', async () => {
    fetchTimeReviewRunMock.mockResolvedValueOnce(baseSnapshot)
    const fresh: TimeReviewSnapshot = { ...baseSnapshot, state_version: 99 }
    fetchTimeReviewRunMock.mockResolvedValueOnce(fresh)
    requestMock.mockRejectedValueOnce(new Error('HTTP 409: state_version'))
    const actor = createActor(timeReviewMachine, { input: { runId: 'tr-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'APPROVE' } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.outOfSync).toBe(true)
    expect(snap.context.snapshot).toEqual(fresh)
    expect(snap.context.error).toMatch(/409/)
  })

  it('non-409 failure leaves prior snapshot and records error', async () => {
    fetchTimeReviewRunMock.mockResolvedValueOnce(baseSnapshot)
    requestMock.mockRejectedValueOnce(new Error('network down'))
    const actor = createActor(timeReviewMachine, { input: { runId: 'tr-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'APPROVE' } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.error).toBe('network down')
    expect(snap.context.outOfSync).toBe(false)
    expect(snap.context.snapshot).toEqual(baseSnapshot)
  })

  it('DISMISS_ERROR clears the error and stays in idle', async () => {
    fetchTimeReviewRunMock.mockResolvedValueOnce(baseSnapshot)
    requestMock.mockRejectedValueOnce(new Error('409 stale'))
    const actor = createActor(timeReviewMachine, { input: { runId: 'tr-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    actor.send({ type: 'DISPATCH', payload: { event: 'APPROVE' } })
    await settle()
    expect(actor.getSnapshot().context.outOfSync).toBe(true)
    actor.send({ type: 'DISMISS_ERROR' })
    const snap = actor.getSnapshot()
    expect(snap.context.error).toBeNull()
    expect(snap.context.outOfSync).toBe(false)
    expect(snap.value).toBe('idle')
  })

  it('initial load failure records error in context', async () => {
    fetchTimeReviewRunMock.mockRejectedValueOnce(new Error('not found'))
    const actor = createActor(timeReviewMachine, { input: { runId: 'tr-1', companySlug: 'acme' } })
    actor.start()
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.error).toBe('not found')
    expect(snap.context.snapshot).toBeNull()
  })
})
