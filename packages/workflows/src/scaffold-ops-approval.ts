import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Scaffold ops (BOM) approval workflow.
 *
 * Lifts the implicit state machine in `boms.status` into a registered
 * deterministic workflow with a full audit trail. The persistence layer
 * (`docker/postgres/init/058_scaffold_catalog_and_bom.sql`) and the web
 * client (`apps/web/src/lib/api/scaffold-ops.ts`) both model three states
 * — `draft | approved | superseded` — so `superseded` is a REAL persisted
 * state and is modeled here as a reducer state, not a side-channel
 * status write. (There is deliberately no `rejected`/`pending` state: a
 * BOM is never rejected — a revision supersedes it.)
 *
 * States: draft → approved → superseded (a draft can also be superseded
 * directly when a newer BOM replaces it before approval).
 *
 * Events:
 *   APPROVE   { approved_at, approved_by }                    draft → approved
 *   SUPERSEDE { superseded_at, superseded_by,                 draft|approved → superseded
 *               superseded_by_bom_id? }
 *
 * `superseded` is the only terminal state — `approved` is non-terminal
 * because a later revision can supersede it. The `superseded_by` FK link
 * on the row is set in the same tx as the SUPERSEDE update; the reducer
 * carries the link id on the event/snapshot for the audit log.
 *
 * Side effects: none.
 */

export type ScaffoldOpsApprovalWorkflowState = 'draft' | 'approved' | 'superseded'

export const SCAFFOLD_OPS_APPROVAL_WORKFLOW_NAME = 'scaffold_ops_approval'
export const SCAFFOLD_OPS_APPROVAL_WORKFLOW_SCHEMA_VERSION = 1
export const SCAFFOLD_OPS_APPROVAL_ALL_STATES: readonly ScaffoldOpsApprovalWorkflowState[] = [
  'draft',
  'approved',
  'superseded',
]
export const SCAFFOLD_OPS_APPROVAL_TERMINAL_STATES: readonly ScaffoldOpsApprovalWorkflowState[] = ['superseded']
export const SCAFFOLD_OPS_APPROVAL_EVENT_TYPES = ['APPROVE', 'SUPERSEDE'] as const

export type ScaffoldOpsApprovalHumanEventType = (typeof SCAFFOLD_OPS_APPROVAL_EVENT_TYPES)[number]

export type ScaffoldOpsApprovalWorkflowEvent =
  | { type: 'APPROVE'; approved_at: string; approved_by: string }
  | {
      type: 'SUPERSEDE'
      superseded_at: string
      superseded_by: string
      superseded_by_bom_id?: string | null
    }

export interface ScaffoldOpsApprovalWorkflowSnapshot {
  state: ScaffoldOpsApprovalWorkflowState
  state_version: number
  approved_at?: string | null
  approved_by?: string | null
  superseded_at?: string | null
  superseded_by?: string | null
  superseded_by_bom_id?: string | null
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
  if (event.type === 'SUPERSEDE') {
    // A newer BOM replaces this one. Allowed from `draft` (the revision
    // landed before approval) or `approved` (a post-approval revision).
    assertTransition(snapshot.state, ['draft', 'approved'], event.type)
    return {
      ...snapshot,
      state: 'superseded',
      state_version: snapshot.state_version + 1,
      superseded_at: event.superseded_at,
      superseded_by: event.superseded_by,
      superseded_by_bom_id: event.superseded_by_bom_id ?? null,
    }
  }
  const exhaustive: never = event
  throw new Error(`unhandled scaffold_ops_approval event ${JSON.stringify(exhaustive)}`)
}

export function nextScaffoldOpsApprovalEvents(
  state: ScaffoldOpsApprovalWorkflowState,
): Array<WorkflowNextEvent<ScaffoldOpsApprovalHumanEventType>> {
  switch (state) {
    case 'draft':
      return [
        { type: 'APPROVE', label: 'Approve BOM' },
        { type: 'SUPERSEDE', label: 'Supersede BOM' },
      ]
    case 'approved':
      return [{ type: 'SUPERSEDE', label: 'Supersede BOM' }]
    case 'superseded':
      return []
  }
}

export function isHumanScaffoldOpsApprovalEvent(eventType: string): eventType is ScaffoldOpsApprovalHumanEventType {
  return eventType === 'APPROVE' || eventType === 'SUPERSEDE'
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

const ApproveBodySchema = z.object({
  event: z.literal('APPROVE'),
  state_version: z.number().int().positive(),
})

const SupersedeBodySchema = z.object({
  event: z.literal('SUPERSEDE'),
  state_version: z.number().int().positive(),
  superseded_by_bom_id: z.string().min(1).nullish(),
})

export const ScaffoldOpsApprovalEventRequestSchema = z.discriminatedUnion('event', [
  ApproveBodySchema,
  SupersedeBodySchema,
])

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
