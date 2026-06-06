// Projects — list + detail hooks for the Phase 2B prj-list / prj-detail
// screens. Wraps GET /api/projects (system.ts) + GET /api/projects/:id
// (projects.ts).

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

export type ProjectStatus = 'active' | 'lead' | 'completed' | 'archived' | string

export interface ProjectListRow {
  id: string
  name: string
  status: ProjectStatus
  division_code: string | null
  customer_name?: string | null
  customer_id?: string | null
  bid_total: string
  closed_at: string | null
  created_at: string
  updated_at: string
  // Geofence — selected by the list query in projects-query.ts so the
  // foreman live-crew map can avoid an N+1 detail fetch. Will be null
  // for projects without a geofence configured.
  site_lat?: string | null
  site_lng?: string | null
  site_radius_m?: number | null
  // project_lifecycle workflow state — surfaced by the list query
  // (projects-query.ts) so list/header chrome renders per-state without
  // a second fetch. The legacy `status` above is a free-text label, NOT
  // the pipeline state. Optional for back-compat with narrowed payloads.
  lifecycle_state?: string
  lifecycle_state_version?: number
  lifecycle_sent_at?: string | null
  lifecycle_accepted_at?: string | null
  lifecycle_declined_at?: string | null
  lifecycle_decline_reason?: string | null
  lifecycle_started_at?: string | null
  lifecycle_completed_at?: string | null
  lifecycle_archived_at?: string | null
}

export interface ProjectDetail extends ProjectListRow {
  labor_rate: string
  target_sqft_per_hr: string | null
  bonus_pool: string
  summary_locked_at: string | null
  site_lat: string | null
  site_lng: string | null
  site_radius_m: number | null
  auto_clock_in_enabled: boolean
  auto_clock_out_grace_seconds: number
  auto_clock_correction_window_seconds: number
  daily_budget_cents: number
  version: number
}

export interface ProjectListParams {
  status?: ProjectStatus
  /** Search match against name + customer_name (server-side ILIKE). */
  q?: string
  customer_id?: string
  /** Cursor pagination — server returns `nextCursor` from this field. */
  cursor?: string
  limit?: number
}

export interface ProjectListResponse {
  projects: ProjectListRow[]
  nextCursor: string | null
}

export interface ProjectDetailResponse {
  project: ProjectDetail
}

const KEYS = {
  all: () => ['projects'] as const,
  list: (params?: ProjectListParams) => [...KEYS.all(), 'list', params ?? {}] as const,
  detail: (id: string) => [...KEYS.all(), 'detail', id] as const,
}

export const projectQueryKeys = KEYS

export function fetchProjects(params: ProjectListParams = {}): Promise<ProjectListResponse> {
  const search = new URLSearchParams()
  if (params.status) search.set('status', params.status)
  if (params.q) search.set('q', params.q)
  if (params.customer_id) search.set('customer_id', params.customer_id)
  if (params.cursor) search.set('cursor', params.cursor)
  if (params.limit) search.set('limit', String(params.limit))
  const qs = search.toString()
  return request<ProjectListResponse>(`/api/projects${qs ? `?${qs}` : ''}`)
}

export function fetchProject(id: string): Promise<ProjectDetailResponse> {
  return request<ProjectDetailResponse>(`/api/projects/${encodeURIComponent(id)}`)
}

export function useProjects(params: ProjectListParams = {}, options?: Partial<UseQueryOptions<ProjectListResponse>>) {
  return useQuery<ProjectListResponse>({
    queryKey: KEYS.list(params),
    queryFn: () => fetchProjects(params),
    staleTime: 30_000,
    ...options,
  })
}

export function useProject(id: string | null | undefined, options?: Partial<UseQueryOptions<ProjectDetailResponse>>) {
  return useQuery<ProjectDetailResponse>({
    queryKey: KEYS.detail(id ?? ''),
    queryFn: () => fetchProject(id!),
    enabled: Boolean(id),
    ...options,
  })
}

/**
 * Project-scoped audit timeline. Returns recent project lifecycle events
 * (entity_type='project', entity_id=projectId). Unlike /api/audit-events
 * (admin-only) this surface is open to anyone with project access — the
 * per-project filter scopes data tightly enough that a foreman seeing
 * their own project's history is fine.
 */
export interface ProjectTimelineEvent {
  id: string
  actor_user_id: string | null
  actor_role: string | null
  entity_type: string
  entity_id: string | null
  action: string
  before: unknown
  after: unknown
  created_at: string
}

export interface ProjectTimelineResponse {
  events: ProjectTimelineEvent[]
}

export function useProjectTimeline(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<ProjectTimelineResponse>>,
) {
  return useQuery<ProjectTimelineResponse>({
    queryKey: ['projects', 'timeline', projectId ?? ''],
    queryFn: () => request<ProjectTimelineResponse>(`/api/projects/${encodeURIComponent(projectId!)}/timeline`),
    enabled: Boolean(projectId),
    ...options,
  })
}

/**
 * Project cost-rollup summary from /api/projects/:id/summary. Shape
 * matches `summarizeProject` in the API: returns estimate lines, labor
 * entries, and a metrics block with margin/bonus/totalCost. Per-scope
 * progress on the Overview tab joins estimate_lines × labor_entries
 * client-side (both fields are flat arrays here).
 */
export interface ProjectSummaryEstimateLine {
  service_item_code: string
  quantity: string
  unit: string
  rate: string
  amount: string
  created_at: string
}

export interface ProjectSummaryLaborEntry {
  service_item_code: string | null
  hours: string
  sqft_done: string | null
  status: string
  occurred_on: string
}

export interface ProjectSummaryResponse {
  project: { id: string; name: string; bid_total: string; status: string }
  metrics: {
    totalMeasurementQuantity: number
    estimateTotal: number
    laborCost: number
    materialCost: number
    subCost: number
    totalCost: number
    margin: { revenue: number; cost: number; profit: number; margin: number }
    bonus: { eligible: boolean; tier: number | null; payout: number }
  }
  measurements: Array<Record<string, unknown>>
  estimateLines: ProjectSummaryEstimateLine[]
  laborEntries: ProjectSummaryLaborEntry[]
}

export function useProjectSummary(
  id: string | null | undefined,
  options?: Partial<UseQueryOptions<ProjectSummaryResponse>>,
) {
  return useQuery<ProjectSummaryResponse>({
    queryKey: ['projects', 'summary', id ?? ''],
    queryFn: () => request<ProjectSummaryResponse>(`/api/projects/${encodeURIComponent(id!)}/summary`),
    enabled: Boolean(id),
    ...options,
  })
}

/**
 * Project closeout workflow snapshot. Wraps GET /api/projects/:id/closeout
 * (apps/api/src/routes/projects.ts) returning the deterministic-workflow
 * envelope { state, state_version, context, next_events } so screens can
 * render the closeout affordance from a single read instead of
 * reconstructing the state from `status='completed'` checks.
 *
 * Mutations go through the canonical POST /api/projects/:id/closeout/events
 * with { event, state_version }; the route returns the fresh
 * WorkflowSnapshot directly (no follow-up GET needed).
 */
export type ProjectCloseoutState = 'active' | 'completed' | 'post_mortem'
export type ProjectCloseoutHumanEvent = 'CLOSEOUT' | 'ACKNOWLEDGE_POST_MORTEM'

export interface ProjectCloseoutSnapshot {
  state: ProjectCloseoutState
  state_version: number
  next_events: Array<{ type: ProjectCloseoutHumanEvent; label: string; disabled_reason?: string }>
  context: {
    id: string
    company_id: string
    status: string
    closed_at: string | null
    closed_by: string | null
    summary_locked_at: string | null
    post_mortem_acknowledged_at: string | null
    post_mortem_acknowledged_by: string | null
    workflow_engine: string
    workflow_run_id: string | null
    version: number
    created_at: string
    updated_at: string
  }
}

export function fetchProjectCloseout(projectId: string): Promise<ProjectCloseoutSnapshot> {
  return request<ProjectCloseoutSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/closeout`)
}

/**
 * Dispatch a closeout workflow event through the canonical
 * POST /api/projects/:id/closeout/events route with { event, state_version }.
 * Gates on `state_version` (not the row `version`) and returns the fresh
 * WorkflowSnapshot directly — a stale `state_version` or illegal transition
 * returns 409, which the XState machine reloads-and-retries.
 */
export async function submitProjectCloseoutEvent(
  projectId: string,
  event: ProjectCloseoutHumanEvent,
  stateVersion: number,
): Promise<ProjectCloseoutSnapshot> {
  return request<ProjectCloseoutSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/closeout/events`, {
    method: 'POST',
    json: { event, state_version: stateVersion },
  })
}

export function useProjectCloseout(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<ProjectCloseoutSnapshot>>,
) {
  return useQuery<ProjectCloseoutSnapshot>({
    queryKey: ['projects', 'closeout', projectId ?? ''],
    queryFn: () => fetchProjectCloseout(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

/**
 * Foreman morning briefs for a project (`fm-brief`). Wraps GET
 * /api/projects/:id/briefs?date=YYYY-MM-DD. Used by the daily-log
 * auto-assembly fallback to seed `scope_progress` from the morning
 * brief when the AI agent hasn't run yet, and by `wk-today` /
 * `wk-scope` to surface yesterday's brief to the worker.
 *
 * The `useCreateProjectBrief` mutation lives in ./project-briefs.ts —
 * this is the read side, kept here so callers share one query key.
 */
export interface ProjectBrief {
  id: string
  company_id: string
  project_id: string
  foreman_user_id: string
  effective_date: string
  goal: string
  steps: unknown
  crew: unknown
  materials: unknown
  version: number
  created_at: string
  updated_at: string
}

export interface ProjectBriefListResponse {
  briefs: ProjectBrief[]
}

export function useProjectBriefs(
  projectId: string | null | undefined,
  date?: string,
  options?: Partial<UseQueryOptions<ProjectBriefListResponse>>,
) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : ''
  return useQuery<ProjectBriefListResponse>({
    queryKey: ['projects', 'briefs', projectId ?? '', date ?? ''],
    queryFn: () => request<ProjectBriefListResponse>(`/api/projects/${encodeURIComponent(projectId!)}/briefs${qs}`),
    enabled: Boolean(projectId),
    ...options,
  })
}
