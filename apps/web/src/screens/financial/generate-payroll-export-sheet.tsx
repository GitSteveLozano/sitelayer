import { useEffect, useState } from 'react'
import { MobileButton, Sheet } from '@/components/mobile'
import {
  downloadPayrollExport,
  useRequestPayrollExport,
  PAYROLL_EXPORT_FORMATS,
  type LaborPayrollRunRow,
  type PayrollExportFormat,
  type PayrollExportRow,
} from '@/lib/api'

export interface GeneratePayrollExportSheetProps {
  open: boolean
  onClose: () => void
  /** Runs whose hours are locked and so are worth exporting. */
  runs: LaborPayrollRunRow[]
  /** Pre-select a run (used when opened from a run's detail screen). */
  defaultRunId?: string
}

/**
 * Bottom sheet to generate a payroll export. Pick a run (the scope) and a
 * format, POST to request the file, then download it. The server de-dupes
 * a (run, format) request within the hour, so re-generating is safe.
 */
export function GeneratePayrollExportSheet({ open, onClose, runs, defaultRunId }: GeneratePayrollExportSheetProps) {
  const [runId, setRunId] = useState(defaultRunId ?? '')
  const [format, setFormat] = useState<PayrollExportFormat>('csv')
  const [error, setError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<PayrollExportRow | null>(null)
  const [downloading, setDownloading] = useState(false)

  // The mutation is keyed by runId; re-create it when the selection
  // changes so the cache invalidation hits the right run's export list.
  const requestExport = useRequestPayrollExport(runId)

  // Reset to the defaults each time the sheet opens — a fresh task, not a
  // resumed one.
  useEffect(() => {
    if (!open) return
    setRunId(defaultRunId ?? '')
    setFormat('csv')
    setError(null)
    setGenerated(null)
    setDownloading(false)
  }, [open, defaultRunId])

  const selectedRun = runs.find((r) => r.id === runId) ?? null

  const onGenerate = async () => {
    setError(null)
    if (!runId) {
      setError('Pick a payroll run')
      return
    }
    try {
      const row = await requestExport.mutateAsync({ format })
      setGenerated(row)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generate failed')
    }
  }

  const onDownload = async () => {
    if (!generated) return
    setDownloading(true)
    setError(null)
    try {
      const run = selectedRun
      const stem = run ? `payroll-${run.period_start}-to-${run.period_end}` : `payroll-${generated.payroll_run_id}`
      const ext = generated.format === 'json' ? 'json' : generated.format === 'xlsx' ? 'xlsx' : 'csv'
      await downloadPayrollExport(generated.payroll_run_id, generated.id, { filename: `${stem}.${ext}` })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Generate payroll export">
      <div className="space-y-4">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
            Payroll run
          </label>
          {runs.length === 0 ? (
            <div className="text-[12px] text-ink-3 px-1">
              No approved or posted runs to export. Approve a run from Labor payroll runs first.
            </div>
          ) : (
            <select
              value={runId}
              onChange={(e) => {
                setRunId(e.target.value)
                setGenerated(null)
              }}
              className="w-full p-3 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
            >
              <option value="">Select…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {formatRunOption(r)}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
            Format
          </label>
          <select
            value={format}
            onChange={(e) => {
              setFormat(e.target.value as PayrollExportFormat)
              setGenerated(null)
            }}
            className="w-full p-3 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
          >
            {PAYROLL_EXPORT_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} — {f.hint}
              </option>
            ))}
          </select>
        </div>

        {generated ? (
          <div className="rounded border border-line-2 bg-card-soft p-3">
            <div className="text-[12px] text-ink-2">
              Export ready. Download it to import into your payroll provider.
            </div>
          </div>
        ) : null}

        {error ? <div className="text-[12px] text-bad px-1">{error}</div> : null}

        <div className="flex gap-2 pt-2">
          <MobileButton variant="ghost" onClick={onClose} disabled={requestExport.isPending || downloading}>
            {generated ? 'Done' : 'Cancel'}
          </MobileButton>
          {generated ? (
            <MobileButton variant="primary" onClick={onDownload} disabled={downloading}>
              {downloading ? 'Downloading…' : 'Download'}
            </MobileButton>
          ) : (
            <MobileButton variant="primary" onClick={onGenerate} disabled={requestExport.isPending || !runId}>
              {requestExport.isPending ? 'Generating…' : 'Generate'}
            </MobileButton>
          )}
        </div>
      </div>
    </Sheet>
  )
}

function formatRunOption(r: LaborPayrollRunRow): string {
  const dollars = Number(r.total_cents) / 100
  return `${r.period_start} → ${r.period_end} · $${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}
