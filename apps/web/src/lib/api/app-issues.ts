// Internal APP-ISSUE surface (apps/api/src/routes/issues.ts). Read-only
// list/board/detail over the `app_issue` half of context_work_items, gated
// server-side by the PLATFORM capability `app_issue.view`. These are problems
// with the sitelayer SOFTWARE, NOT the per-company field-request work board
// (work-requests.ts). The two domains never bleed.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'
import type { SessionResponse } from './bootstrap'
import type {
  ContextHandoffEvent,
  ContextWorkItem,
  WorkItemLane,
  WorkItemStatus,
  WorkRequestSupportPacketSummary,
} from './work-requests'

export type AppIssue = ContextWorkItem & { domain: 'app_issue' }

export type AppIssueBoardGroupBy = 'lane' | 'status_group'

export interface AppIssueBoardColumn {
  id: string
  title: string
  lane: WorkItemLane | null
  statuses: WorkItemStatus[]
  work_items: AppIssue[]
}

export interface AppIssueBoardResponse {
  group_by: AppIssueBoardGroupBy
  columns: AppIssueBoardColumn[]
  issues: AppIssue[]
  pagination: { limit: number; offset: number; total: number }
}

export interface AppIssueDetailResponse {
  issue: AppIssue
  support_packet: WorkRequestSupportPacketSummary | null
  events: ContextHandoffEvent[]
  events_pagination: { limit: number; offset: number; total: number; has_more: boolean }
}

export interface AppIssueBoardParams {
  groupBy?: AppIssueBoardGroupBy
  status?: WorkItemStatus | null
  lane?: WorkItemLane | null
  limit?: number
}

const appIssueKeys = {
  board: (params: AppIssueBoardParams) => ['app-issues', 'board', params] as const,
  detail: (id: string) => ['app-issues', 'detail', id] as const,
  costLedger: (supportPacketId: string) => ['app-issues', 'cost-ledger', supportPacketId] as const,
}

function boardSearch(params: AppIssueBoardParams): string {
  const search = new URLSearchParams()
  if (params.groupBy) search.set('group_by', params.groupBy)
  if (params.status) search.set('status', params.status)
  if (params.lane) search.set('lane', params.lane)
  if (params.limit) search.set('limit', String(params.limit))
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

export function fetchAppIssueBoard(params: AppIssueBoardParams = {}): Promise<AppIssueBoardResponse> {
  return request<AppIssueBoardResponse>(`/api/issues/board${boardSearch(params)}`)
}

export function useAppIssueBoard(
  params: AppIssueBoardParams = {},
  options?: Partial<UseQueryOptions<AppIssueBoardResponse, Error>>,
) {
  return useQuery<AppIssueBoardResponse, Error>({
    queryKey: appIssueKeys.board(params),
    queryFn: () => fetchAppIssueBoard(params),
    ...options,
  })
}

/**
 * The caller's effective PLATFORM app_issue.* capabilities (off /api/session).
 * Drives whether the SPA mounts the internal /issues board entry. Empty for a
 * non-platform-admin / non-Clerk session; the API 403s regardless.
 */
export function useAppIssueCapabilities() {
  return useQuery<string[], Error>({
    queryKey: ['app-issues', 'capabilities'],
    queryFn: async () => {
      const session = await request<SessionResponse>('/api/session')
      return session.app_issue_capabilities ?? []
    },
    staleTime: 5 * 60_000,
  })
}

export function fetchAppIssueDetail(id: string): Promise<AppIssueDetailResponse> {
  return request<AppIssueDetailResponse>(`/api/issues/${encodeURIComponent(id)}`)
}

export function useAppIssueDetail(
  id: string | undefined,
  options?: Partial<UseQueryOptions<AppIssueDetailResponse, Error>>,
) {
  return useQuery<AppIssueDetailResponse, Error>({
    queryKey: appIssueKeys.detail(id ?? ''),
    queryFn: () => fetchAppIssueDetail(id as string),
    enabled: Boolean(id),
    ...options,
  })
}

// --- STEP6: escalation ("go deeper") ----------------------------------------

/**
 * Enrichment tiers for the escalate ("go deeper") control. Tier 0/1 ship at
 * finalize; tier 2/3 re-run the enrichment AROUND the bundle's already-pinned
 * trace_id / request_id / event_ref (never re-derived) and each pull is
 * recorded in support_packet_access_log so the per-issue cost ledger sees it.
 */
export type AppIssueEscalateTier = 2 | 3

export interface AppIssueEscalateInput {
  tier: AppIssueEscalateTier
}

export interface AppIssueEscalatePull {
  source: string
  status: 'ok' | 'skipped' | 'error'
  detail?: string | null
  cost_cents?: number | null
}

export interface AppIssueEscalateResponse {
  issue: AppIssue
  tier: AppIssueEscalateTier
  pulls: AppIssueEscalatePull[]
  support_packet_id: string
  /** Echoed already-pinned anchors the escalation enriched around. */
  anchors: {
    trace_id: string | null
    request_id: string | null
    event_ref: string | null
  }
}

export function escalateAppIssue(id: string, input: AppIssueEscalateInput): Promise<AppIssueEscalateResponse> {
  return request<AppIssueEscalateResponse>(`/api/issues/${encodeURIComponent(id)}/escalate`, {
    method: 'POST',
    json: input,
  })
}

/**
 * "Go deeper" mutation. On success it invalidates the issue detail + cost
 * ledger so the new enrichment pulls and their cost rows show immediately.
 * Gated client-side by `app_issue.triage` (the control is hidden without it);
 * the API enforces `ctx.requireCapability('app_issue.triage')` regardless.
 */
export function useEscalateAppIssue(id: string) {
  const qc = useQueryClient()
  return useMutation<AppIssueEscalateResponse, Error, AppIssueEscalateInput>({
    mutationFn: (input) => escalateAppIssue(id, input),
    onSuccess: (response) => {
      qc.invalidateQueries({ queryKey: appIssueKeys.detail(id) })
      qc.invalidateQueries({ queryKey: appIssueKeys.costLedger(response.support_packet_id) })
    },
  })
}

// --- STEP6: per-issue cost ledger -------------------------------------------

/**
 * One cost-bearing access-log row for an issue's support packet. The escalation
 * path records each enrichment pull in support_packet_access_log; the metadata
 * carries the enrichment source + cost so the ledger can tally per-issue spend
 * without a separate billing table.
 */
export interface AppIssueCostLedgerEntry {
  id: string
  access_type: string
  source: string | null
  tier: number | null
  cost_cents: number | null
  request_id: string | null
  created_at: string
  metadata: Record<string, unknown>
}

export interface AppIssueCostLedgerResponse {
  entries: AppIssueCostLedgerEntry[]
  total_cost_cents: number
  pull_count: number
}

/**
 * Read the per-issue cost ledger by projecting the support packet's
 * access-log rows into cost-bearing entries. The backend exposes the raw log
 * at `/api/support-packets/:id/access-log`; we tally the enrichment pulls
 * (rows whose metadata carries a cost) client-side so the detail screen shows
 * a running spend without a dedicated endpoint.
 */
export async function fetchAppIssueCostLedger(supportPacketId: string): Promise<AppIssueCostLedgerResponse> {
  const { fetchSupportPacketAccessLog } = await import('./support-packets')
  const { access_log } = await fetchSupportPacketAccessLog(supportPacketId)
  const entries: AppIssueCostLedgerEntry[] = access_log.map((row) => {
    const meta = row.metadata ?? {}
    return {
      id: row.id,
      access_type: row.access_type,
      source: typeof meta.source === 'string' ? meta.source : null,
      tier: typeof meta.tier === 'number' ? meta.tier : null,
      cost_cents: typeof meta.cost_cents === 'number' ? meta.cost_cents : null,
      request_id: row.request_id,
      created_at: row.created_at,
      metadata: meta,
    }
  })
  const total_cost_cents = entries.reduce((sum, e) => sum + (e.cost_cents ?? 0), 0)
  const pull_count = entries.filter((e) => e.cost_cents != null).length
  return { entries, total_cost_cents, pull_count }
}

export function useAppIssueCostLedger(
  supportPacketId: string | null | undefined,
  options?: Partial<UseQueryOptions<AppIssueCostLedgerResponse, Error>>,
) {
  return useQuery<AppIssueCostLedgerResponse, Error>({
    queryKey: appIssueKeys.costLedger(supportPacketId ?? ''),
    queryFn: () => fetchAppIssueCostLedger(supportPacketId as string),
    enabled: Boolean(supportPacketId),
    ...options,
  })
}
