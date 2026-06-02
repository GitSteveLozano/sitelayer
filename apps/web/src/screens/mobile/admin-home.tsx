/**
 * Owner "Today" dashboard — the calm landing surface.
 *
 * Per the design (Design Overview/estimator/screenshots/db-calm-default.png),
 * the dashboard is calm by default — when nothing's wrong, it does not
 * manufacture urgency. The hero is a one-liner ("You're caught up.")
 * followed by a today-by-default segmented control and stacked site
 * cards drawn from active projects + today's labor entries.
 *
 * Responsive (Phase B) consolidation of the desktop↔mobile owner-home twins
 * (was screens/desktop/owner-dashboard.tsx + this file). Both read the SAME
 * core guardrail signal (useActiveGuardrails) off the same bootstrap, but they
 * GENUINELY DIVERGE in composition + supporting hooks (mobile adds
 * useGuardrailAction snooze + the What-needs-me attention cards; desktop adds
 * usePendingApprovalsSummary + useFirstName + the dense site DataTable and
 * month-net/margin KPIs), so each full render is preserved verbatim behind
 * useIsDesktop(), never collapsed.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse, ProjectRow } from '@/lib/api'
import {
  MAvatar,
  MBanner,
  MBody,
  MButton,
  MChip,
  MChipRow,
  MI,
  MKpi,
  MKpiRow,
  MLargeHead,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { Spark } from '../../components/m/ai.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '../../components/d/index.js'
import { useActiveGuardrails, useGuardrailAction } from '@/lib/api/guardrails'
import { usePendingApprovalsSummary } from '@/lib/api/approvals'
import { useFirstName } from '@/lib/user'
import { useIsDesktop } from '../../lib/use-is-desktop.js'
import { formatDecimalHours, formatMoney, formatStatusLabel, statusTone, todayIso } from './format.js'

export type AdminHomeProps = {
  bootstrap: BootstrapResponse | null
}

/**
 * Responsive owner dashboard. Mounts the desktop command-center (dense site
 * DataTable + money KPIs) at >=1024px and the mobile calm "Today" surface
 * below it; only one mounts at a time so neither twin's data hooks run on the
 * wrong surface.
 */
export function AdminHome({ bootstrap }: AdminHomeProps) {
  const isDesktop = useIsDesktop()
  return isDesktop ? <OwnerDashboardDesktop bootstrap={bootstrap} /> : <AdminHomeMobile bootstrap={bootstrap} />
}

/** Desktop-route alias — kept so screens/desktop/desktop-workspace.tsx can
 *  keep importing `OwnerDashboard` after the desktop twin file was deleted. */
export const OwnerDashboard = AdminHome

function AdminHomeMobile({ bootstrap }: AdminHomeProps) {
  const navigate = useNavigate()
  const [view, setView] = useState<'today' | 'needs' | 'week' | 'all'>('today')

  // v2 Guardrail attention card — company-wide triggered monitors. View-layer
  // only: shows the highest-priority triggered guardrail above the dashboard
  // body; renders nothing when none are triggered (calm-by-default).
  const { data: guardrailsData } = useActiveGuardrails()
  const { snooze } = useGuardrailAction()
  const triggeredGuardrail = useMemo(
    () => (guardrailsData?.guardrails ?? []).find((g) => g.status === 'triggered') ?? null,
    [guardrailsData?.guardrails],
  )

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])

  const { activeProjects, todayHoursByProject, todayTotal } = useMemo(() => {
    const today = todayIso()
    const activeProjects = projects.filter((p) => isActiveStatus(p.status))
    const todayLabor = labor.filter((l) => l.occurred_on === today && !l.deleted_at)
    const map = new Map<string, number>()
    let total = 0
    for (const l of todayLabor) {
      const hours = Number(l.hours ?? 0)
      total += hours
      if (l.project_id) {
        map.set(l.project_id, (map.get(l.project_id) ?? 0) + hours)
      }
    }
    return { activeProjects, todayHoursByProject: map, todayTotal: total }
  }, [projects, labor])

  const attentionItems = useMemo(() => {
    const today = todayIso()
    const items: AttentionItem[] = []
    for (const p of projects) {
      if (/estim|sent|await|lead/i.test(p.status)) {
        items.push({
          id: `estimate-${p.id}`,
          tone: 'accent',
          eyebrow: 'Estimate',
          title: `${p.name} needs a bid follow-up`,
          body: `${p.customer_name} · ${formatStatusLabel(p.status)}`,
          why: `Flagged because this project is in "${formatStatusLabel(p.status)}" — a sent or in-flight estimate with no acceptance yet. Estimates that sit without a nudge close at a lower rate.`,
          action: 'Open project',
          projectId: p.id,
        })
      }
    }
    for (const p of activeProjects) {
      const hrs = labor
        .filter((l) => l.occurred_on === today && !l.deleted_at && l.project_id === p.id)
        .reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
      const laborBurn = hrs * Number(p.labor_rate ?? 0)
      const bid = Number(p.bid_total ?? 0)
      if (bid > 0 && laborBurn > bid * 0.18) {
        items.push({
          id: `risk-${p.id}`,
          tone: 'red',
          eyebrow: `At risk · ${formatMoney(laborBurn)}`,
          title: `${p.name} labor is trending hot`,
          body: `${formatDecimalHours(hrs, 1)} logged today. Review crew plan before the next dispatch.`,
          why: `Today's labor burn (${formatMoney(laborBurn)}) is more than 18% of the ${formatMoney(bid)} bid in a single day. At this pace the labor budget runs out before the job does.`,
          action: 'Review site',
          projectId: p.id,
        })
      }
    }
    return items.slice(0, 5)
  }, [activeProjects, labor, projects])

  if (!bootstrap) {
    return (
      <>
        <MTopBar title="Today" />
        <MBody />
      </>
    )
  }

  if (projects.length === 0) {
    return (
      <>
        <MTopBar title="Projects" actionIcon={<MI.Plus size={20} />} actionLabel="New project" />
        <MEmptyState
          title="No projects yet"
          body="Start with an address or upload drawings — Sitelayer will help you get to a measurement plan in under a minute."
          primaryLabel="New project"
          secondaryLabel="Import from QuickBooks"
          onPrimary={() => navigate('/projects/new')}
        />
      </>
    )
  }

  const heroTitle =
    activeProjects.length === 0
      ? "You're caught up."
      : `${activeProjects.length} ${pl(activeProjects.length, 'site', 'sites')} running`
  const heroSub =
    activeProjects.length === 0
      ? 'Nothing on fire. Plan tomorrow when you have a minute.'
      : `${formatDecimalHours(todayTotal, 1)} crew-hrs logged today across ${activeProjects.length} ${pl(activeProjects.length, 'site', 'sites')}.`

  return (
    <>
      <MTopBar
        title="Today"
        actionIcon={<MI.Plus size={20} />}
        actionLabel="New"
        onAction={() => navigate('/projects/new')}
      />
      <MBody>
        {triggeredGuardrail ? (
          <div style={{ padding: '0 16px' }}>
            <MBanner
              tone="attention"
              title={triggeredGuardrail.label}
              body={triggeredGuardrail.detail}
              action={
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <MButton
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      snooze.mutate({
                        id: triggeredGuardrail.id,
                        snoozedUntil: new Date(Date.now() + 86400000).toISOString(),
                      })
                    }
                  >
                    Snooze
                  </MButton>
                  <MButton
                    size="sm"
                    variant="primary"
                    onClick={() => navigate(`/projects/${triggeredGuardrail.project_id}`)}
                  >
                    Open project
                  </MButton>
                </div>
              }
            />
          </div>
        ) : null}
        <MLargeHead
          eyebrow={new Date()
            .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
            .toUpperCase()}
          title={
            view === 'needs'
              ? `${attentionItems.length} ${pl(attentionItems.length, 'thing', 'things')} ${attentionItems.length === 1 ? 'needs' : 'need'} you.`
              : heroTitle
          }
          sub={view === 'needs' ? 'Sorted by impact. Tap to handle, then get back to the day.' : heroSub}
          right={<MAvatar initials={initialsFromCompany(bootstrap.company.name)} />}
        />
        <MChipRow>
          <MChip active={view === 'today'} onClick={() => setView('today')}>
            Today
          </MChip>
          <MChip active={view === 'needs'} onClick={() => setView('needs')}>
            What needs me {attentionItems.length > 0 ? attentionItems.length : ''}
          </MChip>
          <MChip active={view === 'week'} onClick={() => setView('week')}>
            This week
          </MChip>
          <MChip active={view === 'all'} onClick={() => setView('all')}>
            All sites
          </MChip>
        </MChipRow>
        {view === 'needs' ? (
          <AttentionList items={attentionItems} onOpen={(projectId) => navigate(`/projects/${projectId}`)} />
        ) : (
          <>
            <MKpiRow cols={2}>
              <MKpi
                label="Today on site"
                value={String(activeProjects.length)}
                unit={pl(activeProjects.length, 'site', 'sites')}
              />
              <MKpi
                label="Crew-hrs"
                value={formatDecimalHours(todayTotal, 1).replace('h', '')}
                unit="h"
                meta={todayTotal > 0 ? 'Live' : 'No clock-ins yet'}
                metaTone={todayTotal > 0 ? 'green' : undefined}
              />
            </MKpiRow>
            <MSectionH link="See all" onLinkClick={() => navigate('/projects')}>
              Today on site
            </MSectionH>
            {activeProjects.length === 0 ? (
              <div style={{ padding: '0 16px' }}>
                <div className="m-card" style={{ color: 'var(--m-ink-3)', fontSize: 13 }}>
                  No active sites. New projects you create land here once they kick off.
                </div>
              </div>
            ) : (
              <MListInset>
                {activeProjects.slice(0, view === 'all' ? 20 : 5).map((p) => {
                  const hrs = todayHoursByProject.get(p.id) ?? 0
                  return (
                    <MListRow
                      key={p.id}
                      leading={<MI.Home size={18} />}
                      leadingTone={statusTone(p.status) === 'green' ? 'accent' : undefined}
                      headline={p.name}
                      supporting={`${p.customer_name} · ${p.division_code}`}
                      trailing={
                        hrs > 0 ? (
                          <span className="num">{formatDecimalHours(hrs, 1)}</span>
                        ) : (
                          <MPill tone={statusTone(p.status)} dot>
                            {formatStatusLabel(p.status)}
                          </MPill>
                        )
                      }
                      chev
                      onTap={() => navigate(`/projects/${p.id}`)}
                    />
                  )
                })}
              </MListInset>
            )}
            <MSectionH>Quick stats</MSectionH>
            <MKpiRow cols={2}>
              <MKpi
                label="Bid pipeline"
                value={String(projects.filter((p) => /estim|sent|await/i.test(p.status)).length)}
                meta="In-flight estimates"
              />
              <MKpi
                label="Active value"
                value={formatMoney(activeProjects.reduce((sum, p) => sum + Number(p.bid_total ?? 0), 0))}
                meta={`${activeProjects.length} ${pl(activeProjects.length, 'project', 'projects')}`}
              />
            </MKpiRow>
          </>
        )}
      </MBody>
    </>
  )
}

type AttentionItem = {
  id: string
  tone: 'accent' | 'red'
  eyebrow: string
  title: string
  body: string
  /** The "Why this card?" reveal — surfaces the data behind the flag. */
  why: string
  action: string
  projectId: string
}

function AttentionList({ items, onOpen }: { items: readonly AttentionItem[]; onOpen: (projectId: string) => void }) {
  // Dismissed cards stay hidden for the session — AI is offered, never
  // imposed (Design Overview/design_system AI rules). Tracked by item id.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const visible = items.filter((i) => !dismissed.has(i.id))

  if (visible.length === 0) {
    return (
      <div style={{ padding: '0 16px' }}>
        <div className="m-card" style={{ color: 'var(--m-ink-3)', fontSize: 13 }}>
          Nothing needs owner action right now. Estimates, field stops, and budget risks land here.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 16px' }}>
      {visible.map((item) => (
        <AttentionCard
          key={item.id}
          item={item}
          onOpen={() => onOpen(item.projectId)}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(item.id))}
        />
      ))}
    </div>
  )
}

/**
 * Single AI priority card — mirrors db-pm.png: Spark-marked eyebrow,
 * dismiss (×), title + body, a "Why this card?" reveal (the data moat
 * made visible), and the primary action. Confidence is ordinal (the
 * eyebrow), never a numeric score, per the AI rules.
 */
function AttentionCard({
  item,
  onOpen,
  onDismiss,
}: {
  item: AttentionItem
  onOpen: () => void
  onDismiss: () => void
}) {
  const [showWhy, setShowWhy] = useState(false)
  const accent = item.tone === 'red' ? 'var(--m-red)' : 'var(--m-accent)'

  return (
    <div
      className="m-card"
      style={{
        borderLeft: `6px solid ${accent}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <span className="m-ai-eyebrow" data-tone={item.tone === 'red' ? 'warn' : undefined}>
          <Spark size={11} state="strong" />
          {item.eyebrow}
        </span>
        <button type="button" className="m-ai-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <MI.X size={12} />
        </button>
      </div>
      <div
        style={{
          marginTop: 10,
          fontFamily: 'var(--m-font-display)',
          fontSize: 17,
          fontWeight: 700,
          letterSpacing: '-0.015em',
          lineHeight: 1.18,
        }}
      >
        {item.title}
      </div>
      <div style={{ marginTop: 7, color: 'var(--m-ink-2)', fontSize: 13, lineHeight: 1.35 }}>{item.body}</div>
      {showWhy ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--m-ink-3)',
            lineHeight: 1.4,
            borderTop: '1px solid var(--m-line-2)',
            paddingTop: 8,
          }}
        >
          {item.why}
        </div>
      ) : null}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button
          type="button"
          onClick={() => setShowWhy((v) => !v)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            color: 'var(--m-ink-3)',
            fontSize: 12,
            fontWeight: 500,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
          }}
        >
          <Spark size={10} state="muted" />
          {showWhy ? 'Hide' : 'Why this card?'}
        </button>
        <MButton size="sm" variant="primary" onClick={onOpen}>
          {item.action}
        </MButton>
      </div>
    </div>
  )
}

function isActiveStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes('progress') || s.includes('active')
}

function pl<T extends string>(n: number, sing: T, plur: T): T {
  return (n === 1 ? sing : plur) as T
}

function initialsFromCompany(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export type AdminProjectsListProps = {
  projects: readonly ProjectRow[]
  onOpen: (project: ProjectRow) => void
}

// ===========================================================================
// DESKTOP — the owner "command center" landing (Desktop v2 · 01). Same
// bootstrap + guardrail data as the mobile home; a dense desktop composition
// (at-risk banner + active/month-net/approvals/margin KPIs + Today-on-site
// DataTable). Preserved verbatim from the deleted desktop twin.
// ===========================================================================

/** Compact "+$84K" / "-$1.2M" currency for the dense desktop KPI tiles. */
function compactMoney(n: number): { value: string; unit: string } {
  const sign = n < 0 ? '-' : '+'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return { value: `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}`, unit: 'M' }
  if (abs >= 1_000) return { value: `${sign}$${Math.round(abs / 1_000)}`, unit: 'K' }
  return { value: `${sign}$${Math.round(abs)}`, unit: '' }
}

/** First name token, uppercased — the compact requester tag in a KPI meta. */
function shortName(name: string | null): string | null {
  if (!name) return null
  const first = name.trim().split(/\s+/)[0]
  return first ? first.toUpperCase() : null
}

type SiteRow = {
  id: string
  name: string
  customer: string
  scope: string
  crew: number
  spent: number
  status: string
}

function OwnerDashboardDesktop({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const guardrailsQuery = useActiveGuardrails()
  const triggered = guardrailsQuery.data?.guardrails.find((g) => g.status === 'triggered') ?? null

  const firstName = useFirstName()
  const projectName = useMemo(
    () => new Map((bootstrap?.projects ?? []).map((p) => [p.id, p.name])),
    [bootstrap?.projects],
  )
  const pendingApprovals = usePendingApprovalsSummary(projectName)

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const materialBills = useMemo(() => bootstrap?.materialBills ?? [], [bootstrap?.materialBills])

  const { active, crewOnClock, monthNet, momDelta, avgMargin, rows } = useMemo(() => {
    const today = todayIso()
    const active = projects.filter((p) => /progress|active/i.test(p.status))
    const todayLabor = labor.filter((l) => l.occurred_on === today && !l.deleted_at)
    const hoursByProject = new Map<string, number>()
    const spendByProject = new Map<string, number>()
    const crewByProject = new Map<string, Set<string>>()
    const crewOnClockSet = new Set<string>()
    for (const l of todayLabor) {
      const hrs = Number(l.hours ?? 0)
      if (l.project_id) {
        hoursByProject.set(l.project_id, (hoursByProject.get(l.project_id) ?? 0) + hrs)
        if (l.worker_id) {
          const set = crewByProject.get(l.project_id) ?? new Set<string>()
          set.add(l.worker_id)
          crewByProject.set(l.project_id, set)
          crewOnClockSet.add(l.worker_id)
        }
      }
    }
    for (const p of active) {
      const hrs = hoursByProject.get(p.id) ?? 0
      spendByProject.set(p.id, hrs * Number(p.labor_rate ?? 0))
    }
    const rows: SiteRow[] = active.map((p) => ({
      id: p.id,
      name: p.name,
      customer: p.customer_name,
      scope: p.division_code ?? '—',
      crew: crewByProject.get(p.id)?.size ?? 0,
      spent: spendByProject.get(p.id) ?? 0,
      status: p.status,
    }))

    // THIS MONTH NET — active bid value booked this month minus this-month
    // labor + material cost. MoM delta compares this month's labor+material
    // spend against last month's (the only month-bucketed signal in bootstrap).
    const now = new Date()
    const monthKey = (iso: string | null | undefined) => (iso ? iso.slice(0, 7) : '')
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
    const rateByProject = new Map(projects.map((p) => [p.id, Number(p.labor_rate ?? 0)]))
    let thisSpend = 0
    let prevSpend = 0
    for (const l of labor) {
      if (l.deleted_at) continue
      const cost = Number(l.hours ?? 0) * (rateByProject.get(l.project_id) ?? 0)
      if (monthKey(l.occurred_on) === thisMonth) thisSpend += cost
      else if (monthKey(l.occurred_on) === prevMonth) prevSpend += cost
    }
    for (const m of materialBills) {
      if (m.deleted_at) continue
      const amt = Number(m.amount ?? 0)
      if (monthKey(m.occurred_on) === thisMonth) thisSpend += amt
      else if (monthKey(m.occurred_on) === prevMonth) prevSpend += amt
    }
    const activeValue = active.reduce((sum, p) => sum + Number(p.bid_total ?? 0), 0)
    const monthNet = activeValue - thisSpend
    const momDelta = prevSpend > 0 ? Math.round(((thisSpend - prevSpend) / prevSpend) * 100) : null

    // AVG MARGIN across active projects (bid vs this-job spend so far).
    const margins: number[] = []
    for (const p of active) {
      const bid = Number(p.bid_total ?? 0)
      if (bid <= 0) continue
      const spent = spendByProject.get(p.id) ?? 0
      margins.push(((bid - spent) / bid) * 100)
    }
    const avgMargin = margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : null

    return {
      active,
      crewOnClock: crewOnClockSet.size,
      monthNet,
      momDelta,
      avgMargin,
      rows,
    }
  }, [projects, labor, materialBills])

  const columns: Array<DColumn<SiteRow>> = [
    { key: 'name', header: 'Project', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'customer', header: 'Client', render: (r) => r.customer },
    { key: 'scope', header: 'Scope', render: (r) => r.scope },
    { key: 'crew', header: 'Crew', numeric: true, render: (r) => r.crew },
    { key: 'spent', header: 'Spent today', numeric: true, render: (r) => formatMoney(r.spent) },
    {
      key: 'status',
      header: 'Status',
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
        <div>
          <DEyebrow>Good morning, {firstName ?? bootstrap?.company.name ?? 'there'}</DEyebrow>
          <DH1>
            {active.length} {active.length === 1 ? 'job' : 'jobs'} running.
            {triggered ? ' 1 needs you.' : ' All on track.'}
          </DH1>
        </div>

        {triggered ? (
          <div
            className="d-card"
            data-tone="accent"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}
          >
            <div>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'var(--m-ink)',
                  color: 'var(--m-accent)',
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  padding: '4px 9px',
                }}
              >
                ● AT RISK{Number.isFinite(triggered.current_value) ? ` · ${Math.round(triggered.current_value)}%` : ''}
              </span>
              <div
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 32,
                  letterSpacing: '-0.025em',
                  marginTop: 6,
                }}
              >
                {triggered.label}
              </div>
              <div style={{ fontSize: 14, marginTop: 4 }}>{triggered.detail}</div>
            </div>
            <MButton variant="quiet" onClick={() => navigate(`/projects/${triggered.project_id}/recovery`)}>
              Open recovery plan →
            </MButton>
          </div>
        ) : null}

        <DKpiStrip>
          <DKpi label="Active jobs" value={String(active.length)} meta={`${crewOnClock} crew on clock`} />
          <DKpi
            label="This month net"
            value={compactMoney(monthNet).value}
            unit={compactMoney(monthNet).unit}
            meta={
              momDelta === null ? 'No prior month' : `${momDelta <= 0 ? '↓' : '↑'} ${Math.abs(momDelta)}% vs last mo`
            }
            metaTone={momDelta === null ? undefined : monthNet >= 0 ? 'good' : 'bad'}
          />
          <DKpi
            label="Pending approvals"
            value={String(pendingApprovals.count)}
            tone="accent"
            meta={
              pendingApprovals.count === 0
                ? 'All clear'
                : `${pendingApprovals.urgentCount} urgent${
                    shortName(pendingApprovals.firstRequester) ? ` · ${shortName(pendingApprovals.firstRequester)}` : ''
                  }`
            }
          />
          <DKpi
            label="Avg margin"
            value={avgMargin === null ? '—' : String(avgMargin)}
            unit={avgMargin === null ? undefined : '%'}
            meta={avgMargin === null ? 'No active bids' : 'On target'}
            metaTone={avgMargin !== null && avgMargin >= 25 ? 'good' : undefined}
          />
        </DKpiStrip>

        <DataTable<SiteRow>
          title="Today on site"
          action={
            <MButton size="sm" variant="primary" onClick={() => navigate('/desktop/schedule')}>
              View schedule
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/desktop/projects/${r.id}`)}
          empty="No active sites. New projects land here once they kick off."
        />
      </div>
    </div>
  )
}
