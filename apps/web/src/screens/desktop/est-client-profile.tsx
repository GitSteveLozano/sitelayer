/**
 * Estimator desktop CLIENT PROFILE — a single-client drill-down (Desktop v2).
 * Mirrors the owner-clients roster math (screens/desktop/owner-clients.tsx):
 * lifetime value = Σ project bid_total for this client, win rate =
 * won / (won + lost). Reuses the same hooks (`useCustomers`, `useProjects`)
 * and the shared `components/d` primitives — no new global CSS, only the
 * var(--m-*) tokens. Reads :clientId from the route.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useCustomers } from '@/lib/api/customers'
import { useProjects, type ProjectListRow } from '@/lib/api/projects'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DTabBar, type DColumn } from '@/components/d'
import { MAvatar, MButton, MPill, avatarToneFor, initialsFor } from '@/components/m'
import { formatMoney, formatStatusLabel, statusTone } from '../mobile/format.js'

type ClientTab = 'projects' | 'takeoffs' | 'contact'

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
  const [tab, setTab] = useState<ClientTab>('projects')

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
  // Takeoffs KPI — each project on file is a takeoff/bid job for this client.
  const takeoffCount = projects.length

  // Org / "since" eyebrow attributes from the real customer record. The
  // customer roster only carries origin (QBO-matched vs Sitelayer-native)
  // and a created_at, so "since" is the account-creation year.
  const org = customer
    ? customer.external_id
      ? 'QuickBooks'
      : customer.source && customer.source !== 'sitelayer'
        ? customer.source
        : 'Sitelayer'
    : ''
  const sinceYear = (() => {
    if (!customer?.created_at) return null
    const d = new Date(customer.created_at)
    return Number.isNaN(d.getTime()) ? null : d.getFullYear()
  })()

  // Whether the customer can even be resolved is decided solely by the
  // customers query — the projects query only feeds the KPI strip + tables,
  // which render data-or-empty on their own. Gating the whole screen on
  // BOTH (`customersQuery.isPending || projectsQuery.isPending`) meant a slow
  // or not-yet-threaded projects load stranded the page on "Loading client…"
  // forever even though the customer (and a 200 from /api/projects) were
  // already in hand. Block only while the customer roster is still resolving
  // and we haven't matched a customer yet; once it settles we either render
  // the profile or the not-found state, and projects fill in independently.
  if (customersQuery.isPending && !customer) {
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

  // TAKEOFFS tab — each project reframed as a takeoff job: Takeoff / Date /
  // Size / Value / Result (dsg__32). Size has no real column on the project
  // list payload, so it renders '—' rather than inventing a figure.
  const takeoffColumns: Array<DColumn<ProjectListRow>> = [
    { key: 'name', header: 'Takeoff', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'date', header: 'Date', render: (r) => formatProjectDate(r.created_at) },
    { key: 'size', header: 'Size', numeric: true, render: () => '—' },
    { key: 'value', header: 'Value', numeric: true, render: (r) => formatMoney(r.bid_total) },
    {
      key: 'result',
      header: 'Result',
      render: (r) => (
        <MPill tone={statusTone(r.status)} dot>
          {formatStatusLabel(r.status)}
        </MPill>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        {/* Client header — avatar tile + org/since eyebrow + name (dsg__32). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <MAvatar initials={initialsFor(customer.name) || '—'} tone={avatarToneFor(customer.id)} size="lg" />
          <div>
            <DEyebrow>
              {org}
              {sinceYear ? ` · Since ${sinceYear}` : ''}
            </DEyebrow>
            <DH1>{customer.name}</DH1>
          </div>
        </div>

        <DKpiStrip>
          <DKpi
            label="Projects"
            value={String(projects.length)}
            meta={projects.length === 1 ? '1 project' : 'On file'}
          />
          <DKpi label="Lifetime $" value={formatMoney(lifetimeValue)} meta="All projects" />
          <DKpi
            label="Win rate"
            value={winRate === null ? '—' : `${winRate}%`}
            tone="accent"
            meta={decided > 0 ? `${wins}/${decided} decided` : 'No decided bids'}
          />
          <DKpi label="Takeoffs" value={String(takeoffCount)} meta={takeoffCount === 1 ? '1 takeoff' : 'On file'} />
        </DKpiStrip>

        <DTabBar
          tabs={[
            { key: 'projects', label: 'Projects' },
            { key: 'takeoffs', label: 'Takeoffs' },
            { key: 'contact', label: 'Contact' },
          ]}
          active={tab}
          onSelect={(k) => setTab(k as ClientTab)}
        />

        {tab === 'projects' ? (
          <DataTable<ProjectListRow>
            title="Project history"
            action={
              <MButton
                size="sm"
                variant="primary"
                onClick={() => navigate(`/desktop/projects/new?customer_id=${customer.id}`)}
              >
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
        ) : null}

        {tab === 'takeoffs' ? (
          <>
            <DataTable<ProjectListRow>
              columns={takeoffColumns}
              rows={projects}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/desktop/projects/${r.id}`)}
              empty={
                projectsQuery.isError
                  ? 'Could not load this client’s takeoffs.'
                  : 'No takeoffs yet. They land here once a bid is started for this client.'
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
          </>
        ) : null}

        {tab === 'contact' ? (
          <div className="d-card">
            <ContactRow label="Org" value={org} />
            <ContactRow label="Client since" value={sinceYear ? String(sinceYear) : '—'} />
            <ContactRow label="Source" value={customer.external_id ? 'Synced from QuickBooks' : 'Sitelayer-native'} />
            <ContactRow label="Projects" value={String(projects.length)} />
            <ContactRow label="Lifetime $" value={formatMoney(lifetimeValue)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Labeled key/value row for the CONTACT panel — mono micro-label + value. */
function ContactRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        padding: '12px 0',
        borderTop: '1px solid var(--m-line, rgba(0,0,0,0.1))',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        {label}
      </span>
      <span className="d-table-cell-strong">{value}</span>
    </div>
  )
}
