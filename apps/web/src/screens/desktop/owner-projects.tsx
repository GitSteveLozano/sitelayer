/**
 * Owner desktop projects — the dense, scannable project ledger (Desktop v2 · 02).
 * Same bootstrap data as the mobile owner home; a filterable dense table.
 * Layout reference: "OWNER 02 · PROJECTS · DENSE TABLE" in the desktop template.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { formatMoney, formatStatusLabel, statusTone } from '../mobile/format.js'

type ProjectFilter = 'all' | 'progress' | 'bidding' | 'done'

const FILTERS: Array<{ key: ProjectFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'progress', label: 'In progress' },
  { key: 'bidding', label: 'Bidding' },
  { key: 'done', label: 'Done' },
]

type ProjectTableRow = {
  id: string
  name: string
  customer: string
  status: string
  pctComplete: number
  margin: number
  bidValue: number
}

function matchesFilter(status: string, filter: ProjectFilter): boolean {
  if (filter === 'all') return true
  const s = status.toLowerCase()
  if (filter === 'progress') return /progress|active/.test(s)
  if (filter === 'bidding') return /estim|sent|await|draft|bid/.test(s)
  return /done|close|archive/.test(s)
}

export function OwnerProjects({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<ProjectFilter>('all')

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])

  const allRows = useMemo<ProjectTableRow[]>(() => {
    // Spend-to-date by project from logged labor hours × the project's labor rate.
    const spendByProject = new Map<string, number>()
    for (const l of labor) {
      if (l.deleted_at || !l.project_id) continue
      const proj = projects.find((p) => p.id === l.project_id)
      const rate = Number(proj?.labor_rate ?? 0)
      const cost = Number(l.hours ?? 0) * rate
      spendByProject.set(l.project_id, (spendByProject.get(l.project_id) ?? 0) + cost)
    }
    return projects.map((p) => {
      const bidValue = Number(p.bid_total ?? 0)
      const spent = spendByProject.get(p.id) ?? 0
      const s = p.status.toLowerCase()
      // % complete: terminal states are 100; otherwise spend against bid (capped).
      const pctComplete = /done|close|archive/.test(s)
        ? 100
        : bidValue > 0
          ? Math.min(100, Math.round((spent / bidValue) * 100))
          : 0
      // Margin = (bid − spend-to-date) / bid.
      const margin = bidValue > 0 ? (bidValue - spent) / bidValue : 0
      return {
        id: p.id,
        name: p.name,
        customer: p.customer_name,
        status: p.status,
        pctComplete,
        margin,
        bidValue,
      }
    })
  }, [projects, labor])

  const rows = useMemo(
    () => allRows.filter((r) => matchesFilter(r.status, filter)),
    [allRows, filter],
  )

  const pipelineValue = useMemo(
    () => allRows.filter((r) => matchesFilter(r.status, 'bidding')).reduce((sum, r) => sum + r.bidValue, 0),
    [allRows],
  )
  const activeCount = useMemo(
    () => allRows.filter((r) => matchesFilter(r.status, 'progress')).length,
    [allRows],
  )

  const columns: Array<DColumn<ProjectTableRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'customer', header: 'Client', render: (r) => r.customer || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={statusTone(r.status)} dot>
          {formatStatusLabel(r.status)}
        </MPill>
      ),
    },
    { key: 'pct', header: '% Complete', numeric: true, render: (r) => `${r.pctComplete}%` },
    {
      key: 'margin',
      header: 'Margin',
      numeric: true,
      render: (r) => `${Math.round(r.margin * 100)}%`,
    },
    { key: 'bid', header: 'Bid value', numeric: true, render: (r) => formatMoney(r.bidValue) },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Projects</DEyebrow>
          <DH1>
            {allRows.length} {allRows.length === 1 ? 'project' : 'projects'}
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi label="All projects" value={String(allRows.length)} meta="In the book" />
          <DKpi label="In progress" value={String(activeCount)} tone="accent" meta="On site now" />
          <DKpi label="Bid pipeline" value={formatMoney(pipelineValue)} meta="In-flight estimates" />
        </DKpiStrip>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => (
            <MButton
              key={f.key}
              size="sm"
              variant={filter === f.key ? 'primary' : 'quiet'}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </MButton>
          ))}
        </div>

        <DataTable<ProjectTableRow>
          title="Projects"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/desktop/projects/${r.id}`)}
          empty={
            allRows.length === 0
              ? 'No projects yet. New jobs land here once they kick off.'
              : 'No projects match this filter.'
          }
        />
      </div>
    </div>
  )
}
