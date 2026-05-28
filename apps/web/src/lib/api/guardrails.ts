// Guardrails (v2) — types + hooks. Wraps apps/api/src/routes/guardrails.ts.
// Drives the owner dashboard calm-vs-attention card + project at-risk state.
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { Guardrail } from '@sitelayer/domain'
import { request } from './client'

export type { Guardrail, GuardrailType, GuardrailStatus } from '@sitelayer/domain'

export interface GuardrailsResponse {
  guardrails: Guardrail[]
}
export interface GuardrailResponse {
  guardrail: Guardrail
}

const KEYS = {
  all: () => ['guardrails'] as const,
  active: () => [...KEYS.all(), 'active'] as const,
  byProject: (projectId: string) => [...KEYS.all(), 'project', projectId] as const,
}
export const guardrailQueryKeys = KEYS

export function fetchProjectGuardrails(projectId: string): Promise<GuardrailsResponse> {
  return request<GuardrailsResponse>(`/api/projects/${encodeURIComponent(projectId)}/guardrails`)
}

export function fetchActiveGuardrails(): Promise<GuardrailsResponse> {
  return request<GuardrailsResponse>(`/api/guardrails/active`)
}

export function snoozeGuardrail(id: string, snoozedUntil: string): Promise<GuardrailResponse> {
  return request<GuardrailResponse>(`/api/guardrails/${encodeURIComponent(id)}/snooze`, {
    method: 'POST',
    json: { snoozed_until: snoozedUntil },
  })
}

export function muteGuardrail(id: string, mutedReason: string): Promise<GuardrailResponse> {
  return request<GuardrailResponse>(`/api/guardrails/${encodeURIComponent(id)}/mute`, {
    method: 'POST',
    json: { muted_reason: mutedReason },
  })
}

export function clearGuardrail(id: string): Promise<GuardrailResponse> {
  return request<GuardrailResponse>(`/api/guardrails/${encodeURIComponent(id)}/clear`, { method: 'POST' })
}

export function useActiveGuardrails(options?: Partial<UseQueryOptions<GuardrailsResponse>>) {
  return useQuery<GuardrailsResponse>({
    queryKey: KEYS.active(),
    queryFn: fetchActiveGuardrails,
    ...options,
  })
}

export function useProjectGuardrails(
  projectId: string | null | undefined,
  options?: Partial<UseQueryOptions<GuardrailsResponse>>,
) {
  return useQuery<GuardrailsResponse>({
    queryKey: KEYS.byProject(projectId ?? ''),
    queryFn: () => fetchProjectGuardrails(projectId!),
    enabled: Boolean(projectId),
    ...options,
  })
}

/** snooze / mute / clear — invalidates the active list + project lists. */
export function useGuardrailAction() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: KEYS.all() })
  return {
    snooze: useMutation({
      mutationFn: (args: { id: string; snoozedUntil: string }) => snoozeGuardrail(args.id, args.snoozedUntil),
      onSuccess: invalidate,
    }),
    mute: useMutation({
      mutationFn: (args: { id: string; mutedReason: string }) => muteGuardrail(args.id, args.mutedReason),
      onSuccess: invalidate,
    }),
    clear: useMutation({
      mutationFn: (id: string) => clearGuardrail(id),
      onSuccess: invalidate,
    }),
  }
}
