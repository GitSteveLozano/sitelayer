import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { listEstimatePushes, type EstimatePushListRow, type EstimatePushWorkflowState } from '../api.js'
import { Button } from '../components/ui/button.js'
import { toastError } from '../components/ui/toast.js'

/**
 * Entry surface for the deterministic estimate-push workflow.
 * Mirror of BillingRunsView. Lists pushes across the company, links
 * each row to /estimate-push/:pushId where the headless workflow
 * screen takes over.
 */

type EstimatePushesViewProps = {
  companySlug: string
}

const STATE_FILTERS: Array<{ value: EstimatePushWorkflowState | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'drafted', label: 'Drafted' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'approved', label: 'Ready to post' },
  { value: 'posting', label: 'Posting…' },
  { value: 'failed', label: 'Failed' },
  { value: 'posted', label: 'Posted' },
  { value: 'voided', label: 'Voided' },
]

const STATE_BADGE: Record<EstimatePushWorkflowState, string> = {
  drafted: 'bg-slate-100 text-slate-800',
  reviewed: 'bg-indigo-100 text-indigo-800',
  approved: 'bg-blue-100 text-blue-800',
  posting: 'bg-amber-100 text-amber-900',
  posted: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  voided: 'bg-slate-200 text-slate-600',
}

function formatCurrency(amount: string | number): string {
  const value = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(value)) return String(amount)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}

export function EstimatePushesView({ companySlug }: EstimatePushesViewProps) {
  const [filter, setFilter] = useState<EstimatePushWorkflowState | 'all'>('all')
  const [rows, setRows] = useState<EstimatePushListRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const result = await listEstimatePushes(companySlug, filter === 'all' ? undefined : filter)
        if (!cancelled) {
          setRows(result.estimatePushes)
          setError(null)
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'failed to load estimate pushes'
        if (!cancelled) {
          setError(message)
          toastError('Could not load estimate pushes', message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [companySlug, filter])

  const counts = useMemo(() => {
    const tally: Record<string, number> = {}
    for (const row of rows) {
      tally[row.status] = (tally[row.status] ?? 0) + 1
    }
    return tally
  }, [rows])

  return (
    <section className="space-y-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-2xl font-semibold">Estimate pushes</h2>
        <p className="text-sm text-slate-500">
          {rows.length} {rows.length === 1 ? 'push' : 'pushes'} in this view
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {STATE_FILTERS.map((opt) => (
          <Button
            key={opt.value}
            variant={filter === opt.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(opt.value)}
          >
            {opt.label}
            {opt.value !== 'all' && counts[opt.value] !== undefined && (
              <span className="ml-1 rounded bg-slate-200 px-1 text-xs text-slate-700">{counts[opt.value]}</span>
            )}
          </Button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>
      )}

      {loading && rows.length === 0 ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No estimate pushes match this filter.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Project</th>
                <th className="px-3 py-2 text-right">Subtotal</th>
                <th className="px-3 py-2">QBO Estimate</th>
                <th className="px-3 py-2">Updated</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_BADGE[row.status]}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">{row.project_id.slice(0, 8)}…</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(row.subtotal)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.qbo_estimate_id ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{formatDate(row.updated_at)}</td>
                  <td className="px-3 py-2">
                    <Link to={`/estimate-push/${row.id}`}>
                      <Button variant="outline" size="sm">
                        Open
                      </Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
