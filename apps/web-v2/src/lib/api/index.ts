// Public re-exports for the API layer.
//
// Screens import from '@/lib/api' rather than the per-resource modules so
// the directory layout can evolve without rippling through every caller.

export {
  ApiError,
  API_URL,
  NetworkError,
  getActiveCompanySlug,
  registerTokenProvider,
  request,
  setActiveCompanySlug,
  type RequestOptions,
  type TokenProvider,
} from './client'

export { queryKeys } from './keys'

export {
  clockIn,
  clockOut,
  fetchClockTimeline,
  useClockIn,
  useClockOut,
  useClockTimeline,
  useVoidClockEvent,
  voidClockEvent,
  type ClockEvent,
  type ClockEventSource,
  type ClockEventType,
  type ClockEventVoidRequest,
  type ClockEventVoidResponse,
  type ClockInRequest,
  type ClockInResponse,
  type ClockOutRequest,
  type ClockOutResponse,
  type ClockTimelineParams,
  type ClockTimelineResponse,
} from './clock'

export {
  createDailyLog,
  fetchDailyLog,
  fetchDailyLogs,
  patchDailyLog,
  submitDailyLog,
  useCreateDailyLog,
  useDailyLog,
  useDailyLogs,
  usePatchDailyLog,
  useSubmitDailyLog,
  type DailyLog,
  type DailyLogCreateRequest,
  type DailyLogDetailResponse,
  type DailyLogListParams,
  type DailyLogListResponse,
  type DailyLogPatchRequest,
  type DailyLogStatus,
  type DailyLogSubmitRequest,
} from './daily-logs'

export {
  createTimeReviewRun,
  dispatchTimeReviewEvent,
  fetchTimeReviewRun,
  fetchTimeReviewRuns,
  useCreateTimeReviewRun,
  useDispatchTimeReviewEvent,
  useTimeReviewRun,
  useTimeReviewRuns,
  type TimeReviewCreateRequest,
  type TimeReviewEventRequest,
  type TimeReviewHumanEvent,
  type TimeReviewListParams,
  type TimeReviewListResponse,
  type TimeReviewRunRow,
  type TimeReviewSnapshot,
  type TimeReviewState,
} from './time-review'

export {
  fetchVapidPublicKey,
  subscribePush,
  unsubscribePush,
  useSubscribePush,
  useUnsubscribePush,
  useVapidPublicKey,
  type PushSubscriptionRow,
  type SubscribeRequest,
  type SubscribeResponse,
  type VapidPublicKeyResponse,
} from './push'

export {
  fetchNotificationPreferences,
  updateNotificationPreferences,
  useNotificationPreferences,
  useUpdateNotificationPreferences,
  type NotificationChannel,
  type NotificationPreferences,
  type NotificationPreferencesResponse,
  type UpdateNotificationPreferencesRequest,
} from './prefs'

export {
  createWorker,
  fetchWorkers,
  useCreateWorker,
  useWorkers,
  workerQueryKeys,
  type Worker,
  type WorkerCreateRequest,
  type WorkerListResponse,
} from './workers'
