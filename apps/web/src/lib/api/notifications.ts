// Per-user notifications feed — wraps apps/api/src/routes/notifications.ts.
//
// The worker drains Loop 2 (Field Event Escalation) resolution rows into
// the `notifications` table targeting the originating worker; this hook
// is what wk-today polls so those rows surface as a "Foreman replied"
// banner instead of piling up unread.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { request } from './client'

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: string
  company_id: string
  recipient_clerk_user_id: string | null
  kind: string
  subject: string
  body_text: string
  payload: Record<string, unknown>
  read_at: string | null
  created_at: string
  // Delivery-state fields from the latest workflow_event_log snapshot
  // (null for pre-workflow rows). Recipient-scoped — see
  // apps/api/src/routes/notifications.ts GET /api/notifications.
  state?: string | null
  channel?: string | null
  failure_kind?: string | null
  failed_at?: string | null
}

export interface NotificationListResponse {
  notifications: NotificationRow[]
}

export interface NotificationReadResponse {
  notification: NotificationRow
}

export interface NotificationListParams {
  unread?: boolean
  kind?: string
  limit?: number
}

// ---------------------------------------------------------------------------
// Query keys (kept colocated — only used here today)
// ---------------------------------------------------------------------------

export const notificationQueryKeys = {
  all: () => ['notifications'] as const,
  list: (params: NotificationListParams = {}) => [...notificationQueryKeys.all(), 'list', params] as const,
}

// ---------------------------------------------------------------------------
// Request functions
// ---------------------------------------------------------------------------

function buildListQuery(params: NotificationListParams): string {
  const sp = new URLSearchParams()
  if (params.unread) sp.set('unread', '1')
  if (params.kind) sp.set('kind', params.kind)
  if (params.limit) sp.set('limit', String(params.limit))
  const qs = sp.toString()
  return qs ? `?${qs}` : ''
}

export function fetchNotifications(params: NotificationListParams = {}): Promise<NotificationListResponse> {
  return request<NotificationListResponse>(`/api/notifications${buildListQuery(params)}`)
}

export function markNotificationRead(id: string): Promise<NotificationReadResponse> {
  return request<NotificationReadResponse>(`/api/notifications/${id}/read`, { method: 'POST' })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const POLL_MS = 30_000

/**
 * Poll the unread queue for the current user. Optional `kind` filter
 * narrows the feed (wk-today uses `worker_issue_resolved`). 30 s
 * interval matches the rest of the field-event surfaces — short enough
 * to feel live, long enough to keep API load tame on the pilot.
 */
export function useUnreadNotifications(kind?: string, options?: Partial<UseQueryOptions<NotificationListResponse>>) {
  const params: NotificationListParams = { unread: true, ...(kind ? { kind } : {}) }
  return useQuery<NotificationListResponse>({
    queryKey: notificationQueryKeys.list(params),
    queryFn: () => fetchNotifications(params),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    ...options,
  })
}

/**
 * Poll the recipient's full notification feed (read + unread) for the
 * topbar bell panel. Same 30 s cadence as the unread poll; the caller
 * derives the unread-count dot from `read_at == null`.
 */
export function useNotificationFeed(
  params: NotificationListParams = {},
  options?: Partial<UseQueryOptions<NotificationListResponse>>,
) {
  return useQuery<NotificationListResponse>({
    queryKey: notificationQueryKeys.list(params),
    queryFn: () => fetchNotifications(params),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    ...options,
  })
}

/**
 * Mark a single notification read. Invalidates the whole notifications
 * branch on success so any list filter (with or without `kind`) refreshes
 * — the user typically only has one or two screens polling at a time.
 */
export function useMarkNotificationRead() {
  const qc = useQueryClient()
  return useMutation<NotificationReadResponse, Error, string>({
    mutationFn: (id) => markNotificationRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationQueryKeys.all() })
    },
  })
}
