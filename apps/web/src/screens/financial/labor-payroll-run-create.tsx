import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { MButton } from '@/components/m'
import { Attribution } from '@/components/ai'
import { getActiveCompanySlug } from '@/lib/api/client'
import { laborPayrollRunQueryKeys } from '@/lib/api'
import { useLaborPayrollEntry } from '@/machines/labor-payroll-entry'

/**
 * Create a labor payroll run from a pay period.
 *
 * Multi-step entry flow owned by the `laborPayrollEntry` XState machine:
 * pick a period → preview coverage → create the run. The screen renders
 * the machine's snapshot verbatim (preview payload, loading/error flags)
 * and navigates to the run detail (owned by the `laborPayroll` machine)
 * once `created`.
 */
export function LaborPayrollRunCreateScreen() {
  const companySlug = getActiveCompanySlug()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const entry = useLaborPayrollEntry(companySlug)
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')

  // On created, invalidate the list cache and navigate to the new run.
  useEffect(() => {
    if (entry.state === 'created' && entry.createdRunId) {
      void qc.invalidateQueries({ queryKey: laborPayrollRunQueryKeys.all() })
      navigate(`/financial/labor-payroll-runs/${entry.createdRunId}`)
    }
  }, [entry.state, entry.createdRunId, navigate, qc])

  const preview = entry.preview
  const previewDollars = preview ? Number(preview.total_cents) / 100 : 0

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial/labor-payroll-runs" className="text-[12px] text-ink-3">
        ← Labor payroll runs
      </Link>
      <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">New payroll run</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        Preview the labor entries an approved time review locked for a pay period, then create the run.
      </p>

      {entry.error ? (
        <div className="m-card m-card-tight mt-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">Error</div>
              <div className="text-[12px] text-ink-2 mt-1">{entry.error}</div>
              {entry.existingRunId ? (
                <Link
                  to={`/financial/labor-payroll-runs/${entry.existingRunId}`}
                  className="text-[12px] text-accent font-medium mt-1 inline-block"
                >
                  Go to existing run →
                </Link>
              ) : null}
            </div>
            <button type="button" onClick={entry.dismissError} className="text-[11px] text-ink-3 underline">
              dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Pay period</div>
        <div className="m-card m-card-tight">
          <label className="flex items-center justify-between text-[12px] py-1.5 gap-3">
            <span className="text-ink-3">Period start</span>
            <input
              type="date"
              value={periodStart}
              onChange={(e) => {
                setPeriodStart(e.target.value)
                entry.setPeriod(e.target.value, periodEnd)
              }}
              className="bg-card-soft border border-line rounded-md px-2 py-1 text-ink-2"
            />
          </label>
          <label className="flex items-center justify-between text-[12px] py-1.5 gap-3">
            <span className="text-ink-3">Period end</span>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => {
                setPeriodEnd(e.target.value)
                entry.setPeriod(periodStart, e.target.value)
              }}
              className="bg-card-soft border border-line rounded-md px-2 py-1 text-ink-2"
            />
          </label>
        </div>
        <MButton variant="ghost" disabled={!periodStart || !periodEnd || entry.isPreviewing} onClick={entry.runPreview}>
          {entry.isPreviewing ? 'Previewing…' : 'Preview coverage'}
        </MButton>
      </div>

      {preview ? (
        <div className="mt-4 space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Coverage</div>
          <div className="m-card m-card-tight">
            <div className="flex items-center justify-between text-[12px] py-1">
              <div className="text-ink-3">Labor entries</div>
              <div className="text-ink-2 num">{preview.total_entries}</div>
            </div>
            <div className="flex items-center justify-between text-[12px] py-1">
              <div className="text-ink-3">Total hours</div>
              <div className="text-ink-2 num">{Number(preview.total_hours).toFixed(1)}h</div>
            </div>
            <div className="flex items-center justify-between text-[12px] py-1">
              <div className="text-ink-3">Total</div>
              <div className="text-ink-2 num">
                ${previewDollars.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
          <MButton variant="primary" disabled={!entry.canCreate || entry.isCreating} onClick={entry.create}>
            {entry.isCreating ? 'Creating…' : 'Create payroll run'}
          </MButton>
        </div>
      ) : null}

      <div className="mt-4">
        <Attribution source="POST /api/labor-payroll-runs/preview · POST /api/labor-payroll-runs (laborPayrollEntry XState machine)" />
      </div>
    </div>
  )
}
