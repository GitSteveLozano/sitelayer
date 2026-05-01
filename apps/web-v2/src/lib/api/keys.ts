// Centralized TanStack Query key factory.
//
// One module so every hook in the app uses the same key shape — makes
// invalidation patterns explicit (e.g. `queryClient.invalidateQueries({
// queryKey: queryKeys.dailyLogs.all() })` after a submit) and prevents
// the "stale cache because the key drifted" class of bug.
//
// Convention: each resource exposes `all()` (root) plus `list(params?)`
// and `detail(id)` factories. Mutations don't get keys; their cache
// effects are expressed as invalidations on the query keys above.

export const queryKeys = {
  clock: {
    all: () => ['clock'] as const,
    timeline: (params?: { workerId?: string; date?: string }) =>
      [...queryKeys.clock.all(), 'timeline', params ?? {}] as const,
  },
  dailyLogs: {
    all: () => ['daily-logs'] as const,
    list: (params?: { projectId?: string; from?: string; to?: string; status?: 'draft' | 'submitted' }) =>
      [...queryKeys.dailyLogs.all(), 'list', params ?? {}] as const,
    detail: (id: string) => [...queryKeys.dailyLogs.all(), 'detail', id] as const,
  },
  timeReviewRuns: {
    all: () => ['time-review-runs'] as const,
    list: (params?: { state?: 'pending' | 'approved' | 'rejected'; projectId?: string; from?: string; to?: string }) =>
      [...queryKeys.timeReviewRuns.all(), 'list', params ?? {}] as const,
    detail: (id: string) => [...queryKeys.timeReviewRuns.all(), 'detail', id] as const,
  },
  push: {
    all: () => ['push'] as const,
    vapidKey: () => [...queryKeys.push.all(), 'vapid-key'] as const,
  },
  notificationPreferences: {
    all: () => ['notification-preferences'] as const,
    current: () => [...queryKeys.notificationPreferences.all(), 'current'] as const,
  },
} as const
