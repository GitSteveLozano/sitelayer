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
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useCustomers, useCreateCustomer, type Customer } from '@/lib/api/customers'
import { useProjects, type ProjectListRow } from '@/lib/api/projects'
import {
  DataTable,
  DEmptyState,
  DEyebrow,
  DH1,
  DKpi,
  DKpiStrip,
  DModal,
  type DColumn,
} from '../../components/d/index.js'
import {
  MBody,
  MButton,
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
import { useIsDesktop } from '../../lib/use-is-desktop.js'
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

/**
 * Responsive clients list. Mounts the dense desktop roster table at >=1024px
 * and the mobile filtered list below it; only one mounts at a time so neither
 * twin's data hooks run on the wrong surface.
 *
 * Phase B consolidation of the desktop↔mobile clients twins (was
 * screens/desktop/owner-clients.tsx + this file). Both read the SAME hooks
 * (useCustomers / useProjects) and the same lifetime-value / win-rate math.
 */
export function MobileClientsList() {
  const isDesktop = useIsDesktop()
  return isDesktop ? <OwnerClientsDesktop /> : <MobileClientsListMobile />
}

/** Desktop-route alias — kept so screens/desktop/desktop-workspace.tsx can
 *  keep importing `OwnerClients` after the desktop twin file was deleted. */
export const OwnerClients = MobileClientsList

function MobileClientsListMobile() {
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
          <div
            style={{ fontFamily: 'var(--m-num)', fontSize: 9, fontWeight: 600, color: 'var(--m-ink-3)', marginTop: 3 }}
          >
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
type ProfileTab = 'projects' | 'takeoffs' | 'contact'

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

  // "SINCE <year>" — earliest relationship marker. Prefer the oldest project's
  // created_at; fall back to the customer record's own created_at.
  const sinceYear = useMemo(() => {
    const dates = clientProjects.map((p) => p.created_at).filter(Boolean)
    if (customer?.created_at) dates.push(customer.created_at)
    const years = dates.map((d) => new Date(d).getFullYear()).filter((y) => Number.isFinite(y) && y > 1970)
    return years.length > 0 ? Math.min(...years) : null
  }, [clientProjects, customer?.created_at])

  const [tab, setTab] = useState<ProfileTab>('projects')

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

  // Relationship subtitle: company-ish label (source) + "SINCE <year>".
  const companyLabel = customer.source?.toUpperCase() || 'CLIENT'
  const subtitle = sinceYear ? `${companyLabel} · SINCE ${sinceYear}` : companyLabel

  return (
    <>
      <MTopBar
        eyebrow="CLIENT"
        title={customer.name}
        back
        onBack={() => navigate('/clients')}
        actionLabel="More"
        actionIcon={<MoreDots />}
        onAction={() => undefined}
      />
      <MBody>
        {/* Identity block — square monogram + name + mono micro-label */}
        <div
          style={{
            padding: '20px 16px',
            borderBottom: '2px solid var(--m-ink)',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
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
              {subtitle}
            </div>
          </div>
        </div>

        {/* 3-stat big-number header */}
        <MStatStrip>
          <MStat label="PROJECTS" value={stats.projectCount} />
          <MStat label="LIFETIME $" value={formatMoney(stats.lifetimeValue)} />
          <MStat label="WIN RATE" value={winRate === null ? '—' : `${winRate}%`} />
        </MStatStrip>

        {/* Tab strip — PROJECTS / TAKEOFFS / CONTACT (design's segment row). */}
        <ProfileTabStrip tab={tab} onTab={setTab} projectCount={clientProjects.length} />

        {tab === 'projects' ? (
          clientProjects.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
              No projects for this client yet.
            </div>
          ) : (
            <MListPlain>
              {clientProjects.map((p) => (
                <ProjectHistoryRow key={p.id} project={p} onOpen={() => navigate(`/projects/${p.id}`)} />
              ))}
            </MListPlain>
          )
        ) : null}

        {tab === 'takeoffs' ? (
          clientProjects.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
              No takeoffs for this client yet.
            </div>
          ) : (
            <MListPlain>
              {clientProjects.map((p) => (
                <MListRow
                  key={p.id}
                  onTap={() => navigate(`/projects/${p.id}/takeoff`)}
                  chev
                  headline={p.name}
                  supporting={<span style={{ fontFamily: 'var(--m-num)' }}>VIEW TAKEOFF</span>}
                />
              ))}
            </MListPlain>
          )
        ) : null}

        {tab === 'contact' ? (
          <div style={{ padding: '4px 0 8px' }}>
            <ContactRow label="Name" value={customer.name} />
            {customer.source ? <ContactRow label="Type" value={customer.source} /> : null}
            {customer.external_id ? <ContactRow label="External ID" value={customer.external_id} /> : null}
            {sinceYear ? <ContactRow label="Client since" value={String(sinceYear)} /> : null}
          </div>
        ) : null}
      </MBody>
    </>
  )
}

// Three-dot overflow glyph for the top-bar action slot (the design's "...").
function MoreDots() {
  return (
    <span aria-hidden style={{ fontWeight: 800, fontSize: 20, lineHeight: 1, letterSpacing: '0.05em' }}>
      …
    </span>
  )
}

// PROJECTS / TAKEOFFS / CONTACT segmented tab strip. PROJECTS + TAKEOFFS carry
// counts; the active tab fills accent (the design's yellow segment).
function ProfileTabStrip({
  tab,
  onTab,
  projectCount,
}: {
  tab: ProfileTab
  onTab: (t: ProfileTab) => void
  projectCount: number
}) {
  const tabs: Array<{ key: ProfileTab; label: string; count?: number }> = [
    { key: 'projects', label: 'PROJECTS', count: projectCount },
    { key: 'takeoffs', label: 'TAKEOFFS', count: projectCount },
    { key: 'contact', label: 'CONTACT' },
  ]
  return (
    <div style={{ display: 'flex', borderBottom: '2px solid var(--m-ink)' }}>
      {tabs.map((t, i) => {
        const active = t.key === tab
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onTab(t.key)}
            style={{
              flex: 1,
              padding: '12px 6px',
              border: 'none',
              borderRight: i < tabs.length - 1 ? '2px solid var(--m-ink)' : 'none',
              background: active ? 'var(--m-accent)' : 'transparent',
              color: active ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.05em',
              cursor: 'pointer',
            }}
          >
            {t.label}
            {typeof t.count === 'number' ? ` · ${t.count}` : ''}
          </button>
        )
      })}
    </div>
  )
}

function ContactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '14px 16px',
        borderTop: '1px solid var(--m-line-2)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 14, fontWeight: 600, textAlign: 'right', minWidth: 0 }}>{value}</span>
    </div>
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

// ===========================================================================
// DESKTOP — dense client roster table (Desktop v2). Same lifetime-value /
// win-rate math as the mobile list; adds an "Org" column, a "HOT" pill on the
// top-value / actively-working clients, the CLIENTS · EMPTY STATE, and an
// "Add client" modal (useCreateCustomer). Reuses the shared `components/d`
// primitives.
// ===========================================================================

// `progress|active` status → an actively-working client (drives the HOT pill).
const isActiveStatus = (s: string) => /progress|active/i.test(s)

type DesktopClientRow = {
  id: string
  name: string
  org: string
  projectCount: number
  lifetimeValue: number
  wins: number
  decided: number
  activeProjects: number
  hot: boolean
}

function OwnerClientsDesktop() {
  const navigate = useNavigate()
  const customersQuery = useCustomers()
  const projectsQuery = useProjects()
  const [modalOpen, setModalOpen] = useState(false)

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

    const rows: DesktopClientRow[] = customers.map((c) => {
      const ps = byCustomer.get(c.id) ?? []
      let lifetimeValue = 0
      let wins = 0
      let decided = 0
      let activeProjects = 0
      for (const p of ps) {
        lifetimeValue += Number(p.bid_total) || 0
        if (isWon(p.status)) {
          wins += 1
          decided += 1
        } else if (isLost(p.status)) {
          decided += 1
        }
        if (isActiveStatus(p.status)) activeProjects += 1
      }
      totalLifetime += lifetimeValue
      totalWins += wins
      totalDecided += decided
      if (ps.length > 0) activeCount += 1
      // Org column = roster origin (QBO-matched vs Sitelayer-native) — the
      // only org-shaped real field on the customer record. external_id
      // present means it's mapped to a QBO customer.
      const org = c.external_id ? 'QuickBooks' : c.source && c.source !== 'sitelayer' ? c.source : 'Sitelayer'
      return {
        id: c.id,
        name: c.name,
        org,
        projectCount: ps.length,
        lifetimeValue,
        wins,
        decided,
        activeProjects,
        hot: false, // filled in below once the value threshold is known
      }
    })

    // HOT pill — a client with active work AND top-quartile lifetime value
    // among clients with any value. Cheap, derived, no new data.
    const valued = rows
      .map((r) => r.lifetimeValue)
      .filter((v) => v > 0)
      .sort((a, b) => b - a)
    const hotThreshold = valued.length > 0 ? valued[Math.floor(valued.length * 0.25)]! : Infinity
    for (const r of rows) {
      r.hot = r.activeProjects > 0 && r.lifetimeValue >= hotThreshold && r.lifetimeValue > 0
    }

    rows.sort((a, b) => b.lifetimeValue - a.lifetimeValue)
    return { rows, totalLifetime, totalWins, totalDecided, activeCount }
  }, [customers, projects])

  const overallWinRate = totalDecided > 0 ? Math.round((totalWins / totalDecided) * 100) : null

  const columns: Array<DColumn<DesktopClientRow>> = [
    {
      key: 'name',
      header: 'Client',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="d-table-cell-strong">{r.name}</span>
          {r.hot ? <MPill tone="accent">HOT</MPill> : null}
        </span>
      ),
    },
    // ORG renders as plain descriptive copy (not a status pill) per dsg__37.
    { key: 'org', header: 'Org', render: (r) => r.org },
    { key: 'projects', header: 'Projects', numeric: true, render: (r) => r.projectCount },
    {
      key: 'winRate',
      header: 'Win rate',
      numeric: true,
      render: (r) => (r.decided > 0 ? `${Math.round((r.wins / r.decided) * 100)}%` : '—'),
    },
    { key: 'lifetime', header: 'Lifetime $', numeric: true, render: (r) => formatMoney(r.lifetimeValue) },
  ]

  const addClientButton = (
    <MButton size="sm" variant="primary" onClick={() => setModalOpen(true)}>
      Add client
    </MButton>
  )

  return (
    <div className="d-content">
      <div className="d-stack">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <DEyebrow>Owner · Clients</DEyebrow>
            <DH1>
              {customers.length} {customers.length === 1 ? 'client' : 'clients'}.
            </DH1>
          </div>
          {addClientButton}
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

        {customers.length === 0 ? (
          // CLIENTS · EMPTY STATE — DEmptyState + ADD CLIENT (design DClientsEmpty).
          <DEmptyState
            title="No clients yet"
            body="Add your first client, or they'll appear here automatically when you create a project or send a bid."
            action={addClientButton}
          />
        ) : (
          <DataTable<DesktopClientRow>
            title="Client roster"
            action={addClientButton}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/desktop/clients/${r.id}`)}
            empty="No clients yet. New accounts land here once they're added."
          />
        )}
      </div>

      <AddClientModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}

/**
 * ADD CLIENT modal — a minimal functional `DModal` form. There is no
 * pre-built client modal in project-drawers.tsx (its modals are
 * project/send/assignment surfaces only), so this is a small native form
 * that reuses the existing `useCreateCustomer` hook. On success the
 * customer list invalidates (TanStack) and the modal closes. No new
 * endpoints.
 */
function AddClientModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createCustomer = useCreateCustomer()
  const nameId = useId()

  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameError = touched && name.trim().length === 0 ? 'Client name is required.' : null
  const busy = createCustomer.isPending
  const canSubmit = name.trim().length > 0 && !busy

  const handleClose = () => {
    setName('')
    setTouched(false)
    setError(null)
    onClose()
  }

  const handleSubmit = async () => {
    setTouched(true)
    if (!canSubmit) return
    setError(null)
    try {
      await createCustomer.mutateAsync({ name: name.trim() })
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const sectionLabel: React.CSSProperties = {
    fontFamily: 'var(--m-num)',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--m-ink-3)',
    letterSpacing: '0.06em',
    marginBottom: 6,
  }

  return (
    <DModal
      open={open}
      onClose={handleClose}
      width={480}
      title={
        <span
          className="num"
          style={{ fontWeight: 800, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}
        >
          ADD CLIENT
        </span>
      }
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={handleClose}>
            Cancel
          </MButton>
          <MButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? 'Adding…' : 'Add client'}
          </MButton>
        </div>
      }
    >
      <label htmlFor={nameId} style={{ display: 'block' }}>
        <span style={sectionLabel}>CLIENT NAME</span>
        <MInput
          id={nameId}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Foxridge Homes"
          aria-invalid={nameError ? true : undefined}
          autoFocus
          style={{ width: '100%' }}
        />
        {nameError ? (
          <p style={{ marginTop: 6, marginBottom: 0, color: 'var(--m-red)', fontSize: 12 }}>{nameError}</p>
        ) : null}
      </label>
      {error ? <div style={{ color: 'var(--m-red)', fontSize: 13, marginTop: 14 }}>{error}</div> : null}
    </DModal>
  )
}
