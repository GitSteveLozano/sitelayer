// Web Push subscription API — wraps apps/api/src/routes/push-subscriptions.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'
import { queryKeys } from './keys'

export interface PushSubscriptionRow {
  id: string
  company_id: string
  clerk_user_id: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent: string | null
  created_at: string
  last_seen_at: string
}

export interface VapidPublicKeyResponse {
  vapidPublicKey: string
}

export interface SubscribeRequest {
  endpoint: string
  p256dh: string
  auth: string
  user_agent?: string | null
}

export interface SubscribeResponse {
  subscription: PushSubscriptionRow
}

// ---------------------------------------------------------------------------
// Request functions
// ---------------------------------------------------------------------------

export function fetchVapidPublicKey(): Promise<VapidPublicKeyResponse> {
  return request<VapidPublicKeyResponse>('/api/push/vapid-public-key')
}

export function subscribePush(input: SubscribeRequest): Promise<SubscribeResponse> {
  return request<SubscribeResponse>('/api/push/subscriptions', { method: 'POST', json: input })
}

export function unsubscribePush(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useVapidPublicKey(options?: Partial<UseQueryOptions<VapidPublicKeyResponse>>) {
  return useQuery<VapidPublicKeyResponse>({
    queryKey: queryKeys.push.vapidKey(),
    queryFn: fetchVapidPublicKey,
    // The key is rotated rarely; cache aggressively.
    staleTime: 24 * 60 * 60 * 1000,
    ...options,
  })
}

export function useSubscribePush() {
  return useMutation<SubscribeResponse, Error, SubscribeRequest>({
    mutationFn: (input) => subscribePush(input),
  })
}

export function useUnsubscribePush() {
  const qc = useQueryClient()
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => unsubscribePush(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.push.all() })
    },
  })
}
