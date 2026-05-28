/**
 * Owner desktop CLIENTS — a dense client roster table (Desktop v2).
 * Mirrors the mobile clients data approach (screens/mobile/clients.tsx):
 * lifetime value = Σ project bid_total per client, win rate = won/(won+lost).
 * Reuses the same hooks (`useCustomers`, `useProjects`) and the shared
 * `components/d` primitives — no new global CSS, only var(--m-*) tokens.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCustomers } from '@/lib/api/customers'
import { useProjects, type ProjectListRow } from '@/lib/api/projects'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

// Shared project classification — mirrors the mobile clients taxonomy.
// "Won" = the deal landed; "lost" = declined/archived. Win rate is
// won / (won + lost) so still-open bids don't drag it down.
const isWon = (s: string) => /accept|progress|active|complete|done|closeout|paid/i.test(s)
const isLost = (s: string) => /declin|lost|void|archive/i.test(s)

type ClientRow = {
  id: string
  name: string
  projectCount: number
  lifetimeValue: number
  wins: number
  decided: number
  lastProjectAt: string | null
}

function formatLastProject(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function OwnerClients() {
  const navigate = useNavigate()
  const customersQuery = useCustomers()
  const projectsQuery = useProjects()

  const customers = useMemo(
    () => (customersQuery.data?.customers ?? []).filter((c) => !c.deleted_at),
    [customersQuery.data?.customers],
  )
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data?.projects])

  const { rows, totalLifetime, totalWins, totalDecided, activeCount } = useMemo(() => {
    const byCustomer = new Map<string, ProjectListRow[]>()
    for (const p of projects) {
      if (!p.customer_id) continue
      const arr = byCustomer.get(p.customer_id)
      if (arr) arr.push(p)
      else byCustomer.set(p.customer_id, [p])
    }

    let totalLifetime = 0
    let totalWins = 0
    let totalDecided = 0
    let activeCount = 0

    const rows: ClientRow[] = customers.map((c) => {
      const ps = byCustomer.get(c.id) ?? []
      let lifetimeValue = 0
      let wins = 0
      let decided = 0
      let lastProjectAt: string | null = null
      for (const p of ps) {
        lifetimeValue += Number(p.bid_total) || 0
        if (isWon(p.status)) {
          wins += 1
          decided += 1
        } else if (isLost(p.status)) {
          decided += 1
        }
        if (!lastProjectAt || p.created_at > lastProjectAt) lastProjectAt = p.created_at
      }
      totalLifetime += lifetimeValue
      totalWins += wins
      totalDecided += decided
      if (ps.length > 0) activeCount += 1
      return {
        id: c.id,
        name: c.name,
        projectCount: ps.length,
        lifetimeValue,
        wins,
        decided,
        lastProjectAt,
      }
    })

    rows.sort((a, b) => b.lifetimeValue - a.lifetimeValue)
    return { rows, totalLifetime, totalWins, totalDecided, activeCount }
  }, [customers, projects])

  const overallWinRate = totalDecided > 0 ? Math.round((totalWins / totalDecided) * 100) : null

  const columns: Array<DColumn<ClientRow>> = [
    { key: 'name', header: 'Client', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'projects', header: 'Projects', numeric: true, render: (r) => r.projectCount },
    { key: 'lifetime', header: 'Lifetime value', numeric: true, render: (r) => formatMoney(r.lifetimeValue) },
    {
      key: 'winRate',
      header: 'Win rate',
      numeric: true,
      render: (r) => (r.decided > 0 ? `${Math.round((r.wins / r.decided) * 100)}%` : '—'),
    },
    { key: 'last', header: 'Last project', render: (r) => formatLastProject(r.lastProjectAt) },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Clients</DEyebrow>
          <DH1>
            {customers.length} {customers.length === 1 ? 'client' : 'clients'}.
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi label="Total clients" value={String(customers.length)} meta={`${activeCount} with projects`} />
          <DKpi label="Lifetime value" value={formatMoney(totalLifetime)} meta="All projects" />
          <DKpi
            label="Win rate"
            value={overallWinRate === null ? '—' : `${overallWinRate}%`}
            tone="accent"
            meta={totalDecided > 0 ? `${totalWins}/${totalDecided} decided` : 'No decided bids'}
          />
          <DKpi label="Active" value={String(activeCount)} meta="Clients with work" />
        </DKpiStrip>

        <DataTable<ClientRow>
          title="Client roster"
          action={
            <MButton size="sm" variant="primary" onClick={() => navigate('/clients/new')}>
              New client
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/clients/${r.id}`)}
          empty="No clients yet. New accounts land here once they're added."
        />
      </div>
    </div>
  )
}
