/**
 * Mobile CLIENTS surfaces — v2 brutalist style (square borders, mono
 * micro-labels, big-number stats). Mirrors Steve's V2ClientsList /
 * V2ClientProfile layouts, rebuilt on the v2-styled `components/m`
 * primitives so there's no new global CSS — only var(--m-*) tokens.
 *
 *   MobileClientsList  — MTopBar "Clients" + search MChip filters + client
 *                        rows (square monogram lead, lifetime-value /
 *                        project-count mono meta). Tap → /clients/:id.
 *   MobileClientProfile — reads :clientId, a 3-stat MStatStrip header
 *                        (lifetime value / win rate / projects), then a
 *                        per-client project-history list.
 *
 * Data comes from existing hooks only: `useCustomers` (the company customer
 * roster) for the list, and `useProjects` for per-client project history +
 * the aggregate stats. No new API calls are invented — lifetime value is the
 * Σ of project bid totals, win rate is the won/closed ratio.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useCustomers, type Customer } from '@/lib/api/customers'
import { useProjects, type ProjectListRow } from '@/lib/api/projects'
import {
  MBody,
  MChip,
  MChipRow,
  MI,
  MInput,
  MListPlain,
  MListRow,
  MPill,
  MStat,
  MStatStrip,
  MTopBar,
} from '../../components/m/index.js'
import { formatMoney, formatStatusLabel, statusTone } from './format.js'

// --- shared project classification ------------------------------------
// Mirrors the project-closeout taxonomy used elsewhere. "Won" = the deal
// landed (accepted / in progress / completed); "lost" = declined/archived.
// Win rate is won / (won + lost) so still-open bids don't drag it down.
const isWon = (s: string) => /accept|progress|active|complete|done|closeout|paid/i.test(s)
const isLost = (s: string) => /declin|lost|void|archive/i.test(s)
const isOpenBid = (s: string) => !isWon(s) && !isLost(s)

type ClientStats = {
  projectCount: number
  lifetimeValue: number
  wins: number
  decided: number
}

function statsFor(projects: ProjectListRow[]): ClientStats {
  let lifetimeValue = 0
  let wins = 0
  let decided = 0
  for (const p of projects) {
    lifetimeValue += Number(p.bid_total) || 0
    if (isWon(p.status)) {
      wins += 1
      decided += 1
    } else if (isLost(p.status)) {
      decided += 1
    }
  }
  return { projectCount: projects.length, lifetimeValue, wins, decided }
}

// Two-letter square monogram from a client name ("HILLCREST HOMES" → "HH").
function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '—'
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase() || '—'
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '—'
}

// Square brutalist monogram tile (the v2 "JM" block) built from tokens.
function Monogram({ children, size = 44 }: { children: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--m-ink)',
        color: 'var(--m-sand)',
        border: '2px solid var(--m-ink)',
        fontFamily: 'var(--m-font-display)',
        fontWeight: 800,
        fontSize: size >= 64 ? 24 : 14,
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </span>
  )
}

// =====================================================================
// CLIENTS LIST
// =====================================================================
type FilterKey = 'all' | 'active' | 'prospect'

const FILTER_LABEL: Record<FilterKey, string> = {
  all: 'All',
  active: 'Active',
  prospect: 'Prospects',
}

export function MobileClientsList() {
  const navigate = useNavigate()
  const customersQuery = useCustomers()
  const projectsQuery = useProjects()
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')

  const customers = useMemo(
    () => (customersQuery.data?.customers ?? []).filter((c) => !c.deleted_at),
    [customersQuery.data?.customers],
  )
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data?.projects])

  // Group projects by customer once so each row reads its stats cheaply.
  const statsByCustomer = useMemo(() => {
    const byCustomer = new Map<string, ProjectListRow[]>()
    for (const p of projects) {
      if (!p.customer_id) continue
      const arr = byCustomer.get(p.customer_id)
      if (arr) arr.push(p)
      else byCustomer.set(p.customer_id, [p])
    }
    const out = new Map<string, ClientStats>()
    for (const [id, rows] of byCustomer) out.set(id, statsFor(rows))
    return out
  }, [projects])

  const counts = useMemo(() => {
    let active = 0
    let prospect = 0
    for (const c of customers) {
      const s = statsByCustomer.get(c.id)
      if (s && s.projectCount > 0) active += 1
      else prospect += 1
    }
    return { all: customers.length, active, prospect }
  }, [customers, statsByCustomer])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return customers.filter((c) => {
      const s = statsByCustomer.get(c.id)
      const hasProjects = !!s && s.projectCount > 0
      if (filter === 'active' && !hasProjects) return false
      if (filter === 'prospect' && hasProjects) return false
      if (q && !c.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [customers, statsByCustomer, filter, query])

  return (
    <>
      <MTopBar
        eyebrow="CLIENTS"
        title={`${customers.length} ${customers.length === 1 ? 'ACCOUNT' : 'ACCOUNTS'}`}
        actionIcon={<MI.Plus size={20} />}
        actionLabel="New client"
        onAction={() => navigate('/clients/new')}
      />
      <MBody>
        <div style={{ padding: '12px 16px 4px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--m-card-soft)',
              border: '2px solid var(--m-ink)',
              padding: '0 12px',
              height: 44,
            }}
          >
            <MI.Search size={18} style={{ color: 'var(--m-ink-3)' }} />
            <MInput
              type="search"
              placeholder="Search clients…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                height: 'auto',
                padding: 0,
                fontSize: 15,
              }}
            />
          </div>
        </div>
        <MChipRow>
          {(Object.keys(FILTER_LABEL) as FilterKey[]).map((k) => (
            <MChip key={k} active={filter === k} onClick={() => setFilter(k)} count={counts[k]}>
              {FILTER_LABEL[k]}
            </MChip>
          ))}
        </MChipRow>

        {customersQuery.isLoading ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
            Loading clients…
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
            {customers.length === 0 ? 'No clients yet.' : 'No clients match this filter.'}
          </div>
        ) : (
          <>
            <div className="m-section-bar">
              <span>Clients</span>
              <span style={{ color: 'var(--m-ink)', fontWeight: 700 }}>
                {visible.length} {filter === 'all' ? 'TOTAL' : 'SHOWN'}
              </span>
            </div>
            <MListPlain>
              {visible.map((c) => (
                <ClientRow
                  key={c.id}
                  customer={c}
                  stats={statsByCustomer.get(c.id)}
                  onOpen={() => navigate(`/clients/${c.id}`)}
                />
              ))}
            </MListPlain>
          </>
        )}
      </MBody>
    </>
  )
}

function ClientRow({
  customer,
  stats,
  onOpen,
}: {
  customer: Customer
  stats: ClientStats | undefined
  onOpen: () => void
}) {
  const ltv = stats?.lifetimeValue ?? 0
  const projectCount = stats?.projectCount ?? 0
  return (
    <MListRow
      onTap={onOpen}
      chev
      leading={<Monogram>{monogram(customer.name)}</Monogram>}
      headline={customer.name}
      supporting={<span style={{ fontFamily: 'var(--m-num)' }}>{customer.source?.toUpperCase() || 'CLIENT'}</span>}
      trailing={
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 13,
              fontWeight: 800,
              color: ltv > 0 ? 'var(--m-green)' : 'var(--m-ink-3)',
            }}
          >
            {formatMoney(ltv)}
          </div>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 9, fontWeight: 600, color: 'var(--m-ink-3)', marginTop: 3 }}>
            {projectCount} PROJ
          </div>
        </div>
      }
    />
  )
}

// =====================================================================
// CLIENT PROFILE
// =====================================================================
export function MobileClientProfile() {
  const navigate = useNavigate()
  const { clientId } = useParams<{ clientId: string }>()
  const customersQuery = useCustomers()
  const projectsQuery = useProjects()

  const customer = useMemo(
    () => (customersQuery.data?.customers ?? []).find((c) => c.id === clientId),
    [customersQuery.data?.customers, clientId],
  )

  const clientProjects = useMemo(
    () => (projectsQuery.data?.projects ?? []).filter((p) => p.customer_id === clientId),
    [projectsQuery.data?.projects, clientId],
  )

  const stats = useMemo(() => statsFor(clientProjects), [clientProjects])
  const winRate = stats.decided > 0 ? Math.round((stats.wins / stats.decided) * 100) : null

  if (customersQuery.isLoading) {
    return (
      <>
        <MTopBar back title="Client" onBack={() => navigate('/clients')} />
        <MBody>
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
            Loading…
          </div>
        </MBody>
      </>
    )
  }

  if (!customer) {
    return (
      <>
        <MTopBar back title="Client" onBack={() => navigate('/clients')} />
        <MBody>
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
            Client not found.
          </div>
        </MBody>
      </>
    )
  }

  return (
    <>
      <MTopBar eyebrow="CLIENT" title={customer.name} back onBack={() => navigate('/clients')} />
      <MBody>
        {/* Identity block — square monogram + name + mono micro-label */}
        <div style={{ padding: '20px 16px', borderBottom: '2px solid var(--m-ink)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <Monogram size={64}>{monogram(customer.name)}</Monogram>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 20, lineHeight: 1.1 }}>
              {customer.name}
            </div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--m-ink-3)',
                marginTop: 6,
                letterSpacing: '0.04em',
              }}
            >
              {(customer.source?.toUpperCase() || 'CLIENT')}
              {customer.external_id ? ` · ${customer.external_id}` : ''}
            </div>
          </div>
        </div>

        {/* 3-stat big-number header */}
        <MStatStrip>
          <MStat label="LIFETIME $" value={formatMoney(stats.lifetimeValue)} />
          <MStat label="WIN RATE" value={winRate === null ? '—' : `${winRate}%`} />
          <MStat label="PROJECTS" value={stats.projectCount} />
        </MStatStrip>

        {/* Project history */}
        <div className="m-section-bar">
          <span>Project history</span>
          <span style={{ color: 'var(--m-ink)', fontWeight: 700 }}>{clientProjects.length} TOTAL</span>
        </div>
        {clientProjects.length === 0 ? (
          <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
            No projects for this client yet.
          </div>
        ) : (
          <MListPlain>
            {clientProjects.map((p) => (
              <ProjectHistoryRow key={p.id} project={p} onOpen={() => navigate(`/projects/${p.id}`)} />
            ))}
          </MListPlain>
        )}
      </MBody>
    </>
  )
}

function ProjectHistoryRow({ project, onOpen }: { project: ProjectListRow; onOpen: () => void }) {
  const tone = statusTone(project.status)
  return (
    <MListRow
      onTap={onOpen}
      chev
      headline={project.name}
      supporting={
        <span style={{ fontFamily: 'var(--m-num)' }}>
          {(project.division_code ?? '—').toUpperCase()} · {formatMoney(project.bid_total)}
          {isOpenBid(project.status) ? ' · OPEN BID' : ''}
        </span>
      }
      badge={<MPill tone={tone}>{formatStatusLabel(project.status)}</MPill>}
    />
  )
}
