import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * QBO sync run workflow.
 *
 * Wraps the implicit state machine that previously lived in
 * `integration_connections.status` (apps/api/src/routes/qbo.ts:693,
 * 1021) into a first-class workflow row. The row is created when a
 * human (or periodic worker) hits POST /api/integrations/qbo/sync;
 * the workflow drives it through `syncing → succeeded | failed →
 * retrying` and the API layer derives the `integration_connections.status`
 * flag from the latest run for backwards compatibility.
 *
 * States:
 *   pending    — row created, sync not started yet (rarely seen — the
 *                START_SYNC event usually fires in the same tx)
 *   syncing    — worker is actively pulling/pushing to QBO
 *   succeeded  — terminal-ish success; further syncs create new runs
 *   failed     — non-terminal; RETRY transitions back into retrying
 *   retrying   — a new sync was queued after failure; START_SYNC bumps
 *                back to syncing
 *
 * Events:
 *   START_SYNC      human; pending|retrying → syncing
 *   SYNC_SUCCEEDED  worker-only; syncing → succeeded
 *   SYNC_FAILED     worker-only; syncing → failed
 *   RETRY           human; failed → retrying
 *
 * Note: `failed` is NOT terminal. `succeeded` is terminal in the
 * sense that no further events from this run land — a fresh sync
 * creates a new qbo_sync_runs row.
 *
 * Side effects: `run_qbo_sync` — the route emits this on START_SYNC
 * so the actual sync work can move from the inline route handler to
 * the worker drain in a follow-up. Until that lands, the route
 * continues to do the QBO sync inline and emits SYNC_SUCCEEDED /
 * SYNC_FAILED at the end.
 */

export type QboSyncRunWorkflowState = 'pending' | 'syncing' | 'succeeded' | 'failed' | 'retrying'

export const QBO_SYNC_RUN_WORKFLOW_NAME = 'qbo_sync_run'
export const QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION = 1
export const QBO_SYNC_RUN_ALL_STATES: readonly QboSyncRunWorkflowState[] = [
  'pending',
  'syncing',
  'succeeded',
  'failed',
  'retrying',
]
// `succeeded` is the only true terminal — a new sync creates a new run.
// `failed` is non-terminal because RETRY brings it back.
export const QBO_SYNC_RUN_TERMINAL_STATES: readonly QboSyncRunWorkflowState[] = ['succeeded']
export const QBO_SYNC_RUN_EVENT_TYPES = ['START_SYNC', 'SYNC_SUCCEEDED', 'SYNC_FAILED', 'RETRY'] as const

export type QboSyncRunHumanEventType = 'START_SYNC' | 'RETRY'

export type QboSyncRunWorkflowEvent =
  | { type: 'START_SYNC'; started_at: string; triggered_by?: string | null }
  | { type: 'SYNC_SUCCEEDED'; succeeded_at: string; snapshot?: Record<string, unknown> | null }
  | { type: 'SYNC_FAILED'; failed_at: string; error: string }
  | { type: 'RETRY'; retried_at: string; triggered_by?: string | null }

export interface QboSyncRunWorkflowSnapshot {
  state: QboSyncRunWorkflowState
  state_version: number
  started_at?: string | null
  succeeded_at?: string | null
  failed_at?: string | null
  retried_at?: string | null
  error?: string | null
  snapshot?: Record<string, unknown> | null
  triggered_by?: string | null
}

function assertTransition(
  state: QboSyncRunWorkflowState,
  allowed: readonly QboSyncRunWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`qbo_sync_run: illegal transition from ${state} on ${eventType}`)
  }
}

export function transitionQboSyncRunWorkflow(
  snapshot: QboSyncRunWorkflowSnapshot,
  event: QboSyncRunWorkflowEvent,
): QboSyncRunWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  if (event.type === 'START_SYNC') {
    assertTransition(snapshot.state, ['pending', 'retrying'], event.type)
    return {
      ...snapshot,
      state: 'syncing',
      state_version: nextVersion,
      started_at: event.started_at,
      triggered_by: event.triggered_by ?? snapshot.triggered_by ?? null,
      // Clear prior error on a new sync attempt — the row's `error`
      // should reflect only the latest SYNC_FAILED.
      error: null,
    }
  }
  if (event.type === 'SYNC_SUCCEEDED') {
    assertTransition(snapshot.state, ['syncing'], event.type)
    return {
      ...snapshot,
      state: 'succeeded',
      state_version: nextVersion,
      succeeded_at: event.succeeded_at,
      snapshot: event.snapshot ?? snapshot.snapshot ?? null,
      error: null,
    }
  }
  if (event.type === 'SYNC_FAILED') {
    assertTransition(snapshot.state, ['syncing'], event.type)
    return {
      ...snapshot,
      state: 'failed',
      state_version: nextVersion,
      failed_at: event.failed_at,
      error: event.error,
    }
  }
  if (event.type === 'RETRY') {
    assertTransition(snapshot.state, ['failed'], event.type)
    return {
      ...snapshot,
      state: 'retrying',
      state_version: nextVersion,
      retried_at: event.retried_at,
      triggered_by: event.triggered_by ?? snapshot.triggered_by ?? null,
    }
  }
  const exhaustive: never = event
  throw new Error(`unhandled qbo_sync_run event ${JSON.stringify(exhaustive)}`)
}

export function nextQboSyncRunEvents(
  state: QboSyncRunWorkflowState,
): Array<WorkflowNextEvent<QboSyncRunHumanEventType>> {
  switch (state) {
    case 'pending':
    case 'retrying':
      return [{ type: 'START_SYNC', label: 'Start sync' }]
    case 'failed':
      return [{ type: 'RETRY', label: 'Retry sync' }]
    case 'syncing':
    case 'succeeded':
      return []
  }
}

export function isHumanQboSyncRunEvent(eventType: string): eventType is QboSyncRunHumanEventType {
  return eventType === 'START_SYNC' || eventType === 'RETRY'
}

export const qboSyncRunWorkflow = registerWorkflow<
  QboSyncRunWorkflowState,
  QboSyncRunWorkflowEvent,
  QboSyncRunHumanEventType,
  QboSyncRunWorkflowSnapshot
>({
  name: QBO_SYNC_RUN_WORKFLOW_NAME,
  schemaVersion: QBO_SYNC_RUN_WORKFLOW_SCHEMA_VERSION,
  initialState: 'pending',
  terminalStates: QBO_SYNC_RUN_TERMINAL_STATES,
  allStates: QBO_SYNC_RUN_ALL_STATES,
  allEventTypes: QBO_SYNC_RUN_EVENT_TYPES,
  reduce: transitionQboSyncRunWorkflow,
  nextEvents: nextQboSyncRunEvents,
  isHumanEvent: isHumanQboSyncRunEvent,
  // The eventual side-effect channel for moving the actual sync work
  // out of the route into the worker. The current route handler still
  // performs the sync inline; the outbox row exists so the audit
  // trail captures "this START_SYNC triggered this sync attempt".
  sideEffectTypes: ['run_qbo_sync'] as const,
})

// Human-facing event endpoint — worker-only events are rejected.
export const QboSyncRunEventRequestSchema = z.object({
  event: z.enum(['START_SYNC', 'RETRY']),
  state_version: z.number().int().positive(),
})

export type QboSyncRunEventRequest = z.infer<typeof QboSyncRunEventRequestSchema>
export type QboSyncRunEventParseResult = { ok: true; value: QboSyncRunEventRequest } | { ok: false; error: string }

export function parseQboSyncRunEventRequest(body: unknown): QboSyncRunEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) {
      normalized.state_version = numeric
    }
  }
  const result = QboSyncRunEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
