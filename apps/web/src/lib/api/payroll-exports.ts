// Payroll exports — generate + list export files for a payroll run.
//
// Wraps the per-run export routes in apps/api/src/routes/payroll-exports.ts:
//   GET  /api/labor-payroll-runs/:runId/exports
//   POST /api/labor-payroll-runs/:runId/exports          { format }
//   GET  /api/labor-payroll-runs/:runId/exports/:id/download   (streamed bytes)
//
// The export "scope" is a posted/approved payroll run; the bookkeeper
// picks one and requests a format. The POST is role-gated server-side
// to admin / office / bookkeeper.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestBlob } from './client'

export type PayrollExportFormat = 'csv' | 'xlsx' | 'xero_csv' | 'payworks_csv' | 'gusto_csv' | 'adp_csv' | 'json'

export type PayrollExportStatus = 'pending' | 'ready' | 'failed' | 'expired'

export interface PayrollExportRow {
  id: string
  company_id: string
  payroll_run_id: string
  format: PayrollExportFormat
  storage_path: string | null
  download_url: string | null
  presigned_expires_at: string | null
  byte_size: number | null
  row_count: number | null
  status: PayrollExportStatus
  error: string | null
  requested_by_user_id: string | null
  requested_at: string
  completed_at: string | null
  origin: string | null
}

export interface PayrollExportListResponse {
  exports: PayrollExportRow[]
}

// Human labels for the format picker. Order here is the order shown in
// the generate sheet; CSV is the canonical/default.
export const PAYROLL_EXPORT_FORMATS: ReadonlyArray<{ value: PayrollExportFormat; label: string; hint: string }> = [
  { value: 'csv', label: 'Generic CSV', hint: 'Worker, date, project, hours' },
  { value: 'xlsx', label: 'Excel (.xlsx)', hint: 'Same columns, spreadsheet' },
  { value: 'xero_csv', label: 'Xero', hint: 'Pay Items time import' },
  { value: 'gusto_csv', label: 'Gusto', hint: 'Time tracking, OT split' },
  { value: 'adp_csv', label: 'ADP Run', hint: 'Time import, OT split' },
  { value: 'payworks_csv', label: 'Payworks', hint: 'Time import' },
  { value: 'json', label: 'JSON', hint: 'Raw dump for debugging' },
]

const KEYS = {
  all: () => ['payroll-exports'] as const,
  list: (runId: string) => [...KEYS.all(), 'list', runId] as const,
}

export const payrollExportQueryKeys = KEYS

export function fetchPayrollExports(runId: string): Promise<PayrollExportListResponse> {
  return request<PayrollExportListResponse>(`/api/labor-payroll-runs/${encodeURIComponent(runId)}/exports`)
}

/**
 * List the export files already requested for a payroll run, newest
 * first. Gated off an empty runId so the hook is safe to mount before a
 * run is selected.
 */
export function usePayrollExports(runId: string | null | undefined) {
  return useQuery<PayrollExportListResponse>({
    queryKey: KEYS.list(runId ?? ''),
    queryFn: () => fetchPayrollExports(runId!),
    enabled: Boolean(runId),
  })
}

/**
 * Request an export file for a payroll run. The server de-dupes against
 * a pending/ready row for the same (run, format) within the last hour,
 * so re-requesting the same format is idempotent.
 */
export function useRequestPayrollExport(runId: string) {
  const qc = useQueryClient()
  return useMutation<PayrollExportRow, Error, { format: PayrollExportFormat }>({
    mutationFn: (input) =>
      request<PayrollExportRow>(`/api/labor-payroll-runs/${encodeURIComponent(runId)}/exports`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.list(runId) }),
  })
}

/**
 * Path of the download endpoint. The endpoint streams the rendered bytes
 * back with a Content-Disposition filename. It still requires the
 * Sitelayer company + auth headers, so a bare window.open() against the
 * API origin would not authenticate — prefer `downloadPayrollExport`,
 * which fetches through the authenticated blob path.
 */
export function payrollExportDownloadPath(runId: string, exportId: string): string {
  return `/api/labor-payroll-runs/${encodeURIComponent(runId)}/exports/${encodeURIComponent(exportId)}/download`
}

/**
 * Fetch a rendered export through the authenticated blob path and trigger
 * a browser download via a transient object URL. Returns once the click
 * has been dispatched; the object URL is revoked on the next tick.
 */
export async function downloadPayrollExport(
  runId: string,
  exportId: string,
  opts: { filename?: string } = {},
): Promise<void> {
  const blob = await requestBlob(payrollExportDownloadPath(runId, exportId))
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  if (opts.filename) anchor.download = opts.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
