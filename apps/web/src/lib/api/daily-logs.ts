// Daily logs — types, request functions, and TanStack hooks.
// Wraps apps/api/src/routes/daily-logs.ts.
//
// Offline-queue policy for this resource:
//   - create / patch / submit are wrapped in liveOrQueue* helpers so a
//     NetworkError (offline, API unreachable, transient blip) enqueues
//     the call into IndexedDB instead of throwing. The mutation
//     resolves with `{ queued: true }` so the UI can show a "queued"
//     toast and stay responsive — daily logs are field-foreman work,
//     not office work, and double-tap retries on flaky LTE were
//     creating duplicate submissions before this wrapper landed.
//   - photo upload / delete are NOT wrapped here. Photos are already
//     enqueued via a dedicated `daily_log_photo_upload` kind from the
//     consumer side when needed (composer screens), and the multipart
//     upload helper has its own response handling that doesn't map
//     cleanly onto a synthetic queued response.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { ApiError, API_URL, NetworkError, buildAuthHeaders, request } from './client'
import { queryKeys } from './keys'

export type DailyLogStatus = 'draft' | 'submitted'

export interface DailyLog {
  id: string
  company_id: string
  project_id: string
  occurred_on: string
  foreman_user_id: string
  scope_progress: unknown
  weather: unknown
  notes: string | null
  schedule_deviations: unknown
  crew_summary: unknown
  photo_keys: string[]
  status: DailyLogStatus
  submitted_at: string | null
  origin: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface DailyLogListParams {
  projectId?: string
  /** YYYY-MM-DD */
  from?: string
  /** YYYY-MM-DD */
  to?: string
  status?: DailyLogStatus
}

export interface DailyLogListResponse {
  dailyLogs: DailyLog[]
}

export interface DailyLogDetailResponse {
  dailyLog: DailyLog
}

export interface DailyLogCreateRequest {
  project_id: string
  /** Defaults to today on the server when omitted. */
  occurred_on?: string
}

export interface DailyLogPatchRequest {
  expected_version?: number
  scope_progress?: unknown
  weather?: unknown
  notes?: string | null
  schedule_deviations?: unknown
  crew_summary?: unknown
  photo_keys?: string[]
}

export interface DailyLogSubmitRequest {
  expected_version?: number
}

// ---------------------------------------------------------------------------
// Request functions
// ---------------------------------------------------------------------------

export function fetchDailyLogs(params: DailyLogListParams = {}): Promise<DailyLogListResponse> {
  const search = new URLSearchParams()
  if (params.projectId) search.set('project_id', params.projectId)
  if (params.from) search.set('from', params.from)
  if (params.to) search.set('to', params.to)
  if (params.status) search.set('status', params.status)
  const qs = search.toString()
  return request<DailyLogListResponse>(`/api/daily-logs${qs ? `?${qs}` : ''}`)
}

export function fetchDailyLog(id: string): Promise<DailyLogDetailResponse> {
  return request<DailyLogDetailResponse>(`/api/daily-logs/${encodeURIComponent(id)}`)
}

export function createDailyLog(input: DailyLogCreateRequest): Promise<DailyLogDetailResponse> {
  return request<DailyLogDetailResponse>('/api/daily-logs', { method: 'POST', json: input })
}

export function patchDailyLog(id: string, input: DailyLogPatchRequest): Promise<DailyLogDetailResponse> {
  return request<DailyLogDetailResponse>(`/api/daily-logs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: input,
  })
}

export function submitDailyLog(id: string, input: DailyLogSubmitRequest = {}): Promise<DailyLogDetailResponse> {
  return request<DailyLogDetailResponse>(`/api/daily-logs/${encodeURIComponent(id)}/submit`, {
    method: 'POST',
    json: input,
  })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useDailyLogs(
  params: DailyLogListParams = {},
  options?: Partial<UseQueryOptions<DailyLogListResponse>>,
) {
  return useQuery<DailyLogListResponse>({
    queryKey: queryKeys.dailyLogs.list(params),
    queryFn: () => fetchDailyLogs(params),
    ...options,
  })
}

export function useDailyLog(id: string | null | undefined, options?: Partial<UseQueryOptions<DailyLogDetailResponse>>) {
  return useQuery<DailyLogDetailResponse>({
    queryKey: queryKeys.dailyLogs.detail(id ?? ''),
    queryFn: () => fetchDailyLog(id!),
    enabled: Boolean(id),
    ...options,
  })
}

/**
 * Synthetic response returned when a mutation was enqueued for offline
 * replay instead of running live. The UI branches on `queued` to swap
 * the success toast for a "queued for sync" affordance and to skip the
 * cache write that would otherwise need a real `DailyLog`.
 */
export type DailyLogQueuedResponse = { queued: true }

export type DailyLogMutationResult = DailyLogDetailResponse | DailyLogQueuedResponse

async function liveOrQueueCreateDailyLog(input: DailyLogCreateRequest): Promise<DailyLogMutationResult> {
  try {
    return await createDailyLog(input)
  } catch (err) {
    if (err instanceof NetworkError) {
      const { enqueueOfflineMutation } = await import('@/lib/offline/queue')
      await enqueueOfflineMutation('daily_log_create', { input: { ...input } })
      return { queued: true }
    }
    throw err
  }
}

async function liveOrQueuePatchDailyLog(id: string, input: DailyLogPatchRequest): Promise<DailyLogMutationResult> {
  try {
    return await patchDailyLog(id, input)
  } catch (err) {
    if (err instanceof NetworkError) {
      const { enqueueOfflineMutation } = await import('@/lib/offline/queue')
      await enqueueOfflineMutation('daily_log_patch', { id, input: { ...input } })
      return { queued: true }
    }
    throw err
  }
}

async function liveOrQueueSubmitDailyLog(id: string, input: DailyLogSubmitRequest): Promise<DailyLogMutationResult> {
  try {
    return await submitDailyLog(id, input)
  } catch (err) {
    if (err instanceof NetworkError) {
      const { enqueueOfflineMutation } = await import('@/lib/offline/queue')
      await enqueueOfflineMutation('daily_log_submit', { id, input: { ...input } })
      return { queued: true }
    }
    throw err
  }
}

export function useCreateDailyLog() {
  const qc = useQueryClient()
  return useMutation<DailyLogMutationResult, Error, DailyLogCreateRequest>({
    mutationFn: liveOrQueueCreateDailyLog,
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      if (!('queued' in data)) {
        qc.setQueryData(queryKeys.dailyLogs.detail(data.dailyLog.id), data)
      }
    },
  })
}

export function usePatchDailyLog(id: string) {
  const qc = useQueryClient()
  return useMutation<DailyLogMutationResult, Error, DailyLogPatchRequest>({
    mutationFn: (input) => liveOrQueuePatchDailyLog(id, input),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      if (!('queued' in data)) {
        qc.setQueryData(queryKeys.dailyLogs.detail(id), data)
      }
    },
  })
}

export function useSubmitDailyLog(id: string) {
  const qc = useQueryClient()
  return useMutation<DailyLogMutationResult, Error, DailyLogSubmitRequest | void>({
    mutationFn: (input) => liveOrQueueSubmitDailyLog(id, input ?? {}),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      if (!('queued' in data)) {
        qc.setQueryData(queryKeys.dailyLogs.detail(id), data)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Photo upload / delete / fetch
// ---------------------------------------------------------------------------

export interface DailyLogPhotoMetadata {
  id: string
  storage_key: string
  scope_step_id: string | null
  scope_step_label: string | null
  captured_at: string
}

export interface DailyLogPhotoListResponse {
  photos: DailyLogPhotoMetadata[]
}

export interface DailyLogPhotoUploadOptions {
  /** Optional scope-step id captured from the worker chip row. */
  scope_step_id?: string | null
  /** Denormalized step label (so the timeline keeps rendering after edits). */
  scope_step_label?: string | null
}

export interface DailyLogPhotoUploadResponse {
  dailyLog: DailyLog
  photo: {
    key: string
    fileName: string
    mimeType: string
    bytes: number
    scope_step_id: string | null
    scope_step_label: string | null
    captured_at: string | null
  }
}

/**
 * Upload one photo. Mirrors the multipart blueprint upload — FormData
 * for the file, the standard auth headers from buildAuthHeaders.
 * Browser sets the multipart boundary on content-type; we don't.
 */
export async function uploadDailyLogPhoto(
  id: string,
  file: File,
  options: DailyLogPhotoUploadOptions = {},
): Promise<DailyLogPhotoUploadResponse> {
  const formData = new FormData()
  formData.append('photo_file', file, file.name || 'photo.jpg')
  if (options.scope_step_id) formData.append('scope_step_id', options.scope_step_id)
  if (options.scope_step_label) formData.append('scope_step_label', options.scope_step_label)
  const headers = await buildAuthHeaders()
  const path = `/api/daily-logs/${encodeURIComponent(id)}/photos`

  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id')
    let body: unknown
    try {
      const ct = response.headers.get('content-type') ?? ''
      body = ct.includes('application/json') ? await response.json() : await response.text()
    } catch {
      body = null
    }
    throw new ApiError({ status: response.status, path, method: 'POST', requestId, body })
  }
  return (await response.json()) as DailyLogPhotoUploadResponse
}

/** Delete a photo by storage key. */
export async function deleteDailyLogPhoto(id: string, key: string): Promise<DailyLogDetailResponse> {
  return request<DailyLogDetailResponse>(`/api/daily-logs/${encodeURIComponent(id)}/photos`, {
    method: 'DELETE',
    json: { key },
  })
}

/** List per-photo metadata for the timeline view (`fm-log` PhotoTimeline). */
export function fetchDailyLogPhotos(id: string): Promise<DailyLogPhotoListResponse> {
  return request<DailyLogPhotoListResponse>(`/api/daily-logs/${encodeURIComponent(id)}/photos`)
}

/** Build the GET URL for a daily-log photo. The endpoint either streams
 * bytes back or 302s to a presigned URL — `<img src>` follows both. */
export function dailyLogPhotoUrl(id: string, key: string): string {
  return `${API_URL}/api/daily-logs/${encodeURIComponent(id)}/photos/file?key=${encodeURIComponent(key)}`
}

export interface UseUploadDailyLogPhotoInput {
  file: File
  scope_step_id?: string | null
  scope_step_label?: string | null
}

export function useUploadDailyLogPhoto(id: string) {
  const qc = useQueryClient()
  return useMutation<DailyLogPhotoUploadResponse, Error, File | UseUploadDailyLogPhotoInput>({
    mutationFn: (input) => {
      if (input instanceof File) return uploadDailyLogPhoto(id, input)
      return uploadDailyLogPhoto(id, input.file, {
        scope_step_id: input.scope_step_id ?? null,
        scope_step_label: input.scope_step_label ?? null,
      })
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      qc.setQueryData(queryKeys.dailyLogs.detail(id), { dailyLog: data.dailyLog })
    },
  })
}

export function useDailyLogPhotos(
  id: string | null | undefined,
  options?: Partial<UseQueryOptions<DailyLogPhotoListResponse>>,
) {
  return useQuery<DailyLogPhotoListResponse>({
    queryKey: [...queryKeys.dailyLogs.all(), 'photos', id ?? ''],
    queryFn: () => fetchDailyLogPhotos(id!),
    enabled: Boolean(id),
    ...options,
  })
}

export function useDeleteDailyLogPhoto(id: string) {
  const qc = useQueryClient()
  return useMutation<DailyLogDetailResponse, Error, string>({
    mutationFn: (key) => deleteDailyLogPhoto(id, key),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      qc.setQueryData(queryKeys.dailyLogs.detail(id), data)
    },
  })
}
