// Notification preferences — wraps apps/api/src/routes/notification-preferences.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'
import { queryKeys } from './keys'

export type NotificationChannel = 'push' | 'sms' | 'email' | 'off'

export interface NotificationPreferences {
  id?: string
  company_id: string
  clerk_user_id: string
  channel_assignment_change: NotificationChannel
  channel_time_review_ready: NotificationChannel
  channel_daily_log_reminder: NotificationChannel
  channel_clock_anomaly: NotificationChannel
  sms_phone: string | null
  email: string | null
  created_at?: string
  updated_at?: string
}

export interface NotificationPreferencesResponse {
  preferences: NotificationPreferences
}

export interface UpdateNotificationPreferencesRequest {
  channel_assignment_change?: NotificationChannel
  channel_time_review_ready?: NotificationChannel
  channel_daily_log_reminder?: NotificationChannel
  channel_clock_anomaly?: NotificationChannel
  sms_phone?: string | null
  email?: string | null
}

// ---------------------------------------------------------------------------
// Request functions
// ---------------------------------------------------------------------------

export function fetchNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  return request<NotificationPreferencesResponse>('/api/notification-preferences')
}

export function updateNotificationPreferences(
  input: UpdateNotificationPreferencesRequest,
): Promise<NotificationPreferencesResponse> {
  return request<NotificationPreferencesResponse>('/api/notification-preferences', { method: 'PUT', json: input })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useNotificationPreferences(options?: Partial<UseQueryOptions<NotificationPreferencesResponse>>) {
  return useQuery<NotificationPreferencesResponse>({
    queryKey: queryKeys.notificationPreferences.current(),
    queryFn: fetchNotificationPreferences,
    ...options,
  })
}

export function useUpdateNotificationPreferences() {
  const qc = useQueryClient()
  return useMutation<NotificationPreferencesResponse, Error, UpdateNotificationPreferencesRequest>({
    mutationFn: (input) => updateNotificationPreferences(input),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.notificationPreferences.current(), data)
    },
  })
}
