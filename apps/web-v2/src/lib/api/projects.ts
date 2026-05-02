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
