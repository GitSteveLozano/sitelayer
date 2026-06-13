import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { MButton, MPill, type MTone } from '@/components/m'
import {
  downloadPayrollExport,
  useLaborPayrollRun,
  usePayrollExports,
  PAYROLL_EXPORT_FORMATS,
  type LaborPayrollRunRow,
  type PayrollExportRow,
  type PayrollExportStatus,
} from '@/lib/api'
import { GeneratePayrollExportSheet } from './generate-payroll-export-sheet'

const STATUS_TONE: Record<PayrollExportStatus, MTone | undefined> = {
  pending: 'amber',
  ready: 'green',
  failed: 'red',
  expired: undefined,
}

const FORMAT_LABEL: Record<string, string> = Object.fromEntries(PAYROLL_EXPORT_FORMATS.map((f) => [f.value, f.label]))

/**
 * Export history for one payroll run. Lists the files already requested
 * (newest first) with a download for each, and re-opens the generate
 * sheet pre-scoped to this run. Exports are keyed to the labor payroll
 * run, so the period/total here is the run's.
 */
export function PayrollExportDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const runId = id ?? ''
  const [sheetOpen, setSheetOpen] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runQuery = useLaborPayrollRun(runId || null)
  const exportsQuery = usePayrollExports(runId || null)

  const ctx = runQuery.data?.context
  const exports = exportsQuery.data?.exports ?? []

  // The generate sheet wants the run-row shape (LaborPayrollRunRow). The
  // detail snapshot carries the same period/total fields, so adapt the
  // single run into a one-item list for the sheet's picker.
  const sheetRuns: LaborPayrollRunRow[] = ctx
    ? [
        {
          id: ctx.id,
          company_id: ctx.company_id,
          period_start: ctx.period_start,
          period_end: ctx.period_end,
          state: runQuery.data!.state,
          state_version: runQuery.data!.state_version,
          approved_at: ctx.approved_at,
          approved_by_user_id: ctx.approved_by_user_id,
          posted_at: ctx.posted_at,
          failed_at: ctx.failed_at,
          error_message: ctx.error_message,
          qbo_payroll_batch_ref: ctx.qbo_payroll_batch_ref,
          covered_labor_entry_ids: ctx.covered_labor_entry_ids,
          total_hours: ctx.total_hours,
          total_cents: ctx.total_cents,
          time_review_run_id: ctx.time_review_run_id,
          workflow_engine: ctx.workflow_engine,
          workflow_run_id: ctx.workflow_run_id,
          version: runQuery.data!.state_version,
          origin: null,
          deleted_at: null,
          created_at: ctx.created_at,
          updated_at: ctx.updated_at,
        },
      ]
    : []

  const onDownload = async (row: PayrollExportRow) => {
    setDownloadingId(row.id)
    setError(null)
    try {
      const stem = ctx ? `payroll-${ctx.period_start}-to-${ctx.period_end}` : `payroll-${row.payroll_run_id}`
      const ext = row.format === 'json' ? 'json' : row.format === 'xlsx' ? 'xlsx' : 'csv'
      await downloadPayrollExport(row.payroll_run_id, row.id, { filename: `${stem}.${ext}` })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloadingId(null)
    }
  }

  if (!id) {
    return (
      <div className="px-5 pt-8">
        <Link to="/financial/payroll-exports" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  const dollars = ctx ? Number(ctx.total_cents) / 100 : 0

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial/payroll-exports" className="text-[12px] text-ink-3">
        ← Payroll exports
      </Link>

      {runQuery.isPending ? (
        <div className="mt-4 text-[13px] text-ink-3">Loading run…</div>
      ) : !ctx ? (
        <div className="mt-4">
          <h1 className="font-display text-[22px] font-bold tracking-tight">Run not found</h1>
        </div>
      ) : (
        <>
          <h1 className="mt-2 font-display text-[22px] font-bold tracking-tight leading-tight">
            ${dollars.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </h1>
          <div className="text-[11px] text-ink-3 mt-1">
            {ctx.period_start} → {ctx.period_end} · {Number(ctx.total_hours).toFixed(1)}h ·{' '}
            {ctx.covered_labor_entry_ids?.length ?? 0} entries
          </div>

          <div className="mt-4">
            <MButton variant="primary" onClick={() => setSheetOpen(true)}>
              Generate export
            </MButton>
          </div>

          {error ? <div className="mt-3 text-[12px] text-bad">{error}</div> : null}

          <div className="mt-6 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Files</div>
          <div className="mt-2 space-y-2">
            {exportsQuery.isPending ? (
              <div className="m-card m-card-tight">
                <div className="text-[12px] text-ink-3">Loading…</div>
              </div>
            ) : exports.length === 0 ? (
              <div className="m-card m-card-tight">
                <div className="text-[12px] text-ink-3">No exports yet. Generate one above.</div>
              </div>
            ) : (
              exports.map((row) => (
                <div key={row.id} className="m-card m-card-tight">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">{FORMAT_LABEL[row.format] ?? row.format}</div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {new Date(row.requested_at).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                        {row.row_count != null ? ` · ${row.row_count} rows` : ''}
                      </div>
                      {row.error ? <div className="text-[11px] text-bad mt-1">{row.error}</div> : null}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <MPill tone={STATUS_TONE[row.status]}>{row.status}</MPill>
                      {row.status === 'ready' ? (
                        <MButton
                          size="sm"
                          variant="ghost"
                          onClick={() => onDownload(row)}
                          disabled={downloadingId === row.id}
                        >
                          {downloadingId === row.id ? '…' : 'Download'}
                        </MButton>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <GeneratePayrollExportSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            runs={sheetRuns}
            defaultRunId={ctx.id}
          />
        </>
      )}
    </div>
  )
}
