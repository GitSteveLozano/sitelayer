// Cross-role comms (v2) — project chat + owner broadcast. Wraps
// apps/api/src/routes/messaging.ts.
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type {
  Broadcast,
  BroadcastAudience,
  ProjectMessage,
  ProjectMessageMeta,
  ProjectMessageSummary,
} from '@sitelayer/domain'
import { request } from './client'

export type {
  ProjectMessage,
  ProjectMessageMeta,
  ProjectMessageSummary,
  Broadcast,
  BroadcastAudience,
} from '@sitelayer/domain'

export interface ProjectMessagesResponse {
  messages: ProjectMessage[]
}
export interface BroadcastsResponse {
  broadcasts: Broadcast[]
}

const KEYS = {
  messages: (projectId: string) => ['project-messages', projectId] as const,
  messageSummary: (projectId: string) => ['project-messages', projectId, 'summary'] as const,
  broadcasts: () => ['broadcasts'] as const,
}
export const messagingQueryKeys = KEYS

export function fetchProjectMessages(projectId: string): Promise<ProjectMessagesResponse> {
  return request<ProjectMessagesResponse>(`/api/projects/${encodeURIComponent(projectId)}/messages`)
}
export function fetchProjectMessageSummary(projectId: string): Promise<ProjectMessageSummary> {
  return request<ProjectMessageSummary>(`/api/projects/${encodeURIComponent(projectId)}/messages/summary`)
}
export function markThreadRead(projectId: string): Promise<{ last_read_at: string }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/messages/read`, { method: 'POST' })
}
export function postProjectMessage(
  projectId: string,
  body: string,
  authorRole?: string,
  meta?: ProjectMessageMeta | null,
): Promise<{ message: ProjectMessage }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/messages`, {
    method: 'POST',
    json: {
      body,
      ...(authorRole ? { author_role: authorRole } : {}),
      ...(meta ? { meta } : {}),
    },
  })
}
export function fetchBroadcasts(): Promise<BroadcastsResponse> {
  return request<BroadcastsResponse>(`/api/broadcasts`)
}
export function postBroadcast(input: {
  body: string
  audience?: BroadcastAudience
  project_id?: string
}): Promise<{ broadcast: Broadcast }> {
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
    mutationFn: (args: { body: string; authorRole?: string; meta?: ProjectMessageMeta | null }) =>
      postProjectMessage(projectId, args.body, args.authorRole, args.meta),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.messages(projectId) })
      void qc.invalidateQueries({ queryKey: KEYS.messageSummary(projectId) })
    },
  })
}

/**
 * Per-thread summary (last message preview + caller's unread count) for the
 * chat list. One query per project thread; the list maps a row of these.
 */
export function useMessageSummary(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<ProjectMessageSummary>>,
) {
  return useQuery<ProjectMessageSummary>({
    queryKey: KEYS.messageSummary(projectId ?? ''),
    queryFn: () => fetchProjectMessageSummary(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

/**
 * Mark a thread read for the caller (upserts last_read_at = now()). Invalidates
 * the thread's summary so the unread badge clears on success.
 */
export function useMarkThreadRead(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => markThreadRead(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.messageSummary(projectId) }),
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
