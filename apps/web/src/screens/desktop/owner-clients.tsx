/**
 * Owner desktop CLIENTS — a dense client roster table (Desktop v2).
 * Mirrors the mobile clients data approach (screens/mobile/clients.tsx):
 * lifetime value = Σ project bid_total per client, win rate = won/(won+lost).
 * Reuses the same hooks (`useCustomers`, `useProjects`, `useCreateCustomer`)
 * and the shared `components/d` primitives — no new global CSS, only
 * var(--m-*) tokens.
 *
 * Adds the design's CLIENTS · EMPTY STATE (DEmptyState + ADD CLIENT), an
 * "Org" column (origin: QBO vs Sitelayer), and a "HOT" pill on the
 * top-value / actively-working clients.
 */
import { useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCustomers, useCreateCustomer } from '@/lib/api/customers'
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
} from '@/components/d'
import { MButton, MInput, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

// Shared project classification — mirrors the mobile clients taxonomy.
// "Won" = the deal landed; "lost" = declined/archived. Win rate is
// won / (won + lost) so still-open bids don't drag it down.
const isWon = (s: string) => /accept|progress|active|complete|done|closeout|paid/i.test(s)
const isLost = (s: string) => /declin|lost|void|archive/i.test(s)
const isActiveStatus = (s: string) => /progress|active/i.test(s)

type ClientRow = {
  id: string
  name: string
  org: string
  projectCount: number
  lifetimeValue: number
  wins: number
  decided: number
  activeProjects: number
  hot: boolean
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

    const rows: ClientRow[] = customers.map((c) => {
      const ps = byCustomer.get(c.id) ?? []
      let lifetimeValue = 0
      let wins = 0
      let decided = 0
      let activeProjects = 0
      let lastProjectAt: string | null = null
      for (const p of ps) {
        lifetimeValue += Number(p.bid_total) || 0
        if (isWon(p.status)) {
          wins += 1
          decided += 1
        } else if (isLost(p.status)) {
          decided += 1
        }
        if (isActiveStatus(p.status)) activeProjects += 1
        if (!lastProjectAt || p.created_at > lastProjectAt) lastProjectAt = p.created_at
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
        lastProjectAt,
      }
    })

    // HOT pill — a client with active work AND top-quartile lifetime value
    // among clients with any value. Cheap, derived, no new data.
    const valued = rows.map((r) => r.lifetimeValue).filter((v) => v > 0).sort((a, b) => b - a)
    const hotThreshold = valued.length > 0 ? valued[Math.floor(valued.length * 0.25)]! : Infinity
    for (const r of rows) {
      r.hot = r.activeProjects > 0 && r.lifetimeValue >= hotThreshold && r.lifetimeValue > 0
    }

    rows.sort((a, b) => b.lifetimeValue - a.lifetimeValue)
    return { rows, totalLifetime, totalWins, totalDecided, activeCount }
  }, [customers, projects])

  const overallWinRate = totalDecided > 0 ? Math.round((totalWins / totalDecided) * 100) : null

  const columns: Array<DColumn<ClientRow>> = [
    {
      key: 'name',
      header: 'Client',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="d-table-cell-strong">{r.name}</span>
          {r.hot ? <MPill tone="red">HOT</MPill> : null}
        </span>
      ),
    },
    { key: 'org', header: 'Org', render: (r) => <MPill tone={r.org === 'QuickBooks' ? 'green' : undefined}>{r.org}</MPill> },
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

  const addClientButton = (
    <MButton size="sm" variant="primary" onClick={() => setModalOpen(true)}>
      Add client
    </MButton>
  )

  return (
    <div className="d-content">
      <div className="d-stack">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
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
            body="New accounts land here once they're added. Add your first client to get started."
            action={addClientButton}
          />
        ) : (
          <DataTable<ClientRow>
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
        <span className="num" style={{ fontWeight: 800, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
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
        {nameError ? <p style={{ marginTop: 6, marginBottom: 0, color: 'var(--m-red)', fontSize: 12 }}>{nameError}</p> : null}
      </label>
      {error ? <div style={{ color: 'var(--m-red)', fontSize: 13, marginTop: 14 }}>{error}</div> : null}
    </DModal>
  )
}
