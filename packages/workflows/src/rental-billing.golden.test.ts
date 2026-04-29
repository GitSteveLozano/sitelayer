import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  RENTAL_BILLING_ALL_STATES,
  RENTAL_BILLING_WORKFLOW_NAME,
  RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
  rentalBillingWorkflow,
  transitionRentalBillingWorkflow,
  type RentalBillingWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

/**
 * Golden-fixture tests for the rental-billing workflow.
 *
 * Two regression nets:
 *
 *   1. nextEvents-per-state snapshot — drift in the UI affordances
 *      (which buttons appear) becomes a visible diff in PR review.
 *   2. Full event-log replay — a synthetic happy-path log is fed back
 *      through applyEventLog() and the final snapshot is asserted. This
 *      mirrors how production replay will work against rows from the
 *      workflow_event_log table.
 */

describe('rental-billing — next_events per state (golden)', () => {
  it('matches the canonical UI affordance map', () => {
    const map: Record<string, ReadonlyArray<{ type: string; label: string }>> = {}
    for (const state of RENTAL_BILLING_ALL_STATES) {
      map[state] = rentalBillingWorkflow.nextEvents(state).map((e) => ({ type: e.type, label: e.label }))
    }
    expect(map).toMatchInlineSnapshot(`
      {
        "approved": [
          {
            "label": "Post invoice to QuickBooks",
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
            "label": "Approve billing run",
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
})

describe('rental-billing — replay harness against synthetic event log', () => {
  it('happy path: generated → approved → posting → posted', () => {
    const initial: RentalBillingWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const approveEvent = { type: 'APPROVE', approved_at: '2026-04-29T10:00:00.000Z', approved_by: 'office-user' }
    const approved = transitionRentalBillingWorkflow(initial, approveEvent as never)
    const posting = transitionRentalBillingWorkflow(approved, { type: 'POST_REQUESTED' })
    const postedEvent = { type: 'POST_SUCCEEDED', posted_at: '2026-04-29T10:01:00.000Z', qbo_invoice_id: 'qbo-9001' }
    const posted = transitionRentalBillingWorkflow(posting, postedEvent as never)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
        schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
        entity_id: '00000000-0000-0000-0000-000000000001',
        state_version: 1,
        event_payload: approveEvent,
        snapshot_after: approved as unknown as Record<string, unknown> & { state: string; state_version: number },
      },
      {
        workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
        schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
        entity_id: '00000000-0000-0000-0000-000000000001',
        state_version: 2,
        event_payload: { type: 'POST_REQUESTED' },
        snapshot_after: posting as unknown as Record<string, unknown> & { state: string; state_version: number },
      },
      {
        workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
        schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
        entity_id: '00000000-0000-0000-0000-000000000001',
        state_version: 3,
        event_payload: postedEvent,
        snapshot_after: posted as unknown as Record<string, unknown> & { state: string; state_version: number },
      },
    ]

    const result = applyEventLog<RentalBillingWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot).toEqual(posted)
  })

  it('detects a forged snapshot_after as snapshot_divergence', () => {
    const initial: RentalBillingWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const approveEvent = { type: 'APPROVE', approved_at: '2026-04-29T10:00:00.000Z', approved_by: 'office-user' }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
        schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
        entity_id: '00000000-0000-0000-0000-000000000001',
        state_version: 1,
        event_payload: approveEvent,
        // forged: claims state=posted instead of approved
        snapshot_after: { state: 'posted', state_version: 2, approved_by: 'office-user' },
      },
    ]
    const result = applyEventLog<RentalBillingWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('snapshot_divergence')
  })

  it('detects a state_version gap', () => {
    const initial: RentalBillingWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
        schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
        entity_id: '00000000-0000-0000-0000-000000000001',
        // skips state_version=1
        state_version: 2,
        event_payload: { type: 'POST_REQUESTED' },
        snapshot_after: { state: 'posting', state_version: 3 },
      },
    ]
    const result = applyEventLog<RentalBillingWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('gap')
  })

  it('treats missing-and-null as equal so reducer-fresh output matches persisted snapshot_after with all null fields', () => {
    // Persisted snapshot_after carries all schema fields populated to
    // null because the API handler spreads the live row before applying
    // the transition. Reducer-fresh output from a minimal initial state
    // omits keys the transition didn't touch. The harness MUST treat
    // these as equivalent or every replay would falsely report
    // snapshot_divergence.
    const initial: RentalBillingWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const approveEvent = { type: 'APPROVE', approved_at: '2026-04-29T10:00:00.000Z', approved_by: 'office-user' }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
        schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
        entity_id: '00000000-0000-0000-0000-000000000001',
        state_version: 1,
        event_payload: approveEvent,
        // What the API handler actually persists: every reducer-snapshot
        // field present, nulls explicit. Reducer-fresh output won't carry
        // posted_at / failed_at / qbo_invoice_id, but they are all null
        // anyway, so the harness must accept this as equivalent.
        snapshot_after: {
          state: 'approved',
          state_version: 2,
          approved_at: '2026-04-29T10:00:00.000Z',
          approved_by: 'office-user',
          posted_at: null,
          failed_at: null,
          error: null,
          qbo_invoice_id: null,
        },
      },
    ]
    const result = applyEventLog<RentalBillingWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('still flags real divergence when a non-null field differs', () => {
    const initial: RentalBillingWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const approveEvent = { type: 'APPROVE', approved_at: '2026-04-29T10:00:00.000Z', approved_by: 'office-user' }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
        schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
        entity_id: '00000000-0000-0000-0000-000000000001',
        state_version: 1,
        event_payload: approveEvent,
        snapshot_after: {
          state: 'approved',
          state_version: 2,
          approved_at: '2026-04-29T10:00:00.000Z',
          approved_by: 'WRONG-USER',
          posted_at: null,
          failed_at: null,
          error: null,
          qbo_invoice_id: null,
        },
      },
    ]
    const result = applyEventLog<RentalBillingWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('snapshot_divergence')
  })

  it('rejects event log written under a different schema_version', () => {
    const initial: RentalBillingWorkflowSnapshot = { state: 'generated', state_version: 1 }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
        schema_version: 999,
        entity_id: '00000000-0000-0000-0000-000000000001',
        state_version: 1,
        event_payload: { type: 'VOID' },
        snapshot_after: { state: 'voided', state_version: 2 },
      },
    ]
    const result = applyEventLog<RentalBillingWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('schema_version_mismatch')
  })
})
