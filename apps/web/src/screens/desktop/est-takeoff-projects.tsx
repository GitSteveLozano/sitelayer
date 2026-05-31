/**
 * Estimator desktop takeoff projects — the bidding-focused project list (Desktop v2 · EST 01).
 * Same bootstrap data as the owner projects table, but sorted/filtered for the estimator's
 * pipeline (estimating + sent + draft first) and clicking through to the takeoff canvas.
 * Layout reference: "EST 01 · TAKEOFF PROJECTS" in the desktop template.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { useCompanyTakeoffDrafts } from '@/lib/api/takeoff-drafts'
import { formatMoney, formatStatusLabel, statusTone } from '../mobile/format.js'

type EstFilter = 'all' | 'takeoff' | 'progress' | 'sent'

const FILTERS: Array<{ key: EstFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'takeoff', label: 'To takeoff' },
  { key: 'progress', label: 'In progress' },
  { key: 'sent', label: 'Sent' },
]

type EstTableRow = {
  id: string
  name: string
  customer: string
  sheets: number | null
  status: string
  bidValue: number
}

// "To takeoff" = drafts/estimating not yet sent; the estimator's working queue.
function isTakeoff(status: string): boolean {
  const s = status.toLowerCase()
  return /draft|estim/.test(s) && !/sent|await/.test(s)
}
function isInProgress(status: string): boolean {
  return /progress|active|accept/.test(status.toLowerCase())
}
function isSent(status: string): boolean {
  return /sent|await|bid/.test(status.toLowerCase())
}
function isWon(status: string): boolean {
  const s = status.toLowerCase()
  return /accept|progress|active|done|close|archive/.test(s)
}
function isDecided(status: string): boolean {
  // Anything past the "out for bid" gate — won or lost — counts toward win rate.
  return isWon(status) || /declin|lost|reject/.test(status.toLowerCase())
}

function matchesFilter(status: string, filter: EstFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'takeoff') return isTakeoff(status)
  if (filter === 'progress') return isInProgress(status)
  return isSent(status)
}

// Estimator queue order: things needing takeoff first, then sent/awaiting, then the rest.
function sortRank(status: string): number {
  if (isTakeoff(status)) return 0
  if (isSent(status)) return 1
  if (isInProgress(status)) return 2
  return 3
}

export function EstTakeoffProjects({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<EstFilter>('all')

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  // AI Queue tile (design EST 01): count of auto-generated takeoff drafts still
  // waiting on estimator review — the same company feed the AI Queue screen reads.
  const reviewDrafts = useCompanyTakeoffDrafts({ reviewRequired: true })
  const aiQueueCount = reviewDrafts.data?.drafts.length ?? 0

  const allRows = useMemo<EstTableRow[]>(() => {
    const mapped = projects.map((p) => ({
      id: p.id,
      name: p.name,
      customer: p.customer_name,
      // No sheet/blueprint count travels in the bootstrap payload yet — show "—".
      sheets: null as number | null,
      status: p.status,
      bidValue: Number(p.bid_total ?? 0),
    }))
    // Estimating + sent + draft float to the top of the working queue.
    return mapped.sort((a, b) => {
      const r = sortRank(a.status) - sortRank(b.status)
      return r !== 0 ? r : b.bidValue - a.bidValue
    })
  }, [projects])

  const rows = useMemo(() => allRows.filter((r) => matchesFilter(r.status, filter)), [allRows, filter])

  const progressCount = useMemo(() => allRows.filter((r) => isInProgress(r.status)).length, [allRows])
  const sentCount = useMemo(() => allRows.filter((r) => isSent(r.status)).length, [allRows])
  const winRate = useMemo(() => {
    const decided = allRows.filter((r) => isDecided(r.status))
    if (decided.length === 0) return null
    const won = decided.filter((r) => isWon(r.status)).length
    return Math.round((won / decided.length) * 100)
  }, [allRows])

  const columns: Array<DColumn<EstTableRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'customer', header: 'Client', render: (r) => r.customer || '—' },
    {
      key: 'sheets',
      header: 'Sheets',
      numeric: true,
      render: (r) => (r.sheets == null ? '—' : String(r.sheets)),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={statusTone(r.status)} dot>
          {formatStatusLabel(r.status)}
        </MPill>
      ),
    },
    { key: 'bid', header: 'Bid value', numeric: true, render: (r) => formatMoney(r.bidValue) },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Estimator · Takeoff</DEyebrow>
          <DH1>
            {allRows.length} {allRows.length === 1 ? 'project' : 'projects'}
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi label="In progress" value={String(progressCount)} meta="Won + on site" />
          <DKpi label="AI queue" value={String(aiQueueCount)} tone="accent" meta="Drafts ready to review" />
          <DKpi
            label="Sent this month"
            value={String(sentCount)}
            meta={winRate == null ? 'Out for bid' : `${winRate}% win rate`}
            metaTone={winRate == null ? undefined : 'good'}
          />
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

        <DataTable<EstTableRow>
          title="Takeoff projects"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/desktop/canvas/${r.id}`)}
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
