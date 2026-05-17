import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  LABOR_PAYROLL_WORKFLOW_NAME,
  LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
  transitionLaborPayrollWorkflow,
  type LaborPayrollWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = LABOR_PAYROLL_WORKFLOW_NAME
const SCHEMA = LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000030'

function entry(
  state_version: number,
  event_payload: Record<string, unknown> & { type: string },
  snapshot_after: LaborPayrollWorkflowSnapshot,
): WorkflowEventLogEntry {
  return {
    workflow_name: NAME,
    schema_version: SCHEMA,
    entity_id: ENTITY,
    state_version,
    event_payload,
    snapshot_after: snapshot_after as unknown as WorkflowEventLogEntry['snapshot_after'],
  }
}

describe('labor-payroll — applyEventLog replay', () => {
  it('happy path: generated → approved → posting → posted', () => {
    let snap: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const e1 = {
      type: 'APPROVE' as const,
      approved_at: '2026-04-29T10:00:00.000Z',
      approved_by: 'office-user',
    }
    let prev = snap
    snap = transitionLaborPayrollWorkflow(prev, e1)
    log.push(entry(1, e1, snap))

    const e2 = { type: 'POST_REQUESTED' as const }
    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, e2)
    log.push(entry(2, e2, snap))

    const e3 = {
      type: 'POST_SUCCEEDED' as const,
      posted_at: '2026-04-29T10:01:00.000Z',
      qbo_timeactivity_ids: ['ta-1', 'ta-2', 'ta-3'],
    }
    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, e3)
    log.push(entry(3, e3, snap))

    const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const result = applyEventLog<LaborPayrollWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('posted')
    expect(result.finalSnapshot?.qbo_timeactivity_ids).toEqual(['ta-1', 'ta-2', 'ta-3'])
  })

  it('alternate path: approve → void', () => {
    let snap: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const e1 = {
      type: 'APPROVE' as const,
      approved_at: '2026-04-29T10:00:00.000Z',
      approved_by: 'office',
    }
    let prev = snap
    snap = transitionLaborPayrollWorkflow(prev, e1)
    log.push(entry(1, e1, snap))

    const e2 = { type: 'VOID' as const }
    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, e2)
    log.push(entry(2, e2, snap))

    const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const result = applyEventLog<LaborPayrollWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('voided')
  })

  it('alternate path: failure → retry → re-post → posted', () => {
    let snap: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const approveEvent = {
      type: 'APPROVE' as const,
      approved_at: '2026-04-29T10:00:00.000Z',
      approved_by: 'office',
    }
    let prev = snap
    snap = transitionLaborPayrollWorkflow(prev, approveEvent)
    log.push(entry(1, approveEvent, snap))

    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, { type: 'POST_REQUESTED' })
    log.push(entry(2, { type: 'POST_REQUESTED' }, snap))

    const failEvent = {
      type: 'POST_FAILED' as const,
      failed_at: '2026-04-29T10:01:00.000Z',
      error: 'qbo rate limit',
    }
    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, failEvent)
    log.push(entry(3, failEvent, snap))

    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, { type: 'RETRY_POST' })
    log.push(entry(4, { type: 'RETRY_POST' }, snap))

    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, { type: 'POST_REQUESTED' })
    log.push(entry(5, { type: 'POST_REQUESTED' }, snap))

    const succeededEvent = {
      type: 'POST_SUCCEEDED' as const,
      posted_at: '2026-04-29T10:02:00.000Z',
      qbo_timeactivity_ids: ['ta-1'],
    }
    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, succeededEvent)
    log.push(entry(6, succeededEvent, snap))

    const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const result = applyEventLog<LaborPayrollWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('posted')
  })
})
