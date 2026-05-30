/**
 * Owner desktop PROJECT DETAIL — split + budget aside + 6 tabs (Desktop v2 · 03).
 * Reuses the exact per-tab data hooks the mobile project-detail tabs use
 * (useProjectLaborVariance, useProjectCloseoutSummary, useDailyLogs,
 * useProjectBlueprints, useProjectChangeOrders, useProjectTimeline); just a
 * dense desktop composition. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md and
 * /tmp/desktop_template.html "PROJECT DETAIL · SPLIT + BUDGET ASIDE".
 *
 * Parent (DesktopWorkspace) wires the route + passes bootstrap. Project
 * name/status/labor-rate come from the bootstrap projects list (no single
 * desktop project hook), found by :projectId; falls back to the projects
 * list hook so a deep-linked project that isn't in bootstrap still resolves,
 * else a graceful empty state.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import type { ProjectRow } from '@/lib/api'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, DTabBar, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { useProjects } from '@/lib/api/projects'
import { useProjectTimeline, type ProjectTimelineEvent } from '@/lib/api/projects'
import { useProjectLaborVariance, type LaborVarianceRow } from '@/lib/api/labor-variance'
import { useProjectCloseoutSummary } from '@/lib/api/closeout-summary'
import { useDailyLogs, type DailyLog } from '@/lib/api/daily-logs'
import { useProjectBlueprints, type BlueprintDocument } from '@/lib/api/takeoff'
import { useProjectChangeOrders, type ChangeOrder } from '@/lib/api/change-orders'
import { ChangeOrderDrawer, InvoiceModal, PostMortemDrawer, RecoveryDrawer } from './project-drawers'
import { formatMoney, formatStatusLabel, shortDate } from '../mobile/format.js'

type ProjectOverlay = 'recovery' | 'change-order' | 'post-mortem' | 'invoice' | null

type TabKey = 'overview' | 'budget' | 'crew' | 'logs' | 'files' | 'activity'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'budget', label: 'Budget' },
  { key: 'crew', label: 'Crew' },
  { key: 'logs', label: 'Logs' },
  { key: 'files', label: 'Files' },
  { key: 'activity', label: 'Activity' },
]

export function OwnerProjectDetail({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const [tab, setTab] = useState<TabKey>('overview')
  const [overlay, setOverlay] = useState<ProjectOverlay>(null)

  // Project identity — prefer bootstrap (already in-memory for the desktop
  // shell). If a deep link lands on a project that isn't in the bootstrap
  // window, fall back to the projects list hook (only fetched when missing).
  const fromBootstrap = bootstrap?.projects.find((p) => p.id === projectId) ?? null
  const projectsQuery = useProjects({}, { enabled: !fromBootstrap && Boolean(projectId) })
  const fromList = projectsQuery.data?.projects.find((p) => p.id === projectId) ?? null

  const name = fromBootstrap?.name ?? fromList?.name ?? null
  const status = fromBootstrap?.status ?? fromList?.status ?? null
  // Change Order + Invoice only make sense once a project is actually being
  // worked/billed — never on a LEAD (pre-contract) project. Allow-list of
  // billable statuses (robust against the loose `ProjectStatus` string union).
  const showBilling = ['active', 'in_progress', 'accepted', 'completed', 'done'].includes(status ?? '')
  const customer = fromBootstrap?.customer_name ?? fromList?.customer_name ?? '—'
  const bidTotal = Number(fromBootstrap?.bid_total ?? fromList?.bid_total ?? 0)
  const laborRate = Number(fromBootstrap?.labor_rate ?? 0)

  // Labor scoped to this project, from bootstrap (same source the mobile
  // crew/budget tabs use). Drives spend, days-left, and the Crew table.
  const labor = useMemo(
    () => (bootstrap?.laborEntries ?? []).filter((l) => l.project_id === projectId && !l.deleted_at),
    [bootstrap?.laborEntries, projectId],
  )
  const workers = bootstrap?.workers ?? []
  const schedules = useMemo(
    () => (bootstrap?.schedules ?? []).filter((s) => s.project_id === projectId),
    [bootstrap?.schedules, projectId],
  )

  const totalHours = labor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
  const spent = totalHours * laborRate
  const pctSpent = bidTotal > 0 ? Math.round((spent / bidTotal) * 100) : 0
  const completePct = Math.min(100, pctSpent) // proxy: spend pace vs bid
  const dayCount = schedules.length
  const planDays = Math.max(dayCount, 14)
  const daysLeft = Math.max(0, planDays - dayCount)
  const onTrack = pctSpent <= 75

  // Loading / not-found: bootstrap absent and the fallback list still resolving.
  if (!name) {
    if (projectsQuery.isPending && !fromBootstrap) {
      return (
        <div className="d-content">
          <div style={{ color: 'var(--m-ink-3)' }}>Loading project…</div>
        </div>
      )
    }
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Project</DEyebrow>
            <DH1>Project not found</DH1>
          </div>
          <div className="d-card" style={{ color: 'var(--m-ink-2)' }}>
            This project may have been archived or you may not have access.
            <div style={{ marginTop: 14 }}>
              <MButton variant="primary" onClick={() => navigate('/desktop/projects')}>
                Back to projects
              </MButton>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const project = (fromBootstrap ?? fromList) as ProjectRow | null

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>
            {customer} · {status ? formatStatusLabel(status) : '—'} · D{dayCount}/{planDays}
          </DEyebrow>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
            <DH1>{name}</DH1>
            <MPill tone={onTrack ? 'green' : 'red'} dot>
              {onTrack ? 'On track' : 'At risk'}
            </MPill>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <MButton variant="primary" onClick={() => navigate(`/desktop/canvas/${projectId}`)}>
              Takeoff →
            </MButton>
            {!onTrack ? (
              <MButton variant="ghost" onClick={() => setOverlay('recovery')}>
                Recovery plan
              </MButton>
            ) : null}
            {showBilling ? (
              <>
                <MButton variant="ghost" onClick={() => setOverlay('change-order')}>
                  + Change order
                </MButton>
                <MButton variant="ghost" onClick={() => setOverlay('invoice')}>
                  Invoice
                </MButton>
              </>
            ) : null}
            {status === 'done' || status === 'archived' ? (
              <MButton variant="ghost" onClick={() => setOverlay('post-mortem')}>
                Post-mortem
              </MButton>
            ) : null}
          </div>
        </div>

        <DKpiStrip>
          <DKpi label="Complete" value={String(completePct)} unit="%" meta="Spend pace vs bid" />
          <DKpi
            label="Margin"
            value={bidTotal > 0 ? String(Math.round(((bidTotal - spent) / bidTotal) * 100)) : '—'}
            unit={bidTotal > 0 ? '%' : undefined}
            meta="Remaining of bid"
          />
          <DKpi
            label="Spent"
            value={formatMoney(spent)}
            tone={onTrack ? undefined : 'accent'}
            meta={`of ${formatMoney(bidTotal)} bid`}
          />
          <DKpi label="Days left" value={String(daysLeft)} meta={`Day ${dayCount} of ${planDays}`} />
        </DKpiStrip>

        <DTabBar tabs={[...TABS]} active={tab} onSelect={(k) => setTab(k as TabKey)} />

        <div className="d-split">
          <div className="d-stack">
            {tab === 'overview' && (
              <OverviewTab
                name={name}
                customer={customer}
                bid={bidTotal}
                division={project?.division_code}
                projectId={projectId}
              />
            )}
            {tab === 'budget' && <BudgetTab projectId={projectId} spent={spent} bid={bidTotal} pctSpent={pctSpent} />}
            {tab === 'crew' && <CrewTab labor={labor} workers={workers} />}
            {tab === 'logs' && <LogsTab projectId={projectId} />}
            {tab === 'files' && <FilesTab projectId={projectId} />}
            {tab === 'activity' && <ActivityTab projectId={projectId} />}
          </div>

          <BudgetAside
            projectId={projectId}
            bid={bidTotal}
            spent={spent}
            pctSpent={pctSpent}
            totalHours={totalHours}
            laborRate={laborRate}
            navigate={navigate}
          />
        </div>
      </div>
      <RecoveryDrawer
        open={overlay === 'recovery'}
        onClose={() => setOverlay(null)}
        projectId={projectId}
        daysLeft={daysLeft}
        bidTotal={bidTotal}
        laborRate={laborRate}
        spent={spent}
      />
      <ChangeOrderDrawer open={overlay === 'change-order'} projectId={projectId} onClose={() => setOverlay(null)} />
      <PostMortemDrawer open={overlay === 'post-mortem'} onClose={() => setOverlay(null)} projectId={projectId} />
      <InvoiceModal
        open={overlay === 'invoice'}
        onClose={() => setOverlay(null)}
        projectId={projectId}
        projectName={name}
        customerName={customer}
        contractValue={bidTotal}
      />
    </div>
  )
}

// ---- Overview ------------------------------------------------------------
function OverviewTab({
  name,
  customer,
  bid,
  division,
  projectId,
}: {
  name: string
  customer: string
  bid: number
  division?: string | null | undefined
  projectId: string
}) {
  const timeline = useProjectTimeline(projectId)
  const recent = (timeline.data?.events ?? []).slice(0, 6)
  return (
    <>
      <div className="d-card">
        <div className="d-eyebrow">Summary</div>
        <div style={{ marginTop: 10, fontSize: 15, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>
          {name} — a {formatMoney(bid)} {division ?? ''} job for {customer}.
        </div>
      </div>
      <ActivityList
        title="Recent activity"
        events={recent}
        pending={timeline.isPending}
        error={timeline.isError}
        compact
      />
    </>
  )
}

// ---- Budget --------------------------------------------------------------
function BudgetTab({
  projectId,
  spent,
  bid,
  pctSpent,
}: {
  projectId: string
  spent: number
  bid: number
  pctSpent: number
}) {
  const variance = useProjectLaborVariance(projectId)
  const summary = useProjectCloseoutSummary(projectId)
  const rows = variance.data?.variance ?? []
  const s = summary.data

  const columns: Array<DColumn<LaborVarianceRow>> = [
    {
      key: 'code',
      header: 'Cost code',
      render: (r) => <span className="d-table-cell-strong">{r.service_item_code}</span>,
    },
    { key: 'division', header: 'Division', render: (r) => r.division_code ?? '—' },
    {
      key: 'qty',
      header: 'Actual / Est',
      numeric: true,
      render: (r) => `${fmtQty(r.actual_quantity)} / ${fmtQty(r.estimated_quantity)} ${r.unit || 'sqft'}`,
    },
    {
      key: 'variance',
      header: 'Variance',
      numeric: true,
      render: (r) => {
        const pct = r.hours_variance_pct
        const abs = Math.abs(pct)
        const hasEst = r.estimated_quantity > 0 || r.estimated_hours > 0
        const tone: 'green' | 'amber' | 'red' = abs < 10 ? 'green' : abs <= 25 ? 'amber' : 'red'
        const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
        return hasEst ? (
          <MPill tone={tone}>{`${sign}${abs.toFixed(0)}%`}</MPill>
        ) : (
          <span style={{ color: 'var(--m-ink-3)' }}>no est.</span>
        )
      },
    },
  ]

  return (
    <>
      {/* Spend-vs-bid numbers, the bottom line the owner reads first. */}
      <div className="d-card">
        <div className="d-eyebrow">Spend vs bid</div>
        {summary.isPending ? (
          <div style={{ marginTop: 10, color: 'var(--m-ink-3)' }}>Loading closeout summary…</div>
        ) : summary.isError || !s ? (
          <div style={{ marginTop: 10, color: 'var(--m-red)' }}>Could not load closeout summary.</div>
        ) : (
          <DKpiStrip>
            <DKpi label="Bid" value={formatMoney(s.bid || bid)} />
            <DKpi label="Total actual" value={formatMoney(s.total_actual)} />
            <DKpi
              label="Margin"
              value={formatMoney(s.margin)}
              meta={s.bid > 0 ? `${s.margin_pct >= 0 ? '+' : '−'}${Math.abs(s.margin_pct).toFixed(1)}%` : undefined}
              metaTone={s.margin_pct >= 10 ? 'good' : s.margin_pct >= 0 ? undefined : 'bad'}
            />
            <DKpi label="Spent" value={formatMoney(spent)} meta={`${pctSpent}% of bid`} />
          </DKpiStrip>
        )}
      </div>

      <DataTable<LaborVarianceRow>
        title="Spend by cost code"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.service_item_code}
        empty={
          variance.isPending
            ? 'Loading scope variance…'
            : variance.isError
              ? 'Could not load scope variance.'
              : 'No variance data yet — labor entries with sqft_done populate this once jobs are in progress.'
        }
      />
    </>
  )
}

// ---- Crew ----------------------------------------------------------------
type CrewRow = { id: string; name: string; hours: number }

function CrewTab({
  labor,
  workers,
}: {
  labor: BootstrapResponse['laborEntries']
  workers: BootstrapResponse['workers']
}) {
  const rows = useMemo<CrewRow[]>(() => {
    const map = new Map<string, CrewRow>()
    for (const l of labor) {
      const wid = l.worker_id ?? 'unassigned'
      const name = workers.find((w) => w.id === wid)?.name ?? 'Unassigned'
      const cur = map.get(wid) ?? { id: wid, name, hours: 0 }
      cur.hours += Number(l.hours ?? 0)
      map.set(wid, cur)
    }
    return Array.from(map.values()).sort((a, b) => b.hours - a.hours)
  }, [labor, workers])

  const columns: Array<DColumn<CrewRow>> = [
    { key: 'name', header: 'Crew member', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'hours', header: 'Hours', numeric: true, render: (r) => `${r.hours.toFixed(1)}h` },
  ]
  return (
    <DataTable<CrewRow>
      title="Assigned crew"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      empty="No labor entries logged yet."
    />
  )
}

// ---- Logs ----------------------------------------------------------------
function LogsTab({ projectId }: { projectId: string }) {
  const query = useDailyLogs({ projectId })
  const logs = useMemo(
    () => [...(query.data?.dailyLogs ?? [])].sort((a, b) => (b.occurred_on ?? '').localeCompare(a.occurred_on ?? '')),
    [query.data?.dailyLogs],
  )

  const columns: Array<DColumn<DailyLog>> = [
    {
      key: 'date',
      header: 'Date',
      render: (r) => <span className="d-table-cell-strong">{shortDate(r.occurred_on)}</span>,
    },
    { key: 'notes', header: 'Notes', render: (r) => logPreview(r) },
    {
      key: 'photos',
      header: 'Photos',
      numeric: true,
      render: (r) => String(Array.isArray(r.photo_keys) ? r.photo_keys.length : 0),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={r.status === 'submitted' ? 'green' : 'amber'} dot>
          {r.status === 'submitted' ? 'Submitted' : 'Draft'}
        </MPill>
      ),
    },
  ]
  return (
    <DataTable<DailyLog>
      title="Daily logs"
      columns={columns}
      rows={logs}
      rowKey={(r) => r.id}
      empty={
        query.isPending
          ? 'Loading daily logs…'
          : query.isError
            ? 'Could not load daily logs.'
            : 'No daily logs yet. Foreman end-of-day reports land here once the crew is on site.'
      }
    />
  )
}

// ---- Files ---------------------------------------------------------------
function FilesTab({ projectId }: { projectId: string }) {
  const query = useProjectBlueprints(projectId)
  const blueprints = (query.data?.blueprints ?? []).filter((b) => !b.deleted_at)

  const columns: Array<DColumn<BlueprintDocument>> = [
    {
      key: 'file',
      header: 'File',
      render: (r) => <span className="d-table-cell-strong">{r.file_name || 'Untitled drawing'}</span>,
    },
    { key: 'type', header: 'Type', render: (r) => (r.preview_type ? r.preview_type.toUpperCase() : '—') },
    { key: 'added_by', header: 'Added by', render: () => '—' },
    { key: 'size', header: 'Size', numeric: true, render: (r) => (r.calibration_length ? 'Scaled' : 'Set scale') },
    { key: 'date', header: 'Date', render: (r) => fmtFileDate(r.created_at) },
  ]
  return (
    <DataTable<BlueprintDocument>
      title="Files & drawings"
      columns={columns}
      rows={blueprints}
      rowKey={(r) => r.id}
      empty={
        query.isPending
          ? 'Loading drawings…'
          : query.isError
            ? 'Could not load drawings.'
            : 'No drawings yet. Drop a PDF or photo on the takeoff canvas to start measuring scope.'
      }
    />
  )
}

// ---- Activity ------------------------------------------------------------
function ActivityTab({ projectId }: { projectId: string }) {
  const timeline = useProjectTimeline(projectId)
  return (
    <ActivityList
      title="Activity timeline"
      events={timeline.data?.events ?? []}
      pending={timeline.isPending}
      error={timeline.isError}
    />
  )
}

function ActivityList({
  title,
  events,
  pending,
  error,
  compact,
}: {
  title: string
  events: ProjectTimelineEvent[]
  pending: boolean
  error: boolean
  compact?: boolean
}) {
  return (
    <div className="d-card">
      <div className="d-eyebrow">{title}</div>
      {pending ? (
        <div style={{ marginTop: 10, color: 'var(--m-ink-3)' }}>Loading activity…</div>
      ) : error ? (
        <div style={{ marginTop: 10, color: 'var(--m-red)' }}>Could not load activity.</div>
      ) : events.length === 0 ? (
        <div style={{ marginTop: 10, color: 'var(--m-ink-3)' }}>No activity recorded yet.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {(compact ? events.slice(0, 6) : events).map((ev, idx) => (
            <li
              key={ev.id}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'baseline',
                padding: '10px 0',
                borderTop: idx === 0 ? 'none' : '1px solid var(--m-line-2)',
              }}
            >
              <span style={{ width: 8, height: 8, background: 'var(--m-accent)', flexShrink: 0 }} aria-hidden />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{formatStatusLabel(ev.action)}</div>
                <div
                  className="num"
                  style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--m-ink-3)' }}
                >
                  {ev.entity_type}
                  {ev.actor_role ? ` · ${ev.actor_role}` : ''} · {shortDate(ev.created_at)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- Aside (sticky budget / quick facts + change orders) -----------------
function BudgetAside({
  projectId,
  bid,
  spent,
  pctSpent,
  totalHours,
  laborRate,
  navigate,
}: {
  projectId: string
  bid: number
  spent: number
  pctSpent: number
  totalHours: number
  laborRate: number
  navigate: (path: string) => void
}) {
  const changeOrders = useProjectChangeOrders(projectId)
  const cos = (changeOrders.data?.change_orders ?? []).slice(0, 4)
  const acceptedDelta = changeOrders.data?.accepted_value_delta ?? 0
  const remaining = bid - spent
  const tone = pctSpent < 60 ? 'green' : pctSpent < 90 ? 'amber' : 'red'

  return (
    <aside className="d-card" style={{ position: 'sticky', top: 16, alignSelf: 'start' }}>
      <div className="d-eyebrow">Budget</div>
      <Fact label="Bid" value={formatMoney(bid)} />
      <Fact label="Spent" value={formatMoney(spent)} valueTone={tone} />
      <Fact label="Remaining" value={formatMoney(remaining)} />
      <Fact label="% spent" value={`${pctSpent}%`} />

      <div className="d-eyebrow" style={{ marginTop: 22 }}>
        Quick facts
      </div>
      <Fact label="Labor logged" value={`${totalHours.toFixed(1)}h`} />
      <Fact label="Labor rate" value={`$${laborRate}/hr`} />
      <Fact
        label="Effective value"
        value={formatMoney(bid + acceptedDelta)}
        meta={`incl. ${formatMoney(acceptedDelta)} COs`}
      />

      <div
        style={{
          marginTop: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span className="d-eyebrow">Change orders</span>
        <button
          type="button"
          onClick={() => navigate(`/projects/${projectId}/change-orders`)}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-2)',
          }}
        >
          View all →
        </button>
      </div>
      {changeOrders.isPending ? (
        <div style={{ marginTop: 10, color: 'var(--m-ink-3)', fontSize: 13 }}>Loading…</div>
      ) : cos.length === 0 ? (
        <div style={{ marginTop: 10, color: 'var(--m-ink-3)', fontSize: 13 }}>No change orders.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {cos.map((co, idx) => (
            <ChangeOrderItem key={co.id} co={co} isFirst={idx === 0} />
          ))}
        </ul>
      )}
    </aside>
  )
}

function ChangeOrderItem({ co, isFirst }: { co: ChangeOrder; isFirst: boolean }) {
  const delta = Number(co.value_delta ?? 0)
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        padding: '10px 0',
        borderTop: isFirst ? 'none' : '1px solid var(--m-line-2)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          #{co.number} {co.description}
        </div>
        <div
          className="num"
          style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--m-ink-3)' }}
        >
          {formatStatusLabel(co.status)}
        </div>
      </div>
      <span className="num" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {delta >= 0 ? '+' : '−'}
        {formatMoney(Math.abs(delta))}
      </span>
    </li>
  )
}

function Fact({
  label,
  value,
  valueTone,
  meta,
}: {
  label: string
  value: string
  valueTone?: 'green' | 'amber' | 'red'
  meta?: string
}) {
  const color =
    valueTone === 'green'
      ? 'var(--m-green)'
      : valueTone === 'amber'
        ? 'var(--m-amber)'
        : valueTone === 'red'
          ? 'var(--m-red)'
          : 'var(--m-ink)'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        padding: '8px 0',
        borderTop: '1px solid var(--m-line-2)',
        marginTop: 8,
      }}
    >
      <span
        className="num"
        style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--m-ink-3)' }}
      >
        {label}
      </span>
      <span style={{ textAlign: 'right' }}>
        <span className="num" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color }}>
          {value}
        </span>
        {meta ? (
          <span
            className="num"
            style={{
              display: 'block',
              fontSize: 10,
              color: 'var(--m-ink-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {meta}
          </span>
        ) : null}
      </span>
    </div>
  )
}

// ---- helpers -------------------------------------------------------------
function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 10) return Math.round(n).toLocaleString()
  return n.toFixed(1)
}

function fmtFileDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function logPreview(log: DailyLog): string {
  const notes = (log.notes ?? '').trim()
  if (notes) return notes.length > 80 ? `${notes.slice(0, 80)}…` : notes
  return 'No notes recorded'
}
