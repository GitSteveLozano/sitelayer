// Project lost reasons (v2) — types + hooks. Wraps
// apps/api/src/routes/project-lost-reasons.ts. Powers the PROJECT · LOST
// capture screen + client-profile win-rate stats.
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { LostReasonCode, ProjectLostReason } from '@sitelayer/domain'
import { LOST_REASON_CODES } from '@sitelayer/domain'
import { request } from './client'

export type { ProjectLostReason, LostReasonCode } from '@sitelayer/domain'
export { LOST_REASON_CODES } from '@sitelayer/domain'

/** Display labels for the v2 reason picker. */
export const LOST_REASON_LABELS: Record<LostReasonCode, string> = {
  price: 'Price',
  timing: 'Timing',
  scope: 'Scope',
  ghosted: 'Ghosted',
  competitor: 'Competitor',
  other: 'Other',
}

export interface ProjectLostReasonResponse {
  lost_reason: ProjectLostReason | null
}

export interface SetLostReasonInput {
  reason: LostReasonCode
  note?: string
  lost_value?: number
}

const KEYS = {
  all: () => ['project-lost-reasons'] as const,
  byProject: (projectId: string) => [...KEYS.all(), projectId] as const,
}
export const projectLostReasonQueryKeys = KEYS

export function fetchProjectLostReason(projectId: string): Promise<ProjectLostReasonResponse> {
  return request<ProjectLostReasonResponse>(`/api/projects/${encodeURIComponent(projectId)}/lost-reason`)
}

export function setProjectLostReason(projectId: string, input: SetLostReasonInput): Promise<ProjectLostReasonResponse> {
  return request<ProjectLostReasonResponse>(`/api/projects/${encodeURIComponent(projectId)}/lost-reason`, {
    method: 'PUT',
    json: input,
  })
}

export function isLostReasonCode(value: string): value is LostReasonCode {
  return (LOST_REASON_CODES as readonly string[]).includes(value)
}

export function useProjectLostReason(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<ProjectLostReasonResponse>>,
) {
  return useQuery<ProjectLostReasonResponse>({
    queryKey: KEYS.byProject(projectId ?? ''),
    queryFn: () => fetchProjectLostReason(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

export function useSetProjectLostReason(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SetLostReasonInput) => setProjectLostReason(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.byProject(projectId) }),
  })
}
