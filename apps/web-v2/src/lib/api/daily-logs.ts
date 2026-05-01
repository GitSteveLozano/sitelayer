// Daily logs — types, request functions, and TanStack hooks.
// Wraps apps/api/src/routes/daily-logs.ts.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { ApiError, API_URL, buildAuthHeaders, request } from './client'
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

export function useDailyLogs(params: DailyLogListParams = {}, options?: Partial<UseQueryOptions<DailyLogListResponse>>) {
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

export function useCreateDailyLog() {
  const qc = useQueryClient()
  return useMutation<DailyLogDetailResponse, Error, DailyLogCreateRequest>({
    mutationFn: (input) => createDailyLog(input),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      qc.setQueryData(queryKeys.dailyLogs.detail(data.dailyLog.id), data)
    },
  })
}

export function usePatchDailyLog(id: string) {
  const qc = useQueryClient()
  return useMutation<DailyLogDetailResponse, Error, DailyLogPatchRequest>({
    mutationFn: (input) => patchDailyLog(id, input),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      qc.setQueryData(queryKeys.dailyLogs.detail(id), data)
    },
  })
}

export function useSubmitDailyLog(id: string) {
  const qc = useQueryClient()
  return useMutation<DailyLogDetailResponse, Error, DailyLogSubmitRequest | void>({
    mutationFn: (input) => submitDailyLog(id, input ?? {}),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      qc.setQueryData(queryKeys.dailyLogs.detail(id), data)
    },
  })
}

// ---------------------------------------------------------------------------
// Photo upload / delete / fetch
// ---------------------------------------------------------------------------

export interface DailyLogPhotoUploadResponse {
  dailyLog: DailyLog
  photo: { key: string; fileName: string; mimeType: string; bytes: number }
}

/**
 * Upload one photo. Mirrors the multipart blueprint upload — FormData
 * for the file, the standard auth headers from buildAuthHeaders.
 * Browser sets the multipart boundary on content-type; we don't.
 */
export async function uploadDailyLogPhoto(id: string, file: File): Promise<DailyLogPhotoUploadResponse> {
  const formData = new FormData()
  formData.append('photo_file', file, file.name || 'photo.jpg')
  const headers = await buildAuthHeaders()
  const path = `/api/daily-logs/${encodeURIComponent(id)}/photos`

  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id')
    let body: unknown = null
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

/** Build the GET URL for a daily-log photo. The endpoint either streams
 * bytes back or 302s to a presigned URL — `<img src>` follows both. */
export function dailyLogPhotoUrl(id: string, key: string): string {
  return `${API_URL}/api/daily-logs/${encodeURIComponent(id)}/photos/file?key=${encodeURIComponent(key)}`
}

export function useUploadDailyLogPhoto(id: string) {
  const qc = useQueryClient()
  return useMutation<DailyLogPhotoUploadResponse, Error, File>({
    mutationFn: (file) => uploadDailyLogPhoto(id, file),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all() })
      qc.setQueryData(queryKeys.dailyLogs.detail(id), { dailyLog: data.dailyLog })
    },
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

