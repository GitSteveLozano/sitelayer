// Platform-grant (app_issue.*) management — wraps the superadmin-gated API:
//   GET    /api/admin/platform-grants                    (list + app_issue.* catalog)
//   POST   /api/admin/platform-grants                    { clerk_user_id, capability }
//   DELETE /api/admin/platform-grants/:clerkUserId/:cap  (revoke)
//
// See apps/api/src/routes/platform-grants.ts. app_issue.* capabilities (capture
// / view / triage the sitelayer SOFTWARE's own issues) live ONLY on the platform
// boundary: a superadmin holds them all implicitly, and these opt-in
// (clerk_user_id, capability) rows grant ONE cap to a non-superadmin person. The
// API gate is a verified Clerk superadmin — never reachable via a company role.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppIssueCapability } from '@sitelayer/domain'
import { request } from './client'

export interface PlatformGrant {
  clerk_user_id: string
  capability: AppIssueCapability
  created_at: string
}

export interface PlatformGrantsResponse {
  grants: PlatformGrant[]
  /** The app_issue.* catalog, so the UI never re-derives it. */
  catalog: AppIssueCapability[]
}

const platformGrantsKey = ['admin', 'platform-grants'] as const

export function usePlatformGrants() {
  return useQuery<PlatformGrantsResponse>({
    queryKey: platformGrantsKey,
    queryFn: () => request<PlatformGrantsResponse>('/api/admin/platform-grants'),
  })
}

export function useGrantPlatformCapability() {
  const qc = useQueryClient()
  return useMutation<{ grant: PlatformGrant }, Error, { clerk_user_id: string; capability: AppIssueCapability }>({
    mutationFn: (input) =>
      request<{ grant: PlatformGrant }>('/api/admin/platform-grants', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: platformGrantsKey }),
  })
}

export function useRevokePlatformCapability() {
  const qc = useQueryClient()
  return useMutation<{ deleted: boolean }, Error, { clerk_user_id: string; capability: AppIssueCapability }>({
    mutationFn: ({ clerk_user_id, capability }) =>
      request<{ deleted: boolean }>(
        `/api/admin/platform-grants/${encodeURIComponent(clerk_user_id)}/${encodeURIComponent(capability)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: platformGrantsKey }),
  })
}
