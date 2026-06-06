/**
 * projectkit Concern / WorkRequest / Callback snapshots — ADDITIVE seam.
 *
 * Advances the operator's One-Line Boundary Test (swap mesh for another
 * dispatch adapter without changing the Concern / Dispatch / Callback shapes)
 * via the additive-snapshot approach from
 * control-plane-suite/docs/publishable-control-plane-architecture-2026-06-02.md
 * Phase 2. NO behavior change: it derives portable, adapter-agnostic snapshots
 * of an existing `context_work_item` shaped as the FIRST-CLASS
 * @operator/projectkit contract types (`Concern`, `WorkRequest`) and validates
 * them against the published `validateConcern` / `validateWorkRequest`
 * validators (the contract's Go-side mirror is schemas/concern.schema.json +
 * schemas/work-request.schema.json).
 *
 * THE INVARIANT (mirrors @operator/projectkit): a testbed depends on THIS
 * contract; mesh is ONE swappable subscriber/adapter behind a URL. These
 * builders import ONLY the projectkit types + validators — nothing
 * control-plane/mesh — so the snapshots a different DispatchAdapter would
 * consume are produced from the same published shapes.
 *
 * Pure + dependency-light: the status mapping + snapshot builders take plain
 * data; no DB, no http, no env reads — so they are trivially unit-testable and
 * the conformance test validates the output against the real contract.
 */
import {
  CONTRACT_VERSION,
  validateConcern,
  validateWorkRequest,
  type Callback,
  type CallbackStatus,
  type Concern,
  type ConcernPriority,
  type WorkRequest,
} from '@operator/projectkit'
import type { WorkItemSeverity, WorkItemStatus } from './context-handoff.js'

const DEFAULT_PROJECT_KEY = 'sitelayer'

/**
 * Map an internal work-item status to the projectkit `Callback` status.
 *
 * Pure, total, and stable — this is the load-bearing translation the boundary
 * test exercises (the Callback shape must not change when the dispatch adapter
 * changes). Required mapping (per the seam contract):
 *   new, triaged   -> accepted
 *   agent_running  -> running
 *   review_ready   -> running
 *   resolved       -> succeeded
 *   wont_do        -> failed
 *   reversed       -> cancelled
 *
 * The remaining internal statuses (human_assigned, review_stale,
 * proposal_expired, reopened) have no first-class Callback meaning at the seam
 * yet; they collapse to the closest published `CallbackStatus` so the helper
 * stays total without inventing new vocabulary. `null` is reserved for
 * genuinely unknown input so a caller can omit the Callback status entirely.
 */
export function workItemStatusToCallbackStatus(
  status: WorkItemStatus | string | null | undefined,
): CallbackStatus | null {
  switch (status) {
    case 'new':
    case 'triaged':
      return 'accepted'
    case 'agent_running':
    case 'review_ready':
      return 'running'
    case 'resolved':
      return 'succeeded'
    case 'wont_do':
      return 'failed'
    case 'reversed':
      return 'cancelled'
    // Closest-published collapses for the internal-only statuses so the helper
    // is total. These are NOT part of the seam's required mapping table.
    case 'human_assigned':
    case 'reopened':
      return 'accepted'
    case 'review_stale':
    case 'proposal_expired':
      return 'running'
    default:
      return null
  }
}

/**
 * Map internal severity -> projectkit `Concern`/`WorkRequest` priority.
 * Sitelayer's severities already line up 1:1 with the published priority
 * vocabulary; the helper exists so a future divergence has a single edit site
 * and so a null/unknown severity resolves to the published default (`normal`).
 */
export function severityToPriority(severity: WorkItemSeverity | string | null | undefined): ConcernPriority {
  switch (severity) {
    case 'low':
    case 'normal':
    case 'high':
    case 'urgent':
      return severity
    default:
      return 'normal'
  }
}

/** A subscriber-agnostic evidence pointer (no raw content travels here). */
export type ConcernEvidenceRef = { type: string; id: string }

/**
 * The adapter-agnostic callback target a Concern dispatches with. Mirrors
 * projectkit's `ConcernCallback` ({ url?, mode? }) — the scoped-bearer token
 * is intentionally NOT carried here (it is delivered separately via the
 * existing dispatch payload's `callback.token`); this snapshot is the safe,
 * token-free shape.
 */
export type ConcernCallbackTarget = { url?: string; mode?: string }

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export const CONCERN_KIND_DEFAULT = 'execute' as const

export interface BuildConcernInput {
  workItemId: string
  title: string
  summary?: string | null
  severity?: WorkItemSeverity | string | null
  status?: WorkItemStatus | string | null
  route?: string | null
  entityType?: string | null
  entityId?: string | null
  captureSessionId?: string | null
  supportPacketId?: string | null
  /** The originating event ref (defaults to the support-debug-packet id). */
  sourceEventRef?: string | null
  evidenceRefs?: ConcernEvidenceRef[]
  /** Dispatch kind: 'execute' for an implementation lane, 'review' for triage. */
  kind?: string | null
  callback?: ConcernCallbackTarget | null
  projectKey?: string
  /** ISO-8601; defaults to now(). */
  dispatchedAt?: string
}

/**
 * Build the projectkit `Concern` for a context_work_item. Pure (no DB; no clock
 * unless `dispatchedAt` is omitted). Maps:
 *   concern_ref      <- workItemId
 *   title/summary    <- title/summary
 *   priority         <- severity (via severityToPriority)
 *   source_event_ref <- sourceEventRef (defaults to support packet id)
 *   callback         <- { url, mode } target (when dispatched)
 * The work-item status (-> Callback status) + route/entity/evidence travel in
 * the Concern's `inputs` map for a subscriber that wants them.
 */
export function buildConcernSnapshot(input: BuildConcernInput): Concern {
  const title = cleanText(input.title) ?? `Sitelayer concern ${input.workItemId.slice(0, 8)}`
  const summary = cleanText(input.summary)
  const priority = severityToPriority(input.severity)
  const callbackStatus = workItemStatusToCallbackStatus(input.status)
  const sourceEventRef = cleanText(input.sourceEventRef) ?? cleanText(input.supportPacketId)
  const evidenceRefs =
    input.evidenceRefs && input.evidenceRefs.length > 0
      ? input.evidenceRefs
      : [
          ...(cleanText(input.supportPacketId)
            ? [{ type: 'support_debug_packet', id: cleanText(input.supportPacketId)! }]
            : []),
          ...(cleanText(input.captureSessionId)
            ? [{ type: 'capture_session', id: cleanText(input.captureSessionId)! }]
            : []),
        ]

  const concern: Concern = {
    schema_version: CONTRACT_VERSION,
    project_key: cleanText(input.projectKey) ?? DEFAULT_PROJECT_KEY,
    dispatched_at: input.dispatchedAt ?? new Date().toISOString(),
    concern_ref: input.workItemId,
    kind: cleanText(input.kind) ?? CONCERN_KIND_DEFAULT,
    title,
    priority,
    inputs: {
      work_item_status: input.status ?? null,
      callback_status: callbackStatus,
      route: cleanText(input.route),
      entity_type: cleanText(input.entityType),
      entity_id: cleanText(input.entityId),
      capture_session_id: cleanText(input.captureSessionId),
      support_packet_id: cleanText(input.supportPacketId),
      evidence_refs: evidenceRefs,
    },
  }
  if (summary) concern.summary = summary
  if (sourceEventRef) concern.source_event_ref = sourceEventRef
  if (input.callback) {
    const target: ConcernCallbackTarget = {}
    if (cleanText(input.callback.url)) target.url = cleanText(input.callback.url)!
    if (cleanText(input.callback.mode)) target.mode = cleanText(input.callback.mode)!
    concern.callback = target
  }
  return concern
}

/** Well-known intents map per the WorkIntent contract; default to capture-followup. */
export const WORK_REQUEST_INTENT_DEFAULT = 'capture-followup' as const

export interface BuildWorkRequestInput extends BuildConcernInput {
  /** projectkit WorkIntent (fix/investigate/replicate/review/research/capture-followup/...). */
  intent?: string | null
  /** Sitelayer lane that produced this request (triage/human/agent/both). */
  lane?: string | null
  /** Acceptance criteria for the requested work. */
  acceptance?: string[]
}

/**
 * Build the projectkit `WorkRequest` — the emit-direction "I am asking for
 * work" view. request_ref = work_item_id (stable idempotency handle). Carries
 * the same priority/route/entity/source as the Concern; `payload` embeds the
 * Concern snapshot so one object exposes both shapes for a subscriber that
 * only reads the `dispatch_request` key.
 */
export function buildWorkRequestSnapshot(input: BuildWorkRequestInput): WorkRequest {
  const concern = buildConcernSnapshot(input)
  const summary = cleanText(input.summary)
  const sourceEventRef = cleanText(input.sourceEventRef) ?? cleanText(input.supportPacketId)
  const request: WorkRequest = {
    schema_version: CONTRACT_VERSION,
    project_key: cleanText(input.projectKey) ?? DEFAULT_PROJECT_KEY,
    requested_at: concern.dispatched_at,
    request_ref: input.workItemId,
    intent: cleanText(input.intent) ?? WORK_REQUEST_INTENT_DEFAULT,
    title: concern.title,
    priority: severityToPriority(input.severity),
    payload: {
      lane: cleanText(input.lane),
      // Embed the full Concern so one snapshot carries both shapes.
      concern,
    },
  }
  if (summary) request.summary = summary
  if (cleanText(input.route)) request.route_path = cleanText(input.route)!
  if (cleanText(input.entityType)) request.entity_kind = cleanText(input.entityType)!
  if (cleanText(input.entityId)) request.entity_id = cleanText(input.entityId)!
  if (sourceEventRef) request.source_event_ref = sourceEventRef
  if (input.acceptance && input.acceptance.length > 0) request.acceptance = input.acceptance
  return request
}

/**
 * Build a projectkit `Callback` for a work item's current status — the
 * return-leg shape an adapter (or a future Sitelayer callback handler) speaks.
 * concern_ref = work_item_id. Returns null when the status has no published
 * Callback meaning (so a caller can skip emitting a malformed Callback).
 */
export function buildCallbackSnapshot(input: {
  workItemId: string
  status: WorkItemStatus | string | null | undefined
  outputs?: Record<string, unknown>
  error?: string | null
  completedAt?: string | null
}): Callback | null {
  const status = workItemStatusToCallbackStatus(input.status)
  if (!status) return null
  const callback: Callback = {
    schema_version: CONTRACT_VERSION,
    concern_ref: input.workItemId,
    status,
  }
  if (input.outputs && Object.keys(input.outputs).length > 0) callback.outputs = input.outputs
  if (cleanText(input.error)) callback.error = cleanText(input.error)!
  if (cleanText(input.completedAt)) callback.completed_at = cleanText(input.completedAt)!
  return callback
}

/** Conformance re-exports: validate against the published projectkit contract. */
export function validateConcernSnapshot(snapshot: unknown): string[] {
  return validateConcern(snapshot)
}

export function validateWorkRequestSnapshot(snapshot: unknown): string[] {
  return validateWorkRequest(snapshot)
}
