// Admin notification queue — company-wide delivery-state view + the
// RETRY workflow event for failed rows. Mirrors the billing-runs hook
// (apps/web/src/lib/api/billing-runs.ts): list + workflow-event POST,
// both driven by the deterministic `notification` reducer in
// @sitelayer/workflows.
//
// Backend status (2026-05-26): the per-user feed in
// apps/api/src/routes/notifications.ts only exposes
//   GET  /api/notifications            (scoped to recipient = caller)
//   POST /api/notifications/:id/read
// It does NOT surface the workflow delivery `state`/`channel`/`error`
// columns, is not company-scoped for admins, and there is NO
// notification workflow-event route wired (the RETRY/VOID Zod schemas
// exist in @sitelayer/workflows but nothing calls them). This hook
// targets the natural admin endpoints that follow the existing
// workflow-event convention; they need to be added server-side. Until
// then the screen renders its error/empty states cleanly.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  NotificationChannel,
  NotificationFailureKind,
  NotificationHumanEventType,
  NotificationWorkflowState,
} from '@sitelayer/workflows'
import { request } from './client'

// Re-export the canonical unions so screens import from one place.
export type { NotificationChannel, NotificationFailureKind, NotificationHumanEventType, NotificationWorkflowState }

/**
 * One row of the admin queue. The delivery columns (`state`,
 * `state_version`, `channel`, `error`, `failure_kind`) come from the
 * notification workflow snapshot persisted on the row by the worker
 * runner. `recipient_clerk_user_id` / `recipient_email` identify who
 * the row is for; `subject` / `kind` describe what it is.
 */
export interface NotificationQueueRow {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  recipient_email: string | null
  kind: string
  subject: string
  channel: NotificationChannel | null
  state: NotificationWorkflowState
  state_version: number
  failure_kind: NotificationFailureKind | null
  error: string | null
  delivery_attempts: number | null
  next_attempt_at: string | null
  sent_at: string | null
  failed_at: string | null
  created_at: string
}

export interface NotificationQueueListParams {
  state?: NotificationWorkflowState
}

export interface NotificationQueueListResponse {
  notifications: NotificationQueueRow[]
}

/** Snapshot returned by the workflow-event POST, same shape as every
 *  other workflow: { state, state_version, next_events, context }. */
export interface NotificationSnapshot {
  state: NotificationWorkflowState
  state_version: number
  next_events: Array<{ type: NotificationHumanEventType; label: string }>
  context: NotificationQueueRow
}

const KEYS = {
  all: () => ['notifications-queue'] as const,
  list: (params: NotificationQueueListParams) => [...KEYS.all(), 'list', params] as const,
}

export const notificationQueueKeys = KEYS

export function fetchNotificationQueue(
  params: NotificationQueueListParams = {},
): Promise<NotificationQueueListResponse> {
  const search = new URLSearchParams()
  if (params.state) search.set('state', params.state)
  const qs = search.toString()
  return request<NotificationQueueListResponse>(`/api/notifications/queue${qs ? `?${qs}` : ''}`)
}

export function useNotificationQueue(params: NotificationQueueListParams = {}) {
  return useQuery<NotificationQueueListResponse>({
    queryKey: KEYS.list(params),
    queryFn: () => fetchNotificationQueue(params),
  })
}

/**
 * Dispatch a human workflow event (RETRY / VOID) against one
 * notification row. The reducer rejects a stale `state_version` with a
 * 409, mirroring billing runs; on success we invalidate the queue so
 * the row re-appears under its new state.
 */
export function useDispatchNotificationEvent() {
  const qc = useQueryClient()
  return useMutation<
    NotificationSnapshot,
    Error,
    { id: string; event: NotificationHumanEventType; state_version: number }
  >({
    mutationFn: ({ id, event, state_version }) =>
      request<NotificationSnapshot>(`/api/notifications/${encodeURIComponent(id)}/events`, {
        method: 'POST',
        json: { event, state_version },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.all() })
    },
  })
}
