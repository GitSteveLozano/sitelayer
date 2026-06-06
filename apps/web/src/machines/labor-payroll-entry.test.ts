import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Tests for the labor-payroll-entry machine — the create + coverage
 * preview flow. We verify the deterministic editing → previewing →
 * previewed → creating → created order, the create-guard (no CREATE
 * before a preview), and the 400 / 409 error surfaces.
 */

const previewMock = vi.fn()
const createMock = vi.fn()

vi.mock('../lib/api/labor-payroll-runs', () => ({
  previewLaborPayrollCoverage: (...args: unknown[]) => previewMock(...args),
  createLaborPayrollRun: (...args: unknown[]) => createMock(...args),
}))

import { laborPayrollEntryMachine } from './labor-payroll-entry.js'
import { ApiError } from '../lib/api/client'
import type { LaborPayrollPreviewResponse, LaborPayrollSnapshot } from '../lib/api/labor-payroll-runs'

const previewPayload: LaborPayrollPreviewResponse = {
  period_start: '2026-05-01',
  period_end: '2026-05-07',
  covered_labor_entry_ids: ['le-1', 'le-2'],
  total_entries: 2,
  total_hours: '16.0',
  total_cents: '32000',
  labor_entries: [
    { id: 'le-1', worker_id: 'w-1', hours: '8.0', occurred_on: '2026-05-01' },
    { id: 'le-2', worker_id: 'w-1', hours: '8.0', occurred_on: '2026-05-02' },
  ],
}

const createdSnapshot: LaborPayrollSnapshot = {
  state: 'generated',
  state_version: 1,
  next_events: [{ type: 'APPROVE', label: 'Approve payroll run' }],
  context: {
    id: 'run-99',
    company_id: 'co-1',
    period_start: '2026-05-01',
    period_end: '2026-05-07',
    approved_at: null,
    approved_by_user_id: null,
    posted_at: null,
    failed_at: null,
    error_message: null,
    qbo_payroll_batch_ref: null,
    covered_labor_entry_ids: ['le-1', 'le-2'],
    total_hours: '16.0',
    total_cents: '32000',
    time_review_run_id: null,
    workflow_engine: 'local',
    workflow_run_id: null,
    auto_posted: false,
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
  },
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

function start() {
  const actor = createActor(laborPayrollEntryMachine, { input: { companySlug: 'acme' } })
  actor.start()
  return actor
}

beforeEach(() => {
  previewMock.mockReset()
  createMock.mockReset()
})

describe('laborPayrollEntryMachine', () => {
  it('editing → PREVIEW → previewed populates context.preview', async () => {
    previewMock.mockResolvedValueOnce(previewPayload)
    const actor = start()
    actor.send({ type: 'SET_PERIOD', period_start: '2026-05-01', period_end: '2026-05-07' })
    actor.send({ type: 'PREVIEW' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('previewed')
    expect(snap.context.preview).toEqual(previewPayload)
    expect(previewMock).toHaveBeenCalledWith('2026-05-01', '2026-05-07')
  })

  it('PREVIEW is blocked until a period is set', async () => {
    const actor = start()
    actor.send({ type: 'PREVIEW' })
    await settle()
    expect(actor.getSnapshot().value).toBe('editing')
    expect(previewMock).not.toHaveBeenCalled()
  })

  it('CREATE from previewed lands created with createdRunId', async () => {
    previewMock.mockResolvedValueOnce(previewPayload)
    createMock.mockResolvedValueOnce(createdSnapshot)
    const actor = start()
    actor.send({ type: 'SET_PERIOD', period_start: '2026-05-01', period_end: '2026-05-07' })
    actor.send({ type: 'PREVIEW' })
    await settle()
    actor.send({ type: 'CREATE' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('created')
    expect(snap.context.createdRunId).toBe('run-99')
    expect(createMock).toHaveBeenCalledWith({
      period_start: '2026-05-01',
      period_end: '2026-05-07',
      time_review_run_id: null,
    })
  })

  it('CREATE is rejected from editing (must preview first)', async () => {
    const actor = start()
    actor.send({ type: 'SET_PERIOD', period_start: '2026-05-01', period_end: '2026-05-07' })
    actor.send({ type: 'CREATE' })
    await settle()
    expect(actor.getSnapshot().value).toBe('editing')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('409 from create surfaces existing_run_id and stays out of created', async () => {
    previewMock.mockResolvedValueOnce(previewPayload)
    createMock.mockRejectedValueOnce(
      new ApiError({
        status: 409,
        path: '/api/labor-payroll-runs',
        method: 'POST',
        requestId: null,
        body: { error: 'a labor payroll run already exists for this period', existing_run_id: 'run-7' },
      }),
    )
    const actor = start()
    actor.send({ type: 'SET_PERIOD', period_start: '2026-05-01', period_end: '2026-05-07' })
    actor.send({ type: 'PREVIEW' })
    await settle()
    actor.send({ type: 'CREATE' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('previewed')
    expect(snap.context.createdRunId).toBeNull()
    expect(snap.context.existingRunId).toBe('run-7')
    expect(snap.context.error).toContain('already exists')
  })

  it('400 (no eligible entries) returns to editing with the message', async () => {
    previewMock.mockResolvedValueOnce(previewPayload)
    createMock.mockRejectedValueOnce(
      new ApiError({
        status: 400,
        path: '/api/labor-payroll-runs',
        method: 'POST',
        requestId: null,
        body: { error: 'no eligible labor entries in this window' },
      }),
    )
    const actor = start()
    actor.send({ type: 'SET_PERIOD', period_start: '2026-05-01', period_end: '2026-05-07' })
    actor.send({ type: 'PREVIEW' })
    await settle()
    actor.send({ type: 'CREATE' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('editing')
    expect(snap.context.error).toContain('no eligible labor entries')
    expect(snap.context.createdRunId).toBeNull()
  })
})
