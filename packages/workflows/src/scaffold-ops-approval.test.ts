import { describe, it, expect } from 'vitest'
import {
  SCAFFOLD_OPS_APPROVAL_ALL_STATES,
  SCAFFOLD_OPS_APPROVAL_TERMINAL_STATES,
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
})
