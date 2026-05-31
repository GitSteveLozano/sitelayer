import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Asset deployment workflow — the "this physical asset is OUT on a job"
 * lifecycle that the rentals cluster was missing.
 *
 * Distinct from `rental` (the contract/billing-ledger row) and `shipment`
 * (the BOM-fulfillment pick/ship flow): an asset_deployment is a single
 * physical asset's out-and-back deployment — dispatched to a project, handed
 * to a worker, due back on a date. A single asset can be dispatched,
 * returned, and re-dispatched many times; each deployment is its own row,
 * anchored to the dispatch `inventory_movements` row.
 *
 *   staged       dispatch created, not yet handed off
 *     DISPATCH         → out  (stamps dispatched_at, project, handoff, est. return)
 *   out          asset is on site
 *     CONFIRM_HANDOFF  → out  (acknowledgement re-stamp; no state change)
 *     MARK_OVERDUE     → overdue  (worker-only; guard now > estimated_return_on)
 *     EXTEND           → out  (new estimated_return_on + reason)
 *     BEGIN_RETURN     → returning
 *     WRITE_OFF        → written_off
 *   overdue      past the estimated return date
 *     EXTEND           → out
 *     BEGIN_RETURN     → returning
 *     WRITE_OFF        → written_off
 *   returning    return started, awaiting condition grading
 *     COMPLETE_RETURN  → returned  (stamps returned_at, returned_by, condition)
 *     WRITE_OFF        → written_off
 *   returned     terminal — asset back at the yard
 *   written_off  terminal — lost / destroyed / not returned
 *
 * Derived (NOT stored — computed in selectors/context): days_out,
 * due_in_days, revenue_to_date_cents.
 *
 * Side effects: `notify_handoff_assignment` — on DISPATCH with a
 * handoff_worker_id, enqueue one outbox row keyed
 * `asset_deployment:notify_handoff:<deployment_id>` (mirrors
 * project_lifecycle's notify_foreman_assignment). One row per deployment;
 * re-dispatch is impossible (deployment is terminal after returned).
 *
 * MARK_OVERDUE is the only worker-driven transition: it exists so OVERDUE
 * is a real state the UI can render (and notifications can fire off) rather
 * than a client-side `now > due` computation.
 */

export type AssetDeploymentWorkflowState = 'staged' | 'out' | 'overdue' | 'returning' | 'returned' | 'written_off'

export const ASSET_DEPLOYMENT_WORKFLOW_NAME = 'asset_deployment'
export const ASSET_DEPLOYMENT_WORKFLOW_SCHEMA_VERSION = 1
export const ASSET_DEPLOYMENT_ALL_STATES: readonly AssetDeploymentWorkflowState[] = [
  'staged',
  'out',
  'overdue',
  'returning',
  'returned',
  'written_off',
]
export const ASSET_DEPLOYMENT_TERMINAL_STATES: readonly AssetDeploymentWorkflowState[] = ['returned', 'written_off']

export const ASSET_DEPLOYMENT_EVENT_TYPES = [
  'DISPATCH',
  'CONFIRM_HANDOFF',
  'MARK_OVERDUE',
  'EXTEND',
  'BEGIN_RETURN',
  'COMPLETE_RETURN',
  'WRITE_OFF',
] as const

export type AssetDeploymentEventType = (typeof ASSET_DEPLOYMENT_EVENT_TYPES)[number]
export type AssetDeploymentHumanEventType = Exclude<AssetDeploymentEventType, 'MARK_OVERDUE'>

export type AssetDeploymentWorkflowEvent =
  | {
      type: 'DISPATCH'
      dispatched_at: string
      project_id?: string | null
      from_location_id?: string | null
      handoff_worker_id?: string | null
      estimated_return_on?: string | null
      day_rate_cents?: number | null
      bill_mode?: string | null
    }
  | { type: 'CONFIRM_HANDOFF'; handoff_confirmed_at: string; handoff_confirmed_by: string }
  | { type: 'MARK_OVERDUE'; overdue_since: string }
  | { type: 'EXTEND'; estimated_return_on: string; extension_reason?: string | null }
  | { type: 'BEGIN_RETURN'; return_started_at: string }
  | { type: 'COMPLETE_RETURN'; returned_at: string; returned_by: string; condition_grade?: string | null }
  | { type: 'WRITE_OFF'; written_off_at: string; written_off_by: string; write_off_reason?: string | null }

export interface AssetDeploymentWorkflowSnapshot {
  state: AssetDeploymentWorkflowState
  state_version: number
  inventory_item_id?: string | null
  inventory_movement_id?: string | null
  project_id?: string | null
  from_location_id?: string | null
  handoff_worker_id?: string | null
  handoff_confirmed_at?: string | null
  handoff_confirmed_by?: string | null
  dispatched_at?: string | null
  estimated_return_on?: string | null
  overdue_since?: string | null
  return_started_at?: string | null
  returned_at?: string | null
  returned_by?: string | null
  condition_grade?: string | null
  day_rate_cents?: number | null
  bill_mode?: string | null
  extension_reason?: string | null
  write_off_reason?: string | null
}

function assertTransition(
  state: AssetDeploymentWorkflowState,
  allowed: readonly AssetDeploymentWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`asset_deployment: illegal transition from ${state} on ${eventType}`)
  }
}

export function transitionAssetDeploymentWorkflow(
  snapshot: AssetDeploymentWorkflowSnapshot,
  event: AssetDeploymentWorkflowEvent,
): AssetDeploymentWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  switch (event.type) {
    case 'DISPATCH':
      assertTransition(snapshot.state, ['staged'], event.type)
      return {
        ...snapshot,
        state: 'out',
        state_version: nextVersion,
        dispatched_at: event.dispatched_at,
        project_id: event.project_id ?? snapshot.project_id ?? null,
        from_location_id: event.from_location_id ?? snapshot.from_location_id ?? null,
        handoff_worker_id: event.handoff_worker_id ?? snapshot.handoff_worker_id ?? null,
        estimated_return_on: event.estimated_return_on ?? snapshot.estimated_return_on ?? null,
        day_rate_cents: event.day_rate_cents ?? snapshot.day_rate_cents ?? null,
        bill_mode: event.bill_mode ?? snapshot.bill_mode ?? null,
      }
    case 'CONFIRM_HANDOFF':
      // Acknowledgement re-stamp — stays `out`, no lifecycle move.
      assertTransition(snapshot.state, ['out'], event.type)
      return {
        ...snapshot,
        state: 'out',
        state_version: nextVersion,
        handoff_confirmed_at: event.handoff_confirmed_at,
        handoff_confirmed_by: event.handoff_confirmed_by,
      }
    case 'MARK_OVERDUE':
      assertTransition(snapshot.state, ['out'], event.type)
      return { ...snapshot, state: 'overdue', state_version: nextVersion, overdue_since: event.overdue_since }
    case 'EXTEND':
      assertTransition(snapshot.state, ['out', 'overdue'], event.type)
      return {
        ...snapshot,
        // Extending an overdue deployment brings it back to `out`.
        state: 'out',
        state_version: nextVersion,
        estimated_return_on: event.estimated_return_on,
        overdue_since: null,
        extension_reason: event.extension_reason ?? null,
      }
    case 'BEGIN_RETURN':
      assertTransition(snapshot.state, ['out', 'overdue'], event.type)
      return {
        ...snapshot,
        state: 'returning',
        state_version: nextVersion,
        return_started_at: event.return_started_at,
      }
    case 'COMPLETE_RETURN':
      assertTransition(snapshot.state, ['returning', 'out', 'overdue'], event.type)
      return {
        ...snapshot,
        state: 'returned',
        state_version: nextVersion,
        returned_at: event.returned_at,
        returned_by: event.returned_by,
        condition_grade: event.condition_grade ?? snapshot.condition_grade ?? null,
      }
    case 'WRITE_OFF':
      assertTransition(snapshot.state, ['out', 'overdue', 'returning'], event.type)
      return {
        ...snapshot,
        state: 'written_off',
        state_version: nextVersion,
        write_off_reason: event.write_off_reason ?? null,
      }
  }
}

export function nextAssetDeploymentEvents(
  state: AssetDeploymentWorkflowState,
): Array<WorkflowNextEvent<AssetDeploymentHumanEventType>> {
  switch (state) {
    case 'staged':
      return [{ type: 'DISPATCH', label: 'Dispatch asset' }]
    case 'out':
      return [
        { type: 'CONFIRM_HANDOFF', label: 'Confirm handoff' },
        { type: 'EXTEND', label: 'Extend return' },
        { type: 'BEGIN_RETURN', label: 'Start return' },
        { type: 'WRITE_OFF', label: 'Write off' },
      ]
    case 'overdue':
      return [
        { type: 'EXTEND', label: 'Extend return' },
        { type: 'BEGIN_RETURN', label: 'Start return' },
        { type: 'WRITE_OFF', label: 'Write off' },
      ]
    case 'returning':
      return [
        { type: 'COMPLETE_RETURN', label: 'Complete return' },
        { type: 'WRITE_OFF', label: 'Write off' },
      ]
    case 'returned':
    case 'written_off':
      return []
  }
}

export function isHumanAssetDeploymentEvent(eventType: string): eventType is AssetDeploymentHumanEventType {
  return (
    (ASSET_DEPLOYMENT_EVENT_TYPES as readonly string[]).includes(eventType) && eventType !== 'MARK_OVERDUE'
  )
}

export const assetDeploymentWorkflow = registerWorkflow<
  AssetDeploymentWorkflowState,
  AssetDeploymentWorkflowEvent,
  AssetDeploymentHumanEventType,
  AssetDeploymentWorkflowSnapshot
>({
  name: ASSET_DEPLOYMENT_WORKFLOW_NAME,
  schemaVersion: ASSET_DEPLOYMENT_WORKFLOW_SCHEMA_VERSION,
  initialState: 'staged',
  terminalStates: ASSET_DEPLOYMENT_TERMINAL_STATES,
  allStates: ASSET_DEPLOYMENT_ALL_STATES,
  allEventTypes: ASSET_DEPLOYMENT_EVENT_TYPES,
  reduce: transitionAssetDeploymentWorkflow,
  nextEvents: nextAssetDeploymentEvents,
  isHumanEvent: isHumanAssetDeploymentEvent,
  // DISPATCH with a handoff_worker_id enqueues a notify_handoff_assignment
  // outbox row (one per deployment) so the foreman/worker is told the
  // asset is theirs. Mirrors project_lifecycle's notify_foreman_assignment.
  sideEffectTypes: ['notify_handoff_assignment'] as const,
})

// Human-dispatchable events only — MARK_OVERDUE is worker-only and rejected
// at the human event endpoint (a daily sweep dispatches it via the
// worker-event path).
const ASSET_DEPLOYMENT_HUMAN_EVENT_TYPES = ASSET_DEPLOYMENT_EVENT_TYPES.filter(
  (t): t is AssetDeploymentHumanEventType => t !== 'MARK_OVERDUE',
)

export const AssetDeploymentEventRequestSchema = z.object({
  event: z.enum(ASSET_DEPLOYMENT_HUMAN_EVENT_TYPES as [AssetDeploymentHumanEventType, ...AssetDeploymentHumanEventType[]]),
  state_version: z.number().int().positive(),
  estimated_return_on: z.string().optional().nullable(),
  extension_reason: z.string().max(2000).optional().nullable(),
  condition_grade: z.string().max(64).optional().nullable(),
  write_off_reason: z.string().max(2000).optional().nullable(),
})

export type AssetDeploymentEventRequest = z.infer<typeof AssetDeploymentEventRequestSchema>
export type AssetDeploymentEventParseResult =
  | { ok: true; value: AssetDeploymentEventRequest }
  | { ok: false; error: string }

export function parseAssetDeploymentEventRequest(body: unknown): AssetDeploymentEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) normalized.state_version = numeric
  }
  const result = AssetDeploymentEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
