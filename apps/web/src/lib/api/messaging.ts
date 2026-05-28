// Cross-role comms (v2) — project chat + owner broadcast. Wraps
// apps/api/src/routes/messaging.ts.
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { Broadcast, BroadcastAudience, ProjectMessage } from '@sitelayer/domain'
import { request } from './client'

export type { ProjectMessage, Broadcast, BroadcastAudience } from '@sitelayer/domain'

export interface ProjectMessagesResponse {
  messages: ProjectMessage[]
}
export interface BroadcastsResponse {
  broadcasts: Broadcast[]
}

const KEYS = {
  messages: (projectId: string) => ['project-messages', projectId] as const,
  broadcasts: () => ['broadcasts'] as const,
}
export const messagingQueryKeys = KEYS

export function fetchProjectMessages(projectId: string): Promise<ProjectMessagesResponse> {
  return request<ProjectMessagesResponse>(`/api/projects/${encodeURIComponent(projectId)}/messages`)
}
export function postProjectMessage(projectId: string, body: string, authorRole?: string): Promise<{ message: ProjectMessage }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/messages`, {
    method: 'POST',
    json: { body, ...(authorRole ? { author_role: authorRole } : {}) },
  })
}
export function fetchBroadcasts(): Promise<BroadcastsResponse> {
  return request<BroadcastsResponse>(`/api/broadcasts`)
}
export function postBroadcast(input: { body: string; audience?: BroadcastAudience; project_id?: string }): Promise<{ broadcast: Broadcast }> {
  return request(`/api/broadcasts`, { method: 'POST', json: input })
}

export function useProjectMessages(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<ProjectMessagesResponse>>,
) {
  return useQuery<ProjectMessagesResponse>({
    queryKey: KEYS.messages(projectId ?? ''),
    queryFn: () => fetchProjectMessages(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}
export function usePostProjectMessage(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { body: string; authorRole?: string }) => postProjectMessage(projectId, args.body, args.authorRole),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.messages(projectId) }),
  })
}
export function useBroadcasts(options?: Partial<UseQueryOptions<BroadcastsResponse>>) {
  return useQuery<BroadcastsResponse>({ queryKey: KEYS.broadcasts(), queryFn: fetchBroadcasts, ...options })
}
export function usePostBroadcast() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { body: string; audience?: BroadcastAudience; project_id?: string }) => postBroadcast(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.broadcasts() }),
  })
}
