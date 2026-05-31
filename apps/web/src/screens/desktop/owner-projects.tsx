/**
 * Owner desktop projects — the dense, scannable project ledger (Desktop v2 · 02).
 * Same bootstrap data as the mobile owner home; a filterable dense table.
 * Layout reference: "OWNER 02 · PROJECTS · DENSE TABLE" + "PROJECTS · ERROR
 * STATE" in the desktop template (DProjectsError / DStateEmpty primitives).
 */
import { useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse, ProjectRow } from '@/lib/api'
import { apiPost, getActiveCompanySlug } from '@/lib/api'
import { DataTable, DEmptyState, DErrorState, DEyebrow, DH1, DLoadingState, DModal, type DColumn } from '@/components/d'
import { MButton, MChip, MChipRow, MInput, MPill } from '@/components/m'
import { CustomerDedupPicker, type CustomerMatch } from '../mobile/customer-dedup-picker.js'
import { formatMoney, formatStatusLabel, statusTone } from '../mobile/format.js'

// Filter chips aligned to the design (ALL / ACTIVE / BID / COMPLETE / LOST).
type ProjectFilter = 'all' | 'active' | 'bid' | 'complete' | 'lost'

const FILTERS: Array<{ key: ProjectFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'bid', label: 'Bid' },
  { key: 'complete', label: 'Complete' },
  { key: 'lost', label: 'Lost' },
]

const DIVISIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const

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
  if (filter === 'active') return /progress|active/.test(s)
  if (filter === 'bid') return /estim|sent|await|draft|bid|lead/.test(s)
  if (filter === 'complete') return /done|close|complete|paid/.test(s)
  // lost
  return /declin|lost|void|archive/.test(s)
}

/** Dense progress bar (Desktop v2 · DProgressBar) — 2px-ruled fill on the sand track. */
function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div
        aria-hidden
        style={{
          flex: 1,
          height: 8,
          background: 'var(--m-sand-2)',
          border: '1px solid var(--m-line-2)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${clamped}%`,
            height: '100%',
            background: clamped >= 100 ? 'var(--m-green)' : 'var(--m-accent)',
          }}
        />
      </div>
      <span
        className="num"
        style={{ fontSize: 11, fontWeight: 700, color: 'var(--m-ink-2)', minWidth: 34, textAlign: 'right' }}
      >
        {clamped}%
      </span>
    </div>
  )
}

export function OwnerProjects({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [modalOpen, setModalOpen] = useState(false)

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])

  // Most-recent projects/takeoffs surfaced as attach candidates in the new-project
  // modal's "FROM A BLUEPRINT · OPTIONAL" card (design dsg__40).
  const recentTakeoffs = useMemo(
    () => [...projects].sort((a, b) => (b.created_at < a.created_at ? -1 : 1)).slice(0, 5),
    [projects],
  )

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

  const rows = useMemo(() => allRows.filter((r) => matchesFilter(r.status, filter)), [allRows, filter])

  const activeCount = useMemo(() => allRows.filter((r) => matchesFilter(r.status, 'active')).length, [allRows])

  // Per-bucket counts for the filter chips (ALL · 23, ACTIVE · 3, …),
  // matching the design's inline-count pills.
  const filterCounts = useMemo<Record<ProjectFilter, number>>(
    () => ({
      all: allRows.length,
      active: allRows.filter((r) => matchesFilter(r.status, 'active')).length,
      bid: allRows.filter((r) => matchesFilter(r.status, 'bid')).length,
      complete: allRows.filter((r) => matchesFilter(r.status, 'complete')).length,
      lost: allRows.filter((r) => matchesFilter(r.status, 'lost')).length,
    }),
    [allRows],
  )

  // Column order + headers mirror the design's dense table:
  // PROJECT · CLIENT · STATE · PROGRESS · VALUE · MARGIN (value before margin).
  const columns: Array<DColumn<ProjectTableRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'customer', header: 'Client', render: (r) => r.customer || '—' },
    {
      key: 'status',
      header: 'State',
      render: (r) => (
        <MPill tone={statusTone(r.status)} dot>
          {formatStatusLabel(r.status)}
        </MPill>
      ),
    },
    { key: 'progress', header: 'Progress', render: (r) => <ProgressBar pct={r.pctComplete} /> },
    { key: 'value', header: 'Value', numeric: true, render: (r) => formatMoney(r.bidValue) },
    {
      key: 'margin',
      header: 'Margin',
      numeric: true,
      render: (r) => `${Math.round(r.margin * 100)}%`,
    },
  ]

  const newProjectButton = (
    <MButton size="sm" variant="primary" onClick={() => setModalOpen(true)}>
      New project
    </MButton>
  )

  // The screen is bootstrap-prop-driven (no query status in scope). `null`
  // is the normal not-yet-loaded state while the shell's bootstrap query is
  // in flight, so render the LOADING surface rather than flashing an error.
  if (!bootstrap) {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Owner · Projects</DEyebrow>
            <DH1>Projects</DH1>
          </div>
          <DLoadingState label="Loading the project ledger…" />
        </div>
      </div>
    )
  }

  // PROJECTS · ERROR STATE — bootstrap resolved but is structurally
  // unusable (no projects array). This is the design's DProjectsError
  // surface; offer a retry that re-fetches the shell.
  if (!Array.isArray(bootstrap.projects)) {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Owner · Projects</DEyebrow>
            <DH1>Projects</DH1>
          </div>
          <DErrorState
            title="Projects didn't load"
            body="We couldn't reach the server. Cached projects may be stale."
            code="SLR_504 · /projects"
            actions={
              <div style={{ display: 'flex', gap: 8 }}>
                <MButton size="sm" variant="primary" onClick={() => window.location.reload()}>
                  Try again
                </MButton>
                <MButton size="sm" variant="ghost" onClick={() => navigate('/desktop/messages')}>
                  Report
                </MButton>
              </div>
            }
          />
        </div>
      </div>
    )
  }

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
            <DEyebrow>
              {allRows.length} TOTAL · {activeCount} ACTIVE
            </DEyebrow>
            <DH1>Projects</DH1>
          </div>
          {newProjectButton}
        </div>

        {/* Filter chips with inline per-bucket counts (ALL · 23, ACTIVE · 3, …),
            matching the dense-table design. No KPI tiles above the table — the
            eyebrow carries the at-a-glance total/active counts instead. */}
        <MChipRow>
          {FILTERS.map((f) => (
            <MChip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label} · {filterCounts[f.key]}
            </MChip>
          ))}
        </MChipRow>

        {allRows.length === 0 ? (
          // PROJECTS · EMPTY STATE — the book is genuinely empty (bootstrap
          // loaded fine, just no projects yet). Design's DStateEmpty surface.
          <DEmptyState
            title="No projects yet"
            body="New jobs land here once they kick off. Start one to fill the book."
            action={newProjectButton}
          />
        ) : (
          <DataTable<ProjectTableRow>
            title="Projects"
            action={newProjectButton}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/desktop/projects/${r.id}`)}
            empty="No projects match this filter."
          />
        )}
      </div>

      <NewProjectFormModal open={modalOpen} onClose={() => setModalOpen(false)} recent={recentTakeoffs} />
    </div>
  )
}

/**
 * NEW PROJECT modal (Desktop v2 · DNewProjectModal).
 *
 * The exported `NewProjectModal` in project-drawers.tsx is a purely
 * presentational port (static demo data, no onSubmit), so it can't actually
 * create a project. This is a minimal functional `DModal` form that reuses
 * the EXACT create logic from owner-new-project.tsx — the same
 * `apiPost('/api/projects', …)` body shape and field set (name, client,
 * division, starting state, bid value). On success it navigates to the
 * desktop project detail route. No new endpoints.
 */
function NewProjectFormModal({
  open,
  onClose,
  recent,
}: {
  open: boolean
  onClose: () => void
  recent: ProjectRow[]
}) {
  const navigate = useNavigate()
  const companySlug = getActiveCompanySlug()

  const nameId = useId()
  const clientId = useId()

  const [name, setName] = useState('')
  const [customerName, setCustomerName] = useState('')
  // When the typed name is linked to an existing roster customer (via the
  // dedup picker) we carry its id so create attaches to the same record.
  const [linkedCustomer, setLinkedCustomer] = useState<CustomerMatch | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [divisionCode, setDivisionCode] = useState<(typeof DIVISIONS)[number]>('D4')
  // The design's segmented control offers BID / PROJECT / LEAD; PROJECT maps
  // to the API `in_progress` status, BID and LEAD both map to `lead`.
  const [startingLabel, setStartingLabel] = useState<'BID' | 'PROJECT' | 'LEAD'>('BID')
  const [bidTotal, setBidTotal] = useState('')
  // The optional "FROM A BLUEPRINT" attach card — when a takeoff/project is
  // attached we carry its bid/division/customer through to create.
  const [attached, setAttached] = useState<ProjectRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const nameError = touched && name.trim().length === 0 ? 'Project name is required.' : null
  const clientError = touched && customerName.trim().length === 0 ? 'Client name is required.' : null
  const canSubmit = name.trim().length > 0 && customerName.trim().length > 0 && !busy

  // The single candidate takeoff offered in the design's attach card.
  const candidate = recent[0] ?? null

  const reset = () => {
    setName('')
    setCustomerName('')
    setLinkedCustomer(null)
    setDismissedFor(null)
    setDivisionCode('D4')
    setStartingLabel('BID')
    setBidTotal('')
    setAttached(null)
    setBusy(false)
    setError(null)
    setTouched(false)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const handleClientChange = (value: string) => {
    setCustomerName(value)
    if (linkedCustomer) setLinkedCustomer(null)
    if (dismissedFor !== null) setDismissedFor(null)
  }

  const handleLinkCustomer = (match: CustomerMatch) => {
    setLinkedCustomer(match)
    setCustomerName(match.qboLabel ?? match.customer.name)
    setDismissedFor(null)
  }

  // Toggle the attach card: pull name fallback + client + bid + division from
  // the candidate takeoff, or detach and clear those carried-over values.
  const toggleAttach = () => {
    if (attached) {
      setAttached(null)
      return
    }
    if (!candidate) return
    setAttached(candidate)
    if (!name.trim()) setName(candidate.name)
    setCustomerName(candidate.customer_name)
    setLinkedCustomer(null)
    setDismissedFor(candidate.customer_name.trim())
    if ((DIVISIONS as readonly string[]).includes(candidate.division_code)) {
      setDivisionCode(candidate.division_code as (typeof DIVISIONS)[number])
    }
    setBidTotal(Number(candidate.bid_total) ? String(Number(candidate.bid_total)) : '')
  }

  const handleSubmit = async () => {
    setTouched(true)
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const customerLink = linkedCustomer?.customer.id ?? (attached ? attached.customer_id : null) ?? null
      const created = await apiPost<{ id: string }>(
        '/api/projects',
        {
          name: name.trim(),
          customer_name: customerName.trim(),
          ...(customerLink ? { customer_id: customerLink } : {}),
          division_code: divisionCode,
          bid_total: bidTotal ? Number(bidTotal) : 0,
          // Map the design's starting-state segmented control to the API
          // status taxonomy (BID/LEAD → lead, PROJECT → in_progress).
          status: startingLabel === 'PROJECT' ? 'in_progress' : 'lead',
        },
        companySlug,
      )
      handleClose()
      navigate(`/desktop/projects/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const sectionLabel: React.CSSProperties = {
    fontFamily: 'var(--m-num)',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--m-ink-3)',
    letterSpacing: '0.06em',
    marginBottom: 6,
    display: 'block',
  }

  const STARTING_STATES: Array<'BID' | 'PROJECT' | 'LEAD'> = ['BID', 'PROJECT', 'LEAD']

  // Surface the dedup picker only while the client is freely typed (not linked,
  // not carried over from an attached takeoff, not dismissed).
  const showDedup = !linkedCustomer && dismissedFor !== customerName.trim()

  return (
    <DModal
      open={open}
      onClose={handleClose}
      title={
        <span
          className="num"
          style={{ fontWeight: 800, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}
        >
          NEW PROJECT
        </span>
      }
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={handleClose}>
            Cancel
          </MButton>
          <MButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? 'Creating…' : 'Create project'}
          </MButton>
        </div>
      }
    >
      <label htmlFor={nameId} style={{ display: 'block' }}>
        <span style={sectionLabel}>PROJECT NAME</span>
        <MInput
          id={nameId}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Crestline North Annex"
          aria-invalid={nameError ? true : undefined}
          style={{ width: '100%' }}
        />
        {nameError ? (
          <p style={{ marginTop: 6, marginBottom: 0, color: 'var(--m-red)', fontSize: 12 }}>{nameError}</p>
        ) : null}
      </label>

      {/* CLIENT (QBO-matched dedup picker) + STARTING STATE, matching dsg__40. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, marginTop: 16 }}>
        <label htmlFor={clientId} style={{ display: 'block' }}>
          <span style={sectionLabel}>CLIENT</span>
          <MInput
            id={clientId}
            value={customerName}
            onChange={(e) => handleClientChange(e.currentTarget.value)}
            placeholder="John Marchetti"
            aria-invalid={clientError ? true : undefined}
            style={{ width: '100%' }}
          />
          {clientError ? (
            <p style={{ marginTop: 6, marginBottom: 0, color: 'var(--m-red)', fontSize: 12 }}>{clientError}</p>
          ) : null}
          {linkedCustomer ? (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--m-num)', fontSize: 9, fontWeight: 700, color: 'var(--m-green)' }}>
                ✓ MATCHED IN QBO · NO DUPE
              </span>
              <button
                type="button"
                onClick={() => setLinkedCustomer(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--m-ink-3)',
                  fontSize: 11,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                }}
              >
                Unlink
              </button>
            </div>
          ) : null}
        </label>
        <div>
          <span style={sectionLabel}>STARTING STATE</span>
          <div style={{ display: 'flex', border: '2px solid var(--m-ink)' }}>
            {STARTING_STATES.map((label, i, arr) => {
              const active = startingLabel === label
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setStartingLabel(label)}
                  style={{
                    flex: 1,
                    padding: '12px 0',
                    textAlign: 'center',
                    background: active ? 'var(--m-accent)' : 'transparent',
                    color: active ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                    border: 'none',
                    borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                    fontFamily: 'var(--m-num)',
                    fontSize: 9,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                  aria-pressed={active}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* QBO dedup suggestions — same component the kickoff details form uses. */}
      {showDedup ? (
        <div style={{ marginTop: 4, marginLeft: -16, marginRight: -16 }}>
          <CustomerDedupPicker
            typedName={customerName}
            linkedCustomerId={null}
            onLink={handleLinkCustomer}
            onCreateNew={() => setDismissedFor(customerName.trim())}
          />
        </div>
      ) : null}

      {/* FROM A BLUEPRINT · OPTIONAL — attach a recent takeoff to seed the job
          (design dsg__40 accent card). */}
      {candidate ? (
        <div style={{ marginTop: 16 }}>
          <span style={sectionLabel}>FROM A BLUEPRINT · OPTIONAL</span>
          <div
            style={{
              padding: '12px 14px',
              border: '2px solid var(--m-ink)',
              background: attached ? 'var(--m-accent)' : 'var(--m-card-soft)',
              color: attached ? 'var(--m-accent-ink)' : 'var(--m-ink)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {candidate.name}
                {Number(candidate.target_sqft_per_hr) ? ` · ${Number(candidate.target_sqft_per_hr).toLocaleString('en-US')} SF` : ''}
              </div>
              <div style={{ fontFamily: 'var(--m-num)', fontSize: 9, marginTop: 2, fontWeight: 600 }}>
                {(candidate.customer_name || 'NO CLIENT').toUpperCase()}
                {Number(candidate.bid_total) ? ` · ${formatMoney(Number(candidate.bid_total))}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={toggleAttach}
              aria-pressed={attached ? true : undefined}
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: '0.06em',
                background: 'none',
                border: '1.5px solid var(--m-ink)',
                color: 'inherit',
                padding: '4px 8px',
                cursor: 'pointer',
              }}
            >
              {attached ? 'ATTACHED' : 'ATTACH'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <div style={{ color: 'var(--m-red)', fontSize: 13, marginTop: 14 }}>{error}</div> : null}
    </DModal>
  )
}
