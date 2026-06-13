import { useEffect, useState, type ReactNode } from 'react'
import { MButton, MI } from '@/components/m'
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

  if (!open) return null

  return (
    <MSheet title="Generate payroll export" onClose={onClose}>
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
          <MButton variant="ghost" onClick={onClose} disabled={requestExport.isPending || downloading}>
            {generated ? 'Done' : 'Cancel'}
          </MButton>
          {generated ? (
            <MButton variant="primary" onClick={onDownload} disabled={downloading}>
              {downloading ? 'Downloading…' : 'Download'}
            </MButton>
          ) : (
            <MButton variant="primary" onClick={onGenerate} disabled={requestExport.isPending || !runId}>
              {requestExport.isPending ? 'Generating…' : 'Generate'}
            </MButton>
          )}
        </div>
      </div>
    </MSheet>
  )
}

function MSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 14, 12, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="m-sheet" style={{ maxWidth: 720 }}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              color: 'var(--m-ink)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MI.X size={20} />
          </button>
        </div>
        <div className="m-sheet-body" style={{ padding: '16px 20px' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function formatRunOption(r: LaborPayrollRunRow): string {
  const dollars = Number(r.total_cents) / 100
  return `${r.period_start} → ${r.period_end} · $${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}
