/**
 * Estimator desktop CLIENT PROFILE — a single-client drill-down (Desktop v2).
 * Mirrors the owner-clients roster math (screens/desktop/owner-clients.tsx):
 * lifetime value = Σ project bid_total for this client, win rate =
 * won / (won + lost). Reuses the same hooks (`useCustomers`, `useProjects`)
 * and the shared `components/d` primitives — no new global CSS, only the
 * var(--m-*) tokens. Reads :clientId from the route.
 */
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useCustomers } from '@/lib/api/customers'
import { useProjects, type ProjectListRow } from '@/lib/api/projects'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { formatMoney, formatStatusLabel, statusTone } from '../mobile/format.js'

// Shared project classification — mirrors the owner-clients taxonomy.
// "Won" = the deal landed; "lost" = declined/archived. Win rate is
// won / (won + lost) so still-open bids don't drag it down.
const isWon = (s: string) => /accept|progress|active|complete|done|closeout|paid/i.test(s)
const isLost = (s: string) => /declin|lost|void|archive/i.test(s)

function formatProjectDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

type ScopeRow = {
  code: string
  projectCount: number
  value: number
}

export function EstClientProfile() {
  const params = useParams<{ clientId: string }>()
  const navigate = useNavigate()
  const clientId = params.clientId ?? ''

  const customersQuery = useCustomers()
  const projectsQuery = useProjects()

  const customer = useMemo(
    () => (customersQuery.data?.customers ?? []).find((c) => c.id === clientId) ?? null,
    [customersQuery.data?.customers, clientId],
  )

  // This client's project history, newest first.
  const projects = useMemo<ProjectListRow[]>(() => {
    const all = projectsQuery.data?.projects ?? []
    return all
      .filter((p) => p.customer_id === clientId)
      .slice()
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  }, [projectsQuery.data?.projects, clientId])

  const { lifetimeValue, wins, decided, scopes } = useMemo(() => {
    let lifetimeValue = 0
    let wins = 0
    let decided = 0
    const scopeMap = new Map<string, ScopeRow>()
    for (const p of projects) {
      const value = Number(p.bid_total) || 0
      lifetimeValue += value
      if (isWon(p.status)) {
        wins += 1
        decided += 1
      } else if (isLost(p.status)) {
        decided += 1
      }
      const code = p.division_code ?? '—'
      const cur = scopeMap.get(code) ?? { code, projectCount: 0, value: 0 }
      cur.projectCount += 1
      cur.value += value
      scopeMap.set(code, cur)
    }
    const scopes = Array.from(scopeMap.values()).sort((a, b) => b.value - a.value)
    return { lifetimeValue, wins, decided, scopes }
  }, [projects])

  const winRate = decided > 0 ? Math.round((wins / decided) * 100) : null
  const avgMargin = projects.length > 0 ? lifetimeValue / projects.length : 0

  const isPending = customersQuery.isPending || projectsQuery.isPending

  // Loading — both reference lists still resolving and no customer yet.
  if (isPending && !customer) {
    return (
      <div className="d-content">
        <div style={{ color: 'var(--m-ink-3)' }}>Loading client…</div>
      </div>
    )
  }

  // Not found — lists resolved but no customer matches this :clientId.
  if (!customer) {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Estimator · Client</DEyebrow>
            <DH1>Client not found</DH1>
          </div>
          <div className="d-card" style={{ color: 'var(--m-ink-2)' }}>
            This client may have been removed or you may not have access.
            <div style={{ marginTop: 14 }}>
              <MButton variant="primary" onClick={() => navigate('/desktop/clients')}>
                Back to clients
              </MButton>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const columns: Array<DColumn<ProjectListRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={statusTone(r.status)} dot>
          {formatStatusLabel(r.status)}
        </MPill>
      ),
    },
    { key: 'bid', header: 'Bid value', numeric: true, render: (r) => formatMoney(r.bid_total) },
    { key: 'date', header: 'Date', render: (r) => formatProjectDate(r.created_at) },
  ]

  const scopeColumns: Array<DColumn<ScopeRow>> = [
    { key: 'code', header: 'Scope', render: (r) => <span className="d-table-cell-strong">{r.code}</span> },
    { key: 'projects', header: 'Projects', numeric: true, render: (r) => r.projectCount },
    { key: 'value', header: 'Value', numeric: true, render: (r) => formatMoney(r.value) },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Estimator · Client</DEyebrow>
          <DH1>{customer.name}</DH1>
        </div>

        <DKpiStrip>
          <DKpi label="Lifetime value" value={formatMoney(lifetimeValue)} meta="All projects" />
          <DKpi
            label="Win rate"
            value={winRate === null ? '—' : `${winRate}%`}
            tone="accent"
            meta={decided > 0 ? `${wins}/${decided} decided` : 'No decided bids'}
          />
          <DKpi label="Projects" value={String(projects.length)} meta={projects.length === 1 ? '1 project' : 'On file'} />
          <DKpi label="Avg margin" value={formatMoney(avgMargin)} meta="Per project" />
        </DKpiStrip>

        <DataTable<ProjectListRow>
          title="Project history"
          action={
            <MButton size="sm" variant="primary" onClick={() => navigate(`/projects/new?customer_id=${customer.id}`)}>
              New project
            </MButton>
          }
          columns={columns}
          rows={projects}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/desktop/projects/${r.id}`)}
          empty={
            projectsQuery.isError
              ? 'Could not load this client’s projects.'
              : 'No projects yet. Bids and jobs for this client land here once they’re created.'
          }
        />

        {scopes.length > 0 ? (
          <DataTable<ScopeRow>
            title="Takeoffs by scope"
            columns={scopeColumns}
            rows={scopes}
            rowKey={(r) => r.code}
            empty="No scope breakdown yet."
          />
        ) : null}
      </div>
    </div>
  )
}
