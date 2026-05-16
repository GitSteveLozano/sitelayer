import { describe, it, expect } from 'vitest'
import {
  SCAFFOLD_OPS_APPROVAL_ALL_STATES,
  SCAFFOLD_OPS_APPROVAL_EVENT_TYPES,
  SCAFFOLD_OPS_APPROVAL_TERMINAL_STATES,
  SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME,
  SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION,
  scaffoldOpsApprovalWorkflow,
  isHumanScaffoldOpsApprovalEvent,
  nextScaffoldOpsApprovalEvents,
  parseScaffoldOpsApprovalEventRequest,
  transitionScaffoldOpsApprovalWorkflow,
  type ScaffoldOpsApprovalWorkflowSnapshot,
} from './scaffold-ops-approval.js'

describe('transitionScaffoldOpsApprovalWorkflow', () => {
  it('draft → approved via APPROVE', () => {
    const draft: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const approved = transitionScaffoldOpsApprovalWorkflow(draft, {
      type: 'APPROVE',
      approved_at: '2026-05-01T07:00:00.000Z',
      approved_by: 'office-user',
    })
    expect(approved).toMatchObject({
      state: 'approved',
      state_version: 2,
      approved_at: '2026-05-01T07:00:00.000Z',
      approved_by: 'office-user',
    })
  })

  it('rejects re-approval of approved (terminal)', () => {
    expect(() =>
      transitionScaffoldOpsApprovalWorkflow(
        { state: 'approved', state_version: 2 },
        { type: 'APPROVE', approved_at: 'x', approved_by: 'x' },
      ),
    ).toThrow(/illegal transition/)
  })

  // ─────────────────────────────────────────────────────────────────
  // Expanded coverage parity with damage-charge-settlement /
  // rental-request-approval (≥6 cases per workflow). Added in the
  // 2026-05-16 verification follow-up.
  // ─────────────────────────────────────────────────────────────────

  it('rejects double-approve (approved → approved is illegal)', () => {
    // Anchored on the "operator clicks Approve twice" UX case: the
    // second click must NOT silently re-stamp approved_at/approved_by.
    const firstApprove = transitionScaffoldOpsApprovalWorkflow(
      { state: 'draft', state_version: 1 },
      { type: 'APPROVE', approved_at: '2026-05-01T07:00:00.000Z', approved_by: 'office-user' },
    )
    expect(firstApprove.state).toBe('approved')
    expect(() =>
      transitionScaffoldOpsApprovalWorkflow(firstApprove, {
        type: 'APPROVE',
        approved_at: '2026-05-01T08:00:00.000Z',
        approved_by: 'admin-user',
      }),
    ).toThrow(/illegal transition from approved on APPROVE/)
  })

  it('handles APPROVE on state="draft" with state_version=0 — initial-state contract', () => {
    // Defensive: the reducer treats state_version as a monotonic
    // transition counter. A malformed insert at state_version=0 still
    // produces a valid next snapshot (next = current + 1 = 1).
    // Persistence is responsible for the monotonic invariant.
    const malformedDraft: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'draft', state_version: 0 }
    const result = transitionScaffoldOpsApprovalWorkflow(malformedDraft, {
      type: 'APPROVE',
      approved_at: '2026-05-01T07:00:00.000Z',
      approved_by: 'office-user',
    })
    expect(result.state_version).toBe(1)
    expect(result.state).toBe('approved')
  })

  it('reducer is pure — does not mutate snapshot in place', () => {
    // Single-event workflows are particularly vulnerable to reducers
    // that mutate via Object.assign without spread. Lock this in.
    const draft: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const draftCopy: ScaffoldOpsApprovalWorkflowSnapshot = { ...draft }
    const next = transitionScaffoldOpsApprovalWorkflow(draft, {
      type: 'APPROVE',
      approved_at: '2026-05-01T07:00:00.000Z',
      approved_by: 'office-user',
    })
    expect(draft).toEqual(draftCopy)
    expect(next).not.toBe(draft)
  })

  it('snapshot retains approval fields after transition (audit-trail completeness)', () => {
    const draft: ScaffoldOpsApprovalWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const next = transitionScaffoldOpsApprovalWorkflow(draft, {
      type: 'APPROVE',
      approved_at: '2026-05-01T07:00:00.000Z',
      approved_by: 'office-user',
    })
    // The reducer is the audit-trail source for workflow_event_log; if
    // it ever drops approved_at/approved_by from the next snapshot,
    // replay tooling can't reconstruct the row state. This lock makes
    // that omission a test failure.
    expect(next.approved_at).toBe('2026-05-01T07:00:00.000Z')
    expect(next.approved_by).toBe('office-user')
    expect(next.state).toBe('approved')
    expect(next.state_version).toBe(draft.state_version + 1)
  })

  it('illegal APPROVE on terminal does not mutate input snapshot', () => {
    // Defensive contract: if the reducer ever partially built a new
    // snapshot before throwing, callers could observe garbage state.
    // Lock: throwing is the ONLY observable outcome — no hidden
    // mutation, no field clears.
    const approved: ScaffoldOpsApprovalWorkflowSnapshot = {
      state: 'approved',
      state_version: 2,
      approved_at: '2026-05-01T07:00:00.000Z',
      approved_by: 'office-user',
    }
    const snapshotCopy: ScaffoldOpsApprovalWorkflowSnapshot = { ...approved }
    expect(() =>
      transitionScaffoldOpsApprovalWorkflow(approved, {
        type: 'APPROVE',
        approved_at: '2026-05-01T08:00:00.000Z',
        approved_by: 'admin-user',
      }),
    ).toThrow(/illegal transition/)
    expect(approved).toEqual(snapshotCopy)
  })
})

describe('scaffoldOpsApproval registry + helpers', () => {
  it('exposes reducer + metadata', () => {
    expect(scaffoldOpsApprovalWorkflow.name).toBe('scaffold_ops_approval')
    expect(scaffoldOpsApprovalWorkflow.initialState).toBe('draft')
    expect(scaffoldOpsApprovalWorkflow.terminalStates).toEqual(SCAFFOLD_OPS_APPROVAL_TERMINAL_STATES)
    expect(scaffoldOpsApprovalWorkflow.allStates).toEqual(SCAFFOLD_OPS_APPROVAL_ALL_STATES)
  })

  it('nextEvents on draft returns APPROVE; on approved returns []', () => {
    expect(nextScaffoldOpsApprovalEvents('draft').map((e) => e.type)).toEqual(['APPROVE'])
    expect(nextScaffoldOpsApprovalEvents('approved')).toEqual([])
  })

  it('isHumanEvent partitions correctly', () => {
    expect(isHumanScaffoldOpsApprovalEvent('APPROVE')).toBe(true)
    expect(isHumanScaffoldOpsApprovalEvent('FOO')).toBe(false)
  })

  it('parse well-formed and malformed bodies', () => {
    expect(parseScaffoldOpsApprovalEventRequest({ event: 'APPROVE', state_version: 1 }).ok).toBe(true)
    expect(parseScaffoldOpsApprovalEventRequest({}).ok).toBe(false)
  })

  it('parser rejects unknown event types and coerces stringy state_version', () => {
    // The Zod schema lives in the workflow file; the parser is what
    // the API route layer calls. Lock its full surface: unknown event
    // types are rejected, and stringy state_version (typical JSON
    // body) is coerced before validation.
    expect(parseScaffoldOpsApprovalEventRequest({ event: 'WAIVE', state_version: 1 }).ok).toBe(false)
    const okStringy = parseScaffoldOpsApprovalEventRequest({ event: 'APPROVE', state_version: '3' })
    expect(okStringy.ok).toBe(true)
    if (okStringy.ok) {
      expect(okStringy.value.state_version).toBe(3)
    }
    expect(parseScaffoldOpsApprovalEventRequest({ event: 'APPROVE', state_version: 0 }).ok).toBe(false)
    expect(parseScaffoldOpsApprovalEventRequest({ event: 'APPROVE', state_version: -1 }).ok).toBe(false)
  })

  it('workflow constants match registry metadata', () => {
    // Lock the SCHEMA_VERSION + NAME constants against accidental
    // edits; workflow_event_log rows are keyed on these and replay
    // tooling reads them.
    expect(SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME).toBe('scaffold_ops_approval')
    expect(SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION).toBe(1)
    expect([...SCAFFOLD_OPS_APPROVAL_EVENT_TYPES]).toEqual(['APPROVE'])
    expect(scaffoldOpsApprovalWorkflow.schemaVersion).toBe(SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION)
  })
})
