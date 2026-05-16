import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Scaffold ops (BOM) approval workflow.
 *
 * Single-event workflow that lifts the implicit state machine in
 * `boms.status` (draft → approved) into a registered deterministic
 * workflow purely for the audit trail. The reducer enforces
 * draft → approved as the only allowed transition; supersession is
 * still managed via the `superseded_by` foreign key + a manual
 * status write (out of scope for this workflow).
 *
 * States: draft → approved.
 *
 * Events:
 *   APPROVE  { approved_at, approved_by }
 *
 * Side effects: none.
 */

export type ScaffoldOpsApprovalWorkflowState = 'draft' | 'approved'

export const SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME = 'scaffold_ops_approval'
export const SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION = 1
export const SCAFFOLD_OPS_APPROVAL_ALL_STATES: readonly ScaffoldOpsApprovalWorkflowState[] = ['draft', 'approved']
export const SCAFFOLD_OPS_APPROVAL_TERMINAL_STATES: readonly ScaffoldOpsApprovalWorkflowState[] = ['approved']
export const SCAFFOLD_OPS_APPROVAL_EVENT_TYPES = ['APPROVE'] as const

export type ScaffoldOpsApprovalHumanEventType = (typeof SCAFFOLD_OPS_APPROVAL_EVENT_TYPES)[number]

export type ScaffoldOpsApprovalWorkflowEvent = { type: 'APPROVE'; approved_at: string; approved_by: string }

export interface ScaffoldOpsApprovalWorkflowSnapshot {
  state: ScaffoldOpsApprovalWorkflowState
  state_version: number
  approved_at?: string | null
  approved_by?: string | null
}

function assertTransition(
  state: ScaffoldOpsApprovalWorkflowState,
  allowed: readonly ScaffoldOpsApprovalWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`scaffold_ops_approval: illegal transition from ${state} on ${eventType}`)
  }
}

export function transitionScaffoldOpsApprovalWorkflow(
  snapshot: ScaffoldOpsApprovalWorkflowSnapshot,
  event: ScaffoldOpsApprovalWorkflowEvent,
): ScaffoldOpsApprovalWorkflowSnapshot {
  if (event.type === 'APPROVE') {
    assertTransition(snapshot.state, ['draft'], event.type)
    return {
      ...snapshot,
      state: 'approved',
      state_version: snapshot.state_version + 1,
      approved_at: event.approved_at,
      approved_by: event.approved_by,
    }
  }
  const exhaustive: never = event.type
  throw new Error(`unhandled scaffold_ops_approval event ${exhaustive}`)
}

export function nextScaffoldOpsApprovalEvents(
  state: ScaffoldOpsApprovalWorkflowState,
): Array<WorkflowNextEvent<ScaffoldOpsApprovalHumanEventType>> {
  switch (state) {
    case 'draft':
      return [{ type: 'APPROVE', label: 'Approve BOM' }]
    case 'approved':
      return []
  }
}

export function isHumanScaffoldOpsApprovalEvent(eventType: string): eventType is ScaffoldOpsApprovalHumanEventType {
  return eventType === 'APPROVE'
}

export const scaffoldOpsApprovalWorkflow = registerWorkflow<
  ScaffoldOpsApprovalWorkflowState,
  ScaffoldOpsApprovalWorkflowEvent,
  ScaffoldOpsApprovalHumanEventType,
  ScaffoldOpsApprovalWorkflowSnapshot
>({
  name: SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME,
  schemaVersion: SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION,
  initialState: 'draft',
  terminalStates: SCAFFOLD_OPS_APPROVAL_TERMINAL_STATES,
  allStates: SCAFFOLD_OPS_APPROVAL_ALL_STATES,
  allEventTypes: SCAFFOLD_OPS_APPROVAL_EVENT_TYPES,
  reduce: transitionScaffoldOpsApprovalWorkflow,
  nextEvents: nextScaffoldOpsApprovalEvents,
  isHumanEvent: isHumanScaffoldOpsApprovalEvent,
  sideEffectTypes: [] as const,
})

export const ScaffoldOpsApprovalEventRequestSchema = z.object({
  event: z.enum(SCAFFOLD_OPS_APPROVAL_EVENT_TYPES),
  state_version: z.number().int().positive(),
})

export type ScaffoldOpsApprovalEventRequest = z.infer<typeof ScaffoldOpsApprovalEventRequestSchema>
export type ScaffoldOpsApprovalEventParseResult =
  | { ok: true; value: ScaffoldOpsApprovalEventRequest }
  | { ok: false; error: string }

export function parseScaffoldOpsApprovalEventRequest(body: unknown): ScaffoldOpsApprovalEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = ScaffoldOpsApprovalEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
