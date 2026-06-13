import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MButton, MPill } from '@/components/m'
import { useLaborPayrollRuns, type LaborPayrollRunRow } from '@/lib/api'
import { GeneratePayrollExportSheet } from './generate-payroll-export-sheet'

/**
 * Payroll export hub for the bookkeeper. Exports are generated against a
 * payroll run (the export "scope"), so this lists the runs that can be
 * exported and opens a sheet to pick the run + format and request a file.
 *
 * Posted and approved runs are the ones worth exporting (their hours are
 * locked); generated runs are still in review. We surface all states but
 * lead with the export-ready ones. Per-run export history + download
 * lives on the detail screen.
 */
export function PayrollExportListScreen() {
  const [sheetOpen, setSheetOpen] = useState(false)
  const runs = useLaborPayrollRuns()
  const rows = runs.data?.laborPayrollRuns ?? []

  // Export-ready = hours are locked (approved or posted). Show those
  // first; the rest are still moving through review.
  const exportable = rows.filter((r) => isExportable(r))

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/financial" className="text-[12px] text-ink-3">
        ← Financial
      </Link>
      <div className="mt-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Payroll exports</h1>
          <p className="text-[12px] text-ink-3 mt-1">
            Generate a payroll file from a run, then download it to import into your payroll provider.
          </p>
        </div>
      </div>

      <div className="mt-4">
        <MButton variant="primary" onClick={() => setSheetOpen(true)} disabled={exportable.length === 0}>
          Generate export
        </MButton>
        {exportable.length === 0 && !runs.isPending ? (
          <p className="text-[11px] text-ink-3 mt-2">No approved or posted runs yet — nothing to export.</p>
        ) : null}
      </div>

      <div className="mt-6 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1">Runs</div>
      <div className="mt-2 space-y-2">
        {runs.isPending ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">Loading…</div>
          </div>
        ) : runs.isError ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-bad">Couldn't load payroll runs. Pull to retry.</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="m-card m-card-tight">
            <div className="text-[12px] text-ink-3">No payroll runs yet.</div>
          </div>
        ) : (
          rows.map((r) => {
            const dollars = Number(r.total_cents) / 100
            const exportable = isExportable(r)
            return (
              <Link key={r.id} to={`/financial/payroll-exports/${r.id}`} className="block">
                <div className="m-card m-card-tight">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">
                        ${dollars.toLocaleString(undefined, { maximumFractionDigits: 2 })} · {r.period_start} →{' '}
                        {r.period_end}
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {Number(r.total_hours).toFixed(1)}h · {r.covered_labor_entry_ids?.length ?? 0} entries
                      </div>
                    </div>
                    <MPill tone={exportable ? 'green' : undefined}>{exportable ? 'exportable' : r.state}</MPill>
                  </div>
                </div>
              </Link>
            )
          })
        )}
      </div>

      <GeneratePayrollExportSheet open={sheetOpen} onClose={() => setSheetOpen(false)} runs={exportable} />
    </div>
  )
}

// Hours are locked once a run is approved or posted, so those are the
// runs whose export will reflect final numbers.
function isExportable(r: LaborPayrollRunRow): boolean {
  return r.state === 'approved' || r.state === 'posting' || r.state === 'posted'
}
