import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ProjectRow } from '../api.js'
import { Button } from '../components/ui/button.js'
import { useProjectSelection } from '../machines/project-selection.js'

/**
 * Per-project detail screen with Overview/Labor/Rentals/Documents tabs.
 *
 * Closes Steve's "Project detail tabbed view" claim from the README.
 * Reuses useProjectSelection (which already fetches summary, blueprints,
 * measurements, material bills, schedules in parallel) so the tabs are
 * thin views over data the machine already has.
 *
 * Routes:
 *   /projects/:projectId  → this view
 */

type Tab = 'overview' | 'labor' | 'rentals' | 'documents'

type ProjectDetailViewProps = {
  companySlug: string
  projects: ProjectRow[]
}

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'labor', label: 'Labor' },
  { value: 'rentals', label: 'Rentals' },
  { value: 'documents', label: 'Documents' },
]

function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return String(value)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num)
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

export function ProjectDetailView({ companySlug, projects }: ProjectDetailViewProps) {
  const { projectId } = useParams<{ projectId: string }>()
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])
  const [tab, setTab] = useState<Tab>('overview')
  const selection = useProjectSelection(companySlug, projectId ?? '')

  if (!projectId) return null
  if (!project) {
    return (
      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">Project not found</h2>
        <Link to="/projects">
          <Button variant="outline">Back to projects</Button>
        </Link>
      </section>
    )
  }

  return (
    <section className="space-y-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">{project.name}</h2>
          <p className="text-sm text-slate-500">
            {project.customer_name} · {project.division_code} · {project.status}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={`/rental-contracts/${project.id}`}>
            <Button variant="outline" size="sm">
              Manage rental
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={selection.refresh} disabled={selection.isFetching}>
            {selection.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {selection.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          {selection.error}
        </div>
      )}

      <div className="flex gap-2 border-b border-slate-200 -mb-px">
        {TABS.map((t) => (
          <Button
            key={t.value}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setTab(t.value)}
            className={`rounded-none border-b-2 ${
              tab === t.value ? 'border-primary text-primary' : 'border-transparent text-slate-500'
            }`}
            aria-pressed={tab === t.value}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab project={project} summary={selection.summary} />}
      {tab === 'labor' && <LaborTab summary={selection.summary} />}
      {tab === 'rentals' && <RentalsTab projectId={project.id} materialBills={selection.materialBills} />}
      {tab === 'documents' && <DocumentsTab blueprints={selection.blueprints} />}
    </section>
  )
}

function OverviewTab({
  project,
  summary,
}: {
  project: ProjectRow
  summary: ReturnType<typeof useProjectSelection>['summary']
}) {
  const metrics = summary?.metrics
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Bid total" value={formatCurrency(project.bid_total)} />
        <Stat label="Estimate" value={formatCurrency(metrics?.estimateTotal ?? null)} />
        <Stat label="Total cost" value={formatCurrency(metrics?.totalCost ?? null)} />
        <Stat label="Margin" value={formatPercent(metrics?.margin.margin ?? null)} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Labor cost" value={formatCurrency(metrics?.laborCost ?? null)} />
        <Stat label="Material cost" value={formatCurrency(metrics?.materialCost ?? null)} />
        <Stat label="Sub cost" value={formatCurrency(metrics?.subCost ?? null)} />
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold">Bonus eligibility</h3>
        <p className="mt-1 text-sm text-slate-700">
          {metrics?.bonus.eligible ? (
            <>
              Eligible at <strong>{formatPercent(metrics.bonus.payoutPercent)}</strong> →{' '}
              <strong>{formatCurrency(metrics.bonus.payout)}</strong>
            </>
          ) : (
            'Not yet eligible — margin below threshold.'
          )}
        </p>
      </div>
    </div>
  )
}

function LaborTab({ summary }: { summary: ReturnType<typeof useProjectSelection>['summary'] }) {
  const entries = summary?.laborEntries ?? []
  if (!entries.length) return <p className="text-sm text-slate-500">No labor entries logged yet for this project.</p>
  const totalHours = entries.reduce((sum, e) => sum + Number(e.hours ?? 0), 0)
  const totalSqft = entries.reduce((sum, e) => sum + Number(e.sqft_done ?? 0), 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Entries" value={String(entries.length)} />
        <Stat label="Total hours" value={totalHours.toFixed(1)} />
        <Stat label="Total sqft" value={totalSqft.toFixed(0)} />
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-slate-500">
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2 text-right">Hours</th>
              <th className="px-3 py-2 text-right">Sqft</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-slate-100">
                <td className="px-3 py-2 text-xs">{entry.occurred_on}</td>
                <td className="px-3 py-2 font-mono text-xs">{entry.service_item_code}</td>
                <td className="px-3 py-2 text-right tabular-nums">{entry.hours}</td>
                <td className="px-3 py-2 text-right tabular-nums">{entry.sqft_done}</td>
                <td className="px-3 py-2 text-xs">{entry.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RentalsTab({
  projectId,
  materialBills,
}: {
  projectId: string
  materialBills: ReturnType<typeof useProjectSelection>['materialBills']
}) {
  const rentalBills = materialBills.filter((b) => b.bill_type === 'rental')
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold">Rental contract</h3>
        <p className="mt-1 text-sm text-slate-600">
          Manage active rental contract, lines, and billing runs in the dedicated screen.
        </p>
        <Link to={`/rental-contracts/${projectId}`} className="mt-2 inline-block">
          <Button variant="default" size="sm">
            Open rental contract
          </Button>
        </Link>
      </div>
      {rentalBills.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <caption className="px-3 pt-2 text-left text-sm font-semibold">Rental bills (legacy ledger)</caption>
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Vendor</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Description</th>
              </tr>
            </thead>
            <tbody>
              {rentalBills.map((bill) => (
                <tr key={bill.id} className="border-b border-slate-100">
                  <td className="px-3 py-2 text-xs">{bill.occurred_on ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{bill.vendor}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(bill.amount)}</td>
                  <td className="px-3 py-2 text-xs">{bill.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DocumentsTab({ blueprints }: { blueprints: ReturnType<typeof useProjectSelection>['blueprints'] }) {
  if (!blueprints.length) return <p className="text-sm text-slate-500">No blueprints uploaded for this project.</p>
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="px-3 py-2">File</th>
            <th className="px-3 py-2">Calibration</th>
            <th className="px-3 py-2">Version</th>
            <th className="px-3 py-2">Uploaded</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {blueprints.map((bp) => (
            <tr key={bp.id} className="border-b border-slate-100">
              <td className="px-3 py-2 font-mono text-xs">{bp.file_name}</td>
              <td className="px-3 py-2 text-xs">
                {bp.calibration_length ? `${bp.calibration_length} ${bp.calibration_unit ?? ''}` : '—'}
              </td>
              <td className="px-3 py-2 text-xs">v{bp.version}</td>
              <td className="px-3 py-2 text-xs">{bp.created_at.slice(0, 10)}</td>
              <td className="px-3 py-2">
                <a href={bp.file_url} target="_blank" rel="noreferrer">
                  <Button variant="outline" size="sm">
                    Open
                  </Button>
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}
