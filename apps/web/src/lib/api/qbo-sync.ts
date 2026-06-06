// QBO sync monitor — sync queue status + recent ledger reads.
//
// Wraps the read surfaces in apps/api/src/routes/sync.ts:
//   - GET /api/sync/status — connection rows, queue depths, latest sync_event
//   - GET /api/sync/outbox — recent mutation_outbox rows
//   - GET /api/sync/events — recent sync_events rows
//
// The trigger (POST /api/integrations/qbo/sync) and the connection
// read (GET /api/integrations/qbo) live in qbo.ts; this module is the
// dedicated monitor surface so the QBO connection screen can show
// last-sync state + pending/failed counts without re-deriving them
// from the connection payload (whose `status` block is shaped
// differently from /api/sync/status).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QboSyncRunHumanEventType, QboSyncRunWorkflowState } from '@sitelayer/workflows'
import { request } from './client'

// Canonical state/event unions live in @sitelayer/workflows so the
// reducer, the API route, and this client never drift.
export type QboSyncRunState = QboSyncRunWorkflowState
export type QboSyncRunHumanEvent = QboSyncRunHumanEventType

/** Lifecycle status carried on a single sync_events / mutation_outbox row. */
export type QboSyncRowStatus = 'pending' | 'processing' | 'applied' | 'failed' | string

/**
 * The most recent sync_events row, surfaced by /api/sync/status. The
 * QBO sync attempt wraps itself in a qbo_sync_runs workflow row
 * (pending → syncing → succeeded | failed); there is no dedicated GET
 * for that workflow yet, so this latest-event row + the connection's
 * own `status` flag are the read signal the monitor renders.
 */
export interface QboLatestSyncEvent {
  created_at: string
  entity_type: string
  entity_id: string
  direction: string
  status: QboSyncRowStatus
  attempt_count: number
  applied_at: string | null
  error: string | null
}

export interface QboSyncStatusConnection {
  id: string
  provider: string
  provider_account_id: string | null
  sync_cursor: string | null
  last_synced_at: string | null
  status: string
  version: number
  created_at: string
}

/** Shape of GET /api/sync/status (see apps/api/src/routes/sync.ts:getSyncStatus). */
export interface QboSyncStatusResponse {
  pendingOutboxCount: number
  pendingSyncEventCount: number
  connections: QboSyncStatusConnection[]
  latestSyncEvent: QboLatestSyncEvent | null
}

export interface QboSyncOutboxRow {
  id: string
  entity_type: string
  entity_id: string
  mutation_type: string
  status: QboSyncRowStatus
  attempt_count: number
  next_attempt_at: string | null
  applied_at: string | null
  error: string | null
  created_at: string
}

export interface QboSyncOutboxResponse {
  outbox: QboSyncOutboxRow[]
}

const KEYS = {
  all: () => ['qbo-sync'] as const,
  status: () => [...KEYS.all(), 'status'] as const,
  outbox: (limit: number) => [...KEYS.all(), 'outbox', limit] as const,
}

export const qboSyncQueryKeys = KEYS

export function fetchQboSyncStatus(): Promise<QboSyncStatusResponse> {
  return request<QboSyncStatusResponse>('/api/sync/status')
}

export function fetchQboSyncOutbox(limit = 50): Promise<QboSyncOutboxResponse> {
  return request<QboSyncOutboxResponse>(`/api/sync/outbox?limit=${encodeURIComponent(limit)}`)
}

/**
 * Live queue depths + latest sync event. Polls while a sync is
 * in-flight so the monitor reflects the syncing → succeeded|failed
 * transition without a manual refresh; the caller controls cadence via
 * `refetchInterval`.
 */
export function useQboSyncStatus(options?: { refetchInterval?: number | false }) {
  return useQuery<QboSyncStatusResponse>({
    queryKey: KEYS.status(),
    queryFn: fetchQboSyncStatus,
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? false,
  })
}

/**
 * Recent outbox rows. The monitor counts the `failed` rows here to show
 * a "needs attention" figure alongside the pending depth from
 * /api/sync/status (which counts pending + processing only).
 */
export function useQboSyncOutbox(limit = 50, options?: { refetchInterval?: number | false }) {
  return useQuery<QboSyncOutboxResponse>({
    queryKey: KEYS.outbox(limit),
    queryFn: () => fetchQboSyncOutbox(limit),
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? false,
  })
}

/** Count of failed rows in an outbox response, for the monitor's failed KPI. */
export function countFailedOutbox(res: QboSyncOutboxResponse | undefined): number {
  if (!res) return 0
  return res.outbox.reduce((n, row) => (row.status === 'failed' ? n + 1 : n), 0)
}

// ---------------------------------------------------------------------------
// qbo_sync_run workflow snapshot — the headless ADR-5 read surface.
//
// Wraps the routes added in apps/api/src/routes/qbo.ts:
//   - GET  /api/integrations/qbo/sync-runs/:id        → WorkflowSnapshot
//   - POST /api/integrations/qbo/sync-runs/:id/events → { event, state_version }
//
// This replaces the old `deriveRunState` reconstruction (which inferred
// the run state from the connection's cached `status` flag + the latest
// sync_events row). The UI now renders `state` + `next_events` straight
// from the authoritative reducer snapshot, and the RETRY action is just
// a dispatch of the next_event the machine offers.
// ---------------------------------------------------------------------------

/** Context columns carried on a qbo_sync_runs row (see QboSyncRunRow in the API). */
export interface QboSyncRunContext {
  id: string
  company_id: string
  integration_connection_id: string
  status: QboSyncRunState
  state_version: number
  started_at: string | null
  succeeded_at: string | null
  failed_at: string | null
  retried_at: string | null
  error: string | null
  snapshot: Record<string, unknown> | null
  triggered_by: string | null
  created_at?: string | null
}

/** Canonical WorkflowSnapshot envelope for a qbo_sync_runs row. */
export interface QboSyncRunSnapshot {
  state: QboSyncRunState
  state_version: number
  context: QboSyncRunContext
  next_events: Array<{ type: QboSyncRunHumanEvent; label: string; disabledReason?: string }>
}

export interface QboSyncRunListResponse {
  syncRuns: QboSyncRunSnapshot[]
}

const RUN_KEYS = {
  all: () => ['qbo-sync-run'] as const,
  detail: (id: string) => [...RUN_KEYS.all(), 'detail', id] as const,
  list: () => [...RUN_KEYS.all(), 'list'] as const,
}

export const qboSyncRunQueryKeys = RUN_KEYS

export function fetchQboSyncRun(id: string): Promise<QboSyncRunSnapshot> {
  return request<QboSyncRunSnapshot>(`/api/integrations/qbo/sync-runs/${encodeURIComponent(id)}`)
}

/**
 * List recent qbo_sync_runs (newest first). The monitor reads this on
 * mount to recover the most-recent run id so a `failed` run's RETRY
 * action survives a page reload (the run id is otherwise only known
 * from the POST /sync response within the same session).
 */
export function fetchQboSyncRuns(
  params: { state?: QboSyncRunState; limit?: number } = {},
): Promise<QboSyncRunListResponse> {
  const search = new URLSearchParams()
  if (params.state) search.set('state', params.state)
  if (params.limit) search.set('limit', String(params.limit))
  const qs = search.toString()
  return request<QboSyncRunListResponse>(`/api/integrations/qbo/sync-runs${qs ? `?${qs}` : ''}`)
}

export function useQboSyncRuns(params: { state?: QboSyncRunState; limit?: number } = {}) {
  return useQuery<QboSyncRunListResponse>({
    queryKey: [...RUN_KEYS.list(), params],
    queryFn: () => fetchQboSyncRuns(params),
    staleTime: 10_000,
  })
}

/**
 * Plain-function event dispatcher. Posts a human event (`RETRY` |
 * `START_SYNC`) and gets the next snapshot back. A 409 (stale version /
 * illegal transition) throws an ApiError whose body carries the fresh
 * `snapshot` so the caller can repaint.
 */
export function dispatchQboSyncRunEvent(
  id: string,
  event: QboSyncRunHumanEvent,
  stateVersion: number,
): Promise<QboSyncRunSnapshot> {
  return request<QboSyncRunSnapshot>(`/api/integrations/qbo/sync-runs/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    json: { event, state_version: stateVersion },
  })
}

/** A run is still in motion (and worth polling) until it reaches a rest state. */
export function isQboSyncRunInFlight(state: QboSyncRunState | undefined): boolean {
  return state === 'pending' || state === 'syncing' || state === 'retrying'
}

/**
 * Read one qbo_sync_run snapshot. While the run is in-flight
 * (pending / syncing / retrying) the query re-fetches on `pollInterval`
 * so the monitor reflects the syncing → succeeded | failed transition
 * without a manual refresh. Disabled until an id is known (the screen
 * learns the run id from the POST /sync response).
 */
export function useQboSyncRun(id: string | null | undefined, options?: { pollInterval?: number }) {
  const interval = options?.pollInterval ?? 3_000
  return useQuery<QboSyncRunSnapshot>({
    queryKey: RUN_KEYS.detail(id ?? ''),
    queryFn: () => fetchQboSyncRun(id!),
    enabled: Boolean(id),
    staleTime: 1_000,
    refetchInterval: (query) => (isQboSyncRunInFlight(query.state.data?.state) ? interval : false),
  })
}

/**
 * Dispatch a human event against a qbo_sync_run. On success the returned
 * snapshot is written straight into the detail cache so the monitor
 * repaints on the next tick instead of waiting for the poll round-trip.
 */
export function useDispatchQboSyncRunEvent(id: string) {
  const qc = useQueryClient()
  return useMutation<QboSyncRunSnapshot, Error, { event: QboSyncRunHumanEvent; state_version: number }>({
    mutationFn: (input) => dispatchQboSyncRunEvent(id, input.event, input.state_version),
    onSuccess: (data) => {
      qc.setQueryData(RUN_KEYS.detail(id), data)
      qc.invalidateQueries({ queryKey: RUN_KEYS.all() })
    },
  })
}
