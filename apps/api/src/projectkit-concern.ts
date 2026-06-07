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
  validateCallback,
  validateConcern,
  validateWorkRequest,
  // The two boundary-translation helpers are now OWNED by the published
  // @operator/projectkit "worklifecycle" core (worklifecycle.d.ts names this
  // module "the canonical home of sitelayer's workItemStatusToCallbackStatus").
  // Imported under aliases and re-exported below under the existing local names
  // so every importer of './projectkit-concern.js' is unchanged. Non-behavioral:
  // the published implementations are byte-for-byte equivalent to the locals they
  // replace (verified against
  // node_modules/@operator/projectkit/dist/worklifecycle.js).
  workItemStatusToCallbackStatus as pkWorkItemStatusToCallbackStatus,
  severityToPriority as pkSeverityToPriority,
  type Callback,
  type CallbackArtifact,
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
 * RE-POINTED to the published @operator/projectkit `workItemStatusToCallbackStatus`
 * (the canonical home for this seam translation). Behaviorally identical to the
 * former local switch — the load-bearing translation the boundary test exercises
 * (the Callback shape must not change when the dispatch adapter changes):
 *   new, triaged, human_assigned, reopened          -> accepted
 *   agent_running, review_ready, review_stale,
 *     proposal_expired                              -> running
 *   resolved                                        -> succeeded
 *   wont_do                                         -> failed
 *   reversed                                        -> cancelled
 *   anything else                                   -> null
 *
 * Thin local wrapper that pins the published `CallbackStatus | null` return so
 * the exported signature is unchanged.
 */
export function workItemStatusToCallbackStatus(
  status: WorkItemStatus | string | null | undefined,
): CallbackStatus | null {
  return pkWorkItemStatusToCallbackStatus(status)
}

/**
 * Map internal severity -> projectkit `Concern`/`WorkRequest` priority.
 *
 * RE-POINTED to the published @operator/projectkit `severityToPriority`.
 * Sitelayer's severities line up 1:1 with the published priority vocabulary, so
 * this is non-behavioral. The published return type (`WorkPriority`, which
 * widens to `string`) is narrowed back to the local `ConcernPriority` here so
 * the exported signature is unchanged (the runtime values are only ever the four
 * canonical priorities or the `normal` default).
 */
export function severityToPriority(severity: WorkItemSeverity | string | null | undefined): ConcernPriority {
  return pkSeverityToPriority(severity) as ConcernPriority
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
 * The published `CallbackStatus` values that mean the unit of work has reached
 * a terminal state — i.e. the executor is done. `completed_at` is meaningful
 * only for these (the seam derives a default terminal timestamp on them when an
 * inbound callback omits one).
 */
export const TERMINAL_CALLBACK_STATUSES: readonly CallbackStatus[] = ['succeeded', 'failed', 'cancelled']

/** True when the published Callback status is a terminal (work-finished) state. */
export function isTerminalCallbackStatus(status: CallbackStatus | null | undefined): boolean {
  return status != null && TERMINAL_CALLBACK_STATUSES.includes(status)
}

/**
 * Normalize a free-form inbound `artifacts` value into the published
 * `CallbackArtifact[]` shape ({ kind, ref }). The inbound agent-callback
 * `artifacts` field is `z.unknown()`, so it may be an array of loosely-typed
 * objects (e.g. { kind, ref, url, label, ... }) — this keeps only entries that
 * carry both a non-empty `kind` and a usable pointer (`ref` | `url` | `id`),
 * dropping anything malformed so the snapshot stays contract-valid. Returns an
 * empty array (never throws) for non-array / empty / all-malformed input.
 */
export function normalizeCallbackArtifacts(value: unknown): CallbackArtifact[] {
  if (!Array.isArray(value)) return []
  const out: CallbackArtifact[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const kind = cleanText(record.kind)
    // Accept the published `ref`, or fall back to a `url` / `id` pointer so an
    // adapter that only stamped one of those still maps cleanly.
    const ref = cleanText(record.ref) ?? cleanText(record.url) ?? cleanText(record.id)
    if (!kind || !ref) continue
    out.push({ kind, ref })
  }
  return out
}

/**
 * Build a projectkit `Callback` for a work item's current status — the
 * return-leg shape an adapter (or a future Sitelayer callback handler) speaks.
 * concern_ref = work_item_id. Returns null when the status has no published
 * Callback meaning (so a caller can skip emitting a malformed Callback).
 *
 * TOKEN SAFETY: the published Callback snapshot carries NO scoped-bearer
 * callback token — only the contract fields. Callers must NOT pass the bearer
 * token through `outputs` (it travels separately on the dispatch payload).
 */
export function buildCallbackSnapshot(input: {
  workItemId: string
  status: WorkItemStatus | string | null | undefined
  outputs?: Record<string, unknown>
  /** Free-form inbound artifacts; normalized to the published { kind, ref } shape. */
  artifacts?: unknown
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
  const artifacts = normalizeCallbackArtifacts(input.artifacts)
  if (artifacts.length > 0) callback.artifacts = artifacts
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

export function validateCallbackSnapshot(snapshot: unknown): string[] {
  return validateCallback(snapshot)
}
