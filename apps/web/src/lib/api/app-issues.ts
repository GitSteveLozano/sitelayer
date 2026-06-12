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
  DiagnosticCheckStatus,
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
  diagnostic_manifest: AppIssueDiagnosticManifest
  events: ContextHandoffEvent[]
  events_pagination: { limit: number; offset: number; total: number; has_more: boolean }
}

export interface AppIssueDiagnosticManifest {
  schema: 'sitelayer.diagnostic_manifest.v1'
  generated_at: string
  subject: {
    kind: 'app_issue'
    issue_id: string
    support_packet_id: string
    capture_session_id: string | null
  }
  operator_next_step: string
  needs_attention: boolean
  capture_readiness: {
    support_packet: 'ready' | 'missing'
    capture_session: 'ready' | 'not_captured'
    artifact_analysis: 'ready' | 'pending' | 'failed' | 'missing'
  }
  evidence_refs: Array<{ type: string; id: string }>
  worker_health_refs: Array<{ kind: string; path: string }>
  checks: Array<{
    key: string
    label: string
    status: DiagnosticCheckStatus
    detail: string | null
  }>
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

// --- Triage write surface (POST /api/issues/:id/events) ----------------------

/**
 * The three human triage verbs over the app_issue status vocabulary — the
 * narrow write surface issues.ts exposes (gated server-side on the PLATFORM
 * capability `app_issue.triage`, same boundary as escalate). Agents only ever
 * reach review_ready; `resolve` is the doc-promised "human accepts to resolve"
 * leg (resolution.accepted). Never a free-form status write.
 */
export type AppIssueTriageAction = 'accept' | 'resolve' | 'wont_do'

/** Mirrors issues.ts ACCEPT_FROM_STATUSES — accept pulls a fresh/bounced issue into triage. */
export const APP_ISSUE_ACCEPT_FROM_STATUSES: readonly WorkItemStatus[] = [
  'new',
  'reopened',
  'review_stale',
  'proposal_expired',
]

/** Mirrors issues.ts CLOSE_FROM_STATUSES — resolve / wont_do close any non-terminal issue. */
export const APP_ISSUE_CLOSE_FROM_STATUSES: readonly WorkItemStatus[] = [
  'new',
  'triaged',
  'human_assigned',
  'reopened',
  'agent_running',
  'review_ready',
  'review_stale',
  'proposal_expired',
]

/**
 * Client-side mirror of the server's transition gate so the SPA only offers a
 * verb the API would accept (the API re-checks under FOR UPDATE regardless).
 */
export function appIssueTriageActionAllowed(action: AppIssueTriageAction, status: WorkItemStatus): boolean {
  const allowed = action === 'accept' ? APP_ISSUE_ACCEPT_FROM_STATUSES : APP_ISSUE_CLOSE_FROM_STATUSES
  return allowed.includes(status)
}

export interface AppIssueTriageInput {
  action: AppIssueTriageAction
  message?: string | null
  idempotency_key?: string | null
}

export interface AppIssueTriageResponse {
  issue: AppIssue
  event: ContextHandoffEvent | null
}

export function triageAppIssue(id: string, input: AppIssueTriageInput): Promise<AppIssueTriageResponse> {
  return request<AppIssueTriageResponse>(`/api/issues/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    json: input,
  })
}

/**
 * Triage mutation (accept / resolve / wont_do). On success it invalidates the
 * issue detail plus every board query so the moved card leaves its column
 * immediately. Hidden client-side without `app_issue.triage`; the API enforces
 * the capability regardless.
 */
export function useTriageAppIssue(id: string) {
  const qc = useQueryClient()
  return useMutation<AppIssueTriageResponse, Error, AppIssueTriageInput>({
    mutationFn: (input) => triageAppIssue(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: appIssueKeys.detail(id) })
      qc.invalidateQueries({ queryKey: ['app-issues', 'board'] })
    },
  })
}

// --- Capture analysis (analyzer write-back) ----------------------------------

/**
 * The analyzer RETURN leg's write-back (agent-feed.ts applyTerminalCallbackEffects):
 * a succeeded capture-analyzer callback stores its markdown transcript/analysis
 * into the work item's `metadata.capture_analysis`. The issues detail API
 * returns the full metadata, so the card can render the loop's payoff inline.
 */
export interface AppIssueCaptureAnalysis {
  markdown: string
  completed_at: string | null
  artifacts: Array<Record<string, unknown>>
}

/**
 * Analyzer READINESS (worker capture-artifact-analysis.ts): how many eligible
 * capture artifacts have an analysis event yet — the evidence-status strip.
 */
export interface AppIssueCaptureAnalysisReadiness {
  status: string
  eligible_artifact_count: number | null
  processed_artifact_count: number | null
  pending_artifact_count: number | null
  updated_at: string | null
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readAppIssueCaptureAnalysis(
  metadata: Record<string, unknown> | null | undefined,
): AppIssueCaptureAnalysis | null {
  const raw = jsonObject(metadata?.capture_analysis)
  if (!raw || typeof raw.markdown !== 'string' || !raw.markdown.trim()) return null
  return {
    markdown: raw.markdown,
    completed_at: typeof raw.completed_at === 'string' ? raw.completed_at : null,
    artifacts: Array.isArray(raw.artifacts)
      ? raw.artifacts.filter((entry): entry is Record<string, unknown> => Boolean(jsonObject(entry)))
      : [],
  }
}

export function readAppIssueCaptureAnalysisReadiness(
  metadata: Record<string, unknown> | null | undefined,
): AppIssueCaptureAnalysisReadiness | null {
  const raw = jsonObject(metadata?.capture_artifact_analysis)
  if (!raw || typeof raw.status !== 'string' || !raw.status.trim()) return null
  return {
    status: raw.status,
    eligible_artifact_count: numberOrNull(raw.eligible_artifact_count),
    processed_artifact_count: numberOrNull(raw.processed_artifact_count),
    pending_artifact_count: numberOrNull(raw.pending_artifact_count),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  }
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
