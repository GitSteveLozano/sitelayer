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
  dailyLogPhotoUrl,
  deleteDailyLogPhoto,
  fetchDailyLog,
  fetchDailyLogs,
  patchDailyLog,
  submitDailyLog,
  uploadDailyLogPhoto,
  useCreateDailyLog,
  useDailyLog,
  useDailyLogs,
  useDeleteDailyLogPhoto,
  usePatchDailyLog,
  useSubmitDailyLog,
  useUploadDailyLogPhoto,
  type DailyLog,
  type DailyLogCreateRequest,
  type DailyLogDetailResponse,
  type DailyLogListParams,
  type DailyLogListResponse,
  type DailyLogPatchRequest,
  type DailyLogPhotoUploadResponse,
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
  useDeleteWorker,
  usePatchWorker,
  useWorkers,
  workerQueryKeys,
  type Worker,
  type WorkerCreateRequest,
  type WorkerListResponse,
  type WorkerPatchRequest,
} from './workers'

export {
  customerQueryKeys,
  fetchCustomers,
  useCreateCustomer,
  useCustomers,
  useDeleteCustomer,
  usePatchCustomer,
  type Customer,
  type CustomerCreateRequest,
  type CustomerListResponse,
  type CustomerPatchRequest,
} from './customers'

export { divisionQueryKeys, fetchDivisions, useDivisions, type Division, type DivisionListResponse } from './divisions'

export {
  fetchServiceItems,
  serviceItemQueryKeys,
  useCreateServiceItem,
  useDeleteServiceItem,
  usePatchServiceItem,
  useServiceItems,
  type ServiceItem,
  type ServiceItemCreateRequest,
  type ServiceItemListResponse,
  type ServiceItemPatchRequest,
} from './service-items'

export {
  fetchPricingProfiles,
  pricingProfileQueryKeys,
  useCreatePricingProfile,
  useDeletePricingProfile,
  usePatchPricingProfile,
  usePricingProfiles,
  type PricingProfile,
  type PricingProfileCreateRequest,
  type PricingProfileListResponse,
  type PricingProfilePatchRequest,
} from './pricing-profiles'

export {
  bonusRuleQueryKeys,
  fetchBonusRules,
  useBonusRules,
  useCreateBonusRule,
  useDeleteBonusRule,
  usePatchBonusRule,
  type BonusRule,
  type BonusRuleCreateRequest,
  type BonusRuleListResponse,
  type BonusRulePatchRequest,
} from './bonus-rules'

export {
  estimatePushQueryKeys,
  fetchEstimatePush,
  fetchEstimatePushes,
  useDispatchEstimatePushEvent,
  useEstimatePush,
  useEstimatePushes,
  type EstimatePushHumanEvent,
  type EstimatePushLine,
  type EstimatePushListParams,
  type EstimatePushListResponse,
  type EstimatePushRow,
  type EstimatePushSnapshot,
  type EstimatePushState,
} from './estimate-pushes'

export {
  billingRunQueryKeys,
  fetchBillingRun,
  fetchBillingRuns,
  useBillingRun,
  useBillingRuns,
  useDispatchBillingRunEvent,
  type BillingRunListParams,
  type BillingRunListResponse,
  type RentalBillingHumanEvent,
  type RentalBillingRunLine,
  type RentalBillingRunRow,
  type RentalBillingSnapshot,
  type RentalBillingState,
} from './billing-runs'

export {
  fetchSchedules,
  scheduleQueryKeys,
  useSchedules,
  type CrewScheduleRow,
  type ScheduleListParams,
  type ScheduleListResponse,
} from './schedules'

export {
  fetchLaborBurdenToday,
  laborBurdenQueryKeys,
  useLaborBurdenToday,
  type LaborBurdenParams,
  type LaborBurdenSummaryResponse,
  type LaborBurdenWorkerResult,
} from './labor-burden'

export {
  fetchProject,
  fetchProjects,
  projectQueryKeys,
  useProject,
  useProjects,
  type ProjectDetail,
  type ProjectDetailResponse,
  type ProjectListParams,
  type ProjectListResponse,
  type ProjectListRow,
  type ProjectStatus,
} from './projects'

export {
  estimatePdfUrl,
  estimateQueryKeys,
  fetchScopeVsBid,
  useScopeVsBid,
  type BidVsScopeStatus,
  type EstimateLine,
  type ScopeVsBidResponse,
} from './estimate'

export {
  useAddAssemblyComponent,
  useAddTakeoffTag,
  useAssemblies,
  useAssembly,
  useBlueprintPages,
  useCalibratePage,
  useCreateAssembly,
  useImportTakeoff,
  useQboCustomFields,
  useRemoveTakeoffTag,
  useTakeoffTags,
  useUpsertQboCustomField,
  type Assembly,
  type AssemblyComponent,
  type BlueprintPage,
  type ImportRow,
  type QboCustomFieldMapping,
  type TakeoffTag,
} from './takeoff'

export {
  useAiInsights,
  useApplyInsight,
  useBidAccuracy,
  useDismissInsight,
  useTriggerBidFollowUp,
  useTriggerTakeoffToBid,
  useTriggerVoiceToLog,
  type AccuracyConfidence,
  type AiInsight,
  type BidAccuracyProject,
  type BidAccuracySummary,
  type BidFollowUpDraft,
  type InsightListParams,
  type TakeoffToBidPayload,
  type TakeoffToBidProposal,
  type VoiceToLogProposal,
} from './ai'

export {
  useDispatchMovement,
  useInventoryItems,
  useInventoryLocations,
  useInventoryMovements,
  useInventoryUtilization,
  useProjectRentalContracts,
  type InventoryItem,
  type InventoryLocation,
  type InventoryMovement,
  type JobRentalContract,
  type MovementListParams,
  type ScanDispatchInput,
  type UtilizationRow,
  type UtilizationTotals,
} from './rentals'
