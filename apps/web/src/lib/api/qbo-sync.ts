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

import { useQuery } from '@tanstack/react-query'
import { request } from './client'

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
