import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  LABOR_PAYROLL_ALL_STATES,
  LABOR_PAYROLL_WORKFLOW_NAME,
  LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
  laborPayrollWorkflow,
  nextLaborPayrollEvents,
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

  it('auto-post path: generated → AUTO_APPROVE → AUTO_POST_REQUESTED → posting → posted', () => {
    let snap: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const e1 = {
      type: 'AUTO_APPROVE' as const,
      approved_at: '2026-04-29T10:00:00.000Z',
      approved_by: 'system:auto-post',
    }
    let prev = snap
    snap = transitionLaborPayrollWorkflow(prev, e1)
    log.push(entry(1, e1, snap))
    expect(snap.state).toBe('approved')
    expect(snap.auto_posted).toBe(true)

    const e2 = { type: 'AUTO_POST_REQUESTED' as const }
    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, e2)
    log.push(entry(2, e2, snap))
    expect(snap.state).toBe('posting')

    const e3 = {
      type: 'POST_SUCCEEDED' as const,
      posted_at: '2026-04-29T10:01:00.000Z',
      qbo_timeactivity_ids: ['ta-1'],
    }
    prev = snap
    snap = transitionLaborPayrollWorkflow(prev, e3)
    log.push(entry(3, e3, snap))

    const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const result = applyEventLog<LaborPayrollWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('posted')
    expect(result.finalSnapshot?.auto_posted).toBe(true)
  })

  it('a stale auto-tick that races a human VOID is rejected by the reducer', () => {
    // The run was VOIDed by a human before the auto-tick fired. AUTO_APPROVE
    // asserts from `generated`, so it throws once the run is `voided`.
    const voided: LaborPayrollWorkflowSnapshot = { state: 'voided', state_version: 3 }
    expect(() =>
      transitionLaborPayrollWorkflow(voided, {
        type: 'AUTO_APPROVE',
        approved_at: '2026-04-29T10:00:00.000Z',
        approved_by: 'system:auto-post',
      }),
    ).toThrow()
  })
})

describe('labor-payroll — next_events per state (golden)', () => {
  it('matches the canonical UI affordance map', () => {
    const map: Record<string, ReadonlyArray<{ type: string; label: string }>> = {}
    for (const state of LABOR_PAYROLL_ALL_STATES) {
      map[state] = laborPayrollWorkflow.nextEvents(state).map((e) => ({ type: e.type, label: e.label }))
    }
    expect(map).toMatchInlineSnapshot(`
      {
        "approved": [
          {
            "label": "Post time activities to QuickBooks",
            "type": "POST_REQUESTED",
          },
          {
            "label": "Void",
            "type": "VOID",
          },
        ],
        "failed": [
          {
            "label": "Retry QuickBooks post",
            "type": "RETRY_POST",
          },
          {
            "label": "Void",
            "type": "VOID",
          },
        ],
        "generated": [
          {
            "label": "Approve payroll run",
            "type": "APPROVE",
          },
          {
            "label": "Void",
            "type": "VOID",
          },
        ],
        "posted": [],
        "posting": [],
        "voided": [],
      }
    `)
  })

  it('failed → POST_REQUESTED is reducer-legal but intentionally NOT surfaced in next_events', () => {
    // The reducer permits a direct re-post from `failed` (the assert
    // from-set is ['approved','failed']) but the UI only offers RETRY_POST
    // (→ approved). This pins the intentional divergence so a future edit
    // to either selector forces a conscious decision.
    const next = transitionLaborPayrollWorkflow({ state: 'failed', state_version: 4 }, { type: 'POST_REQUESTED' })
    expect(next.state).toBe('posting')

    const surfaced = nextLaborPayrollEvents('failed').map((e) => e.type)
    expect(surfaced).not.toContain('POST_REQUESTED')
    expect(surfaced).toEqual(['RETRY_POST', 'VOID'])
  })
})

describe('labor-payroll — replay-integrity negatives', () => {
  it('detects a forged snapshot_after as snapshot_divergence', () => {
    const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const approveEvent = { type: 'APPROVE', approved_at: '2026-04-29T10:00:00.000Z', approved_by: 'office-user' }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: approveEvent,
        // forged: claims state=posted instead of approved
        snapshot_after: { state: 'posted', state_version: 2, approved_by: 'office-user' },
      },
    ]
    const result = applyEventLog<LaborPayrollWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('snapshot_divergence')
  })

  it('detects a state_version gap', () => {
    const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        // skips state_version=1
        state_version: 2,
        event_payload: { type: 'POST_REQUESTED' },
        snapshot_after: { state: 'posting', state_version: 3 },
      },
    ]
    const result = applyEventLog<LaborPayrollWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('gap')
  })

  it('rejects event log written under a different schema_version', () => {
    const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: 999,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: { type: 'VOID' },
        snapshot_after: { state: 'voided', state_version: 2 },
      },
    ]
    const result = applyEventLog<LaborPayrollWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('schema_version_mismatch')
  })

  it('treats missing-and-null as equal so reducer-fresh output matches a persisted snapshot_after with all null fields', () => {
    // The API handler spreads the live row before applying the transition,
    // so it persists every reducer-snapshot field with explicit nulls.
    // Reducer-fresh output from a minimal initial state omits the keys the
    // transition didn't touch. The harness MUST treat these as equivalent
    // or every replay would falsely report snapshot_divergence.
    const initial: LaborPayrollWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const approveEvent = { type: 'APPROVE', approved_at: '2026-04-29T10:00:00.000Z', approved_by: 'office-user' }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: approveEvent,
        snapshot_after: {
          state: 'approved',
          state_version: 2,
          approved_at: '2026-04-29T10:00:00.000Z',
          approved_by: 'office-user',
          posted_at: null,
          failed_at: null,
          error: null,
          qbo_timeactivity_ids: null,
        },
      },
    ]
    const result = applyEventLog<LaborPayrollWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })
})
