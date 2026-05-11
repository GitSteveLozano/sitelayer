/**
 * Mobile project detail. The most-used screen in the system per the
 * estimator README. Shows project hero + tab nav + per-tab content.
 *
 * For Phase 4 the data is sourced from bootstrap (projects, laborEntries,
 * schedules, materialBills filtered by project_id). Tabs that need
 * heavier data (estimate lines, daily logs, blueprints) render lightly
 * and link out to existing project screens via /projects/:id; later phases
 * replace those with native mobile implementations.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse, ProjectRow } from '../../api-v1-compat.js'
import {
  MAvatarGroup,
  MBody,
  MButton,
  MI,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTapCard,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { BidAccuracyCard } from '../projects/bid-accuracy-card.js'
import { LifecycleBanner } from '../../components/lifecycle/banner.js'
import { CloseoutBanner } from '../../components/closeout/banner.js'
import { useProjectLaborVariance, type LaborVarianceRow } from '../../lib/api/labor-variance.js'
import { formatDecimalHours, formatMoney, formatStatusLabel, statusTone } from './format.js'

type TabKey = 'overview' | 'estimate' | 'crew' | 'materials' | 'budget' | 'log' | 'files'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'estimate', label: 'Estimate' },
  { key: 'crew', label: 'Crew' },
  { key: 'materials', label: 'Materials' },
  { key: 'budget', label: 'Budget' },
  { key: 'log', label: 'Log' },
  { key: 'files', label: 'Files' },
]

export function MobileProjectDetail({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<TabKey>('overview')

  const project = bootstrap?.projects.find((p) => p.id === params.projectId)
  const labor = useMemo(
    () => (bootstrap?.laborEntries ?? []).filter((l) => l.project_id === params.projectId && !l.deleted_at),
    [bootstrap?.laborEntries, params.projectId],
  )
  const schedules = useMemo(
    () => (bootstrap?.schedules ?? []).filter((s) => s.project_id === params.projectId),
    [bootstrap?.schedules, params.projectId],
  )
  const materialBills = useMemo(
    () => (bootstrap?.materialBills ?? []).filter((m) => m.project_id === params.projectId),
    [bootstrap?.materialBills, params.projectId],
  )

  if (!project) {
    return (
      <>
        <MTopBar back title="Project" onBack={() => navigate('/projects')} />
        <MEmptyState
          title="Project not found"
          body="It may have been archived or you may not have access. Try the projects list."
          primaryLabel="Back to projects"
          onPrimary={() => navigate('/projects')}
        />
      </>
    )
  }

  const totalHours = labor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
  const laborRate = Number(project.labor_rate ?? 0)
  const spent = totalHours * laborRate
  const bid = Number(project.bid_total ?? 0)
  const pctSpent = bid > 0 ? Math.round((spent / bid) * 100) : 0
  const onTrack = pctSpent <= 75

  return (
    <>
      <MTopBar
        back
        title="Project"
        sub={schedules.length > 0 ? `Day ${schedules.length} of ${Math.max(schedules.length, 14)}` : undefined}
        onBack={() => navigate('/projects')}
      />
      <MBody>
        <ProjectHero project={project} pctSpent={pctSpent} onTrack={onTrack} spent={spent} bid={bid} />
        <TabBar active={tab} onChange={setTab} />
        {tab === 'overview' && (
          <Overview
            project={project}
            totalHours={totalHours}
            bid={bid}
            spent={spent}
            pctSpent={pctSpent}
            navigate={navigate}
          />
        )}
        {tab === 'estimate' && <EstimateTab project={project} navigate={navigate} />}
        {tab === 'crew' && <CrewTab labor={labor} workers={bootstrap?.workers ?? []} />}
        {tab === 'materials' && <MaterialsTab bills={materialBills} />}
        {tab === 'budget' && (
          <BudgetTab project={project} totalHours={totalHours} spent={spent} bid={bid} pctSpent={pctSpent} />
        )}
        {tab === 'log' && <LogTab project={project} navigate={navigate} />}
        {tab === 'files' && <FilesTab project={project} navigate={navigate} />}
      </MBody>
    </>
  )
}

function ProjectHero({
  project,
  pctSpent,
  onTrack,
  spent,
  bid,
}: {
  project: ProjectRow
  pctSpent: number
  onTrack: boolean
  spent: number
  bid: number
}) {
  return (
    <div style={{ padding: '6px 20px 18px', borderBottom: '1px solid var(--m-line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <MPill tone={statusTone(project.status)} dot>
          {formatStatusLabel(project.status)}
        </MPill>
        <span style={{ fontSize: 12, color: onTrack ? 'var(--m-green)' : 'var(--m-amber)' }}>
          {onTrack ? 'On track' : 'Watch'}
        </span>
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--m-ink-3)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {project.customer_name} · {project.division_code}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1, margin: '4px 0 6px' }}>
        {project.name}
      </div>
      <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
        SPENT · <span className="num">{formatMoney(spent)}</span> of {formatMoney(bid)}
        <span style={{ fontSize: 24, fontWeight: 600, marginLeft: 8, color: 'var(--m-ink)' }} className="num">
          {pctSpent}%
        </span>
      </div>
    </div>
  )
}

function TabBar({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: '12px 16px 4px',
        overflowX: 'auto',
      }}
    >
      {TABS.map((t) => (
        <MTapCard
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            background: active === t.key ? 'var(--m-accent)' : 'transparent',
            color: active === t.key ? 'white' : 'var(--m-ink-2)',
            border: 'none',
            borderRadius: 999,
            padding: '6px 14px',
            width: 'auto',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500 }}>{t.label}</span>
        </MTapCard>
      ))}
    </div>
  )
}

function Overview({
  project,
  totalHours,
  bid,
  spent,
  pctSpent,
  navigate,
}: {
  project: ProjectRow
  totalHours: number
  bid: number
  spent: number
  pctSpent: number
  navigate: (path: string) => void
}) {
  const summary = `${project.name}, ${formatMoney(bid)} ${project.division_code} job for ${project.customer_name}.`

  return (
    <div style={{ paddingTop: 8 }}>
      {/* Project-lifecycle workflow banner — server-truth state +
          next_events from the project-lifecycle reducer
          (packages/workflows/src/project-lifecycle.ts) consumed via
          the headless useProjectLifecycle XState machine
          (apps/web/src/machines/project-lifecycle.ts). See
          docs/DETERMINISTIC_WORKFLOWS.md. */}
      <div style={{ padding: '0 16px 12px' }}>
        <LifecycleBanner projectId={project.id} />
      </div>
      {/* Project-closeout workflow banner — server-truth state +
          next_events from the project-closeout reducer
          (packages/workflows/src/project-closeout.ts) consumed via
          the headless useProjectCloseoutMachine XState machine
          (apps/web/src/machines/project-closeout.ts). Self-hides
          while the project is still active with no pending events
          so the Overview tab stays calm for early-stage projects. */}
      <div style={{ padding: '0 16px 12px' }}>
        <CloseoutBanner projectId={project.id} />
      </div>
      <ProjectStatePanel project={project} navigate={navigate} />
      {/* Bid-accuracy keystone (mirrors the desktop overview hero per
          `/tmp/sitelayer_design_stuff/ai-keystone.jsx`). Self-hides
          when no comparable cohort exists yet. */}
      <div style={{ padding: '0 16px 12px' }}>
        <BidAccuracyCard projectId={project.id} />
      </div>
      {pctSpent > 75 ? (
        <div style={{ padding: '0 16px 12px' }}>
          <MAiStripe
            tone="warn"
            eyebrow="Budget watch"
            title={`${pctSpent}% of bid spent — keep an eye on materials`}
            attribution={
              <>
                Based on <strong>logged labor + materials</strong>.
              </>
            }
          >
            Labor pace {formatDecimalHours(totalHours, 1)}; remaining budget {formatMoney(bid - spent)}.
          </MAiStripe>
        </div>
      ) : null}
      <div style={{ padding: '0 20px 14px', fontSize: 14, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>{summary}</div>
      <MSectionH>Drill in</MSectionH>
      <MListInset>
        <MListRow
          leading={<MI.Layers size={18} />}
          leadingTone="accent"
          headline="Blueprints / takeoff"
          supporting="Drawings + measurements"
          chev
          onTap={() => navigate(`/projects/${project.id}/takeoff`)}
        />
        <MListRow
          leading={<MI.FileText size={18} />}
          headline="Estimate"
          supporting="Line items + send"
          chev
          onTap={() => navigate(`/projects/${project.id}/estimate`)}
        />
        <MListRow
          leading={<MI.Users size={18} />}
          headline="Crew & hours"
          supporting={`${formatDecimalHours(totalHours, 1)} logged`}
          chev
        />
        <MListRow
          leading={<MI.Truck size={18} />}
          headline="Materials & costs"
          supporting="Bills + rental dispatch"
          chev
          onTap={() => navigate('/rentals/dispatch')}
        />
        <MListRow
          leading={<MI.Clock size={18} />}
          headline="Schedule"
          supporting="Slot in 4-week planner"
          chev
          onTap={() => navigate('/schedule')}
        />
        <MListRow
          leading={<MI.FileText size={18} />}
          headline="Daily log"
          supporting="From foreman"
          chev
          onTap={() => navigate('/log')}
        />
      </MListInset>
    </div>
  )
}

function ProjectStatePanel({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  const state = normalizeProjectState(project.status)
  const config =
    state === 'draft'
      ? {
          eyebrow: 'Drafting',
          title: 'Start with takeoff, then build the estimate.',
          body: 'Client and archetype are enough for now. Measurements and line items come next.',
          primary: 'Start takeoff',
          primaryPath: `/projects/${project.id}/takeoff`,
          secondary: 'Open estimate',
          secondaryPath: `/projects/${project.id}/estimate`,
        }
      : state === 'sent'
        ? {
            eyebrow: 'Awaiting client',
            title: 'Estimate is out. Watch read status before nudging.',
            body: 'Signed portal activity and estimate push history live in the estimate workflow.',
            primary: 'Review send',
            primaryPath: `/projects/${project.id}/estimate`,
            secondary: 'Share link',
            secondaryPath: `/projects/${project.id}/estimate`,
          }
        : state === 'accepted'
          ? {
              eyebrow: 'Accepted',
              title: 'Assign foreman and lock the start date.',
              body: 'Once scheduled, this appears in the foreman morning flow.',
              primary: 'Schedule',
              primaryPath: '/schedule',
              secondary: 'Crew',
              secondaryPath: '/crew',
            }
          : state === 'active'
            ? {
                eyebrow: 'In progress',
                title: 'Track budget, daily log, crew, and materials.',
                body: 'Foreman logs and worker evidence roll up here as the job moves.',
                primary: 'Budget',
                primaryPath: `/projects/${project.id}`,
                secondary: 'Brief crew',
                secondaryPath: `/brief/${project.id}`,
              }
            : state === 'done'
              ? {
                  eyebrow: 'Closing',
                  title: 'Create final invoice and archive when paid.',
                  body: 'Use logged scope, materials, and approved time as the closeout record.',
                  primary: 'Invoice',
                  primaryPath: '/invoice/new',
                  secondary: 'Files',
                  secondaryPath: `/projects/${project.id}/takeoff`,
                }
              : {
                  eyebrow: 'Archived',
                  title: 'Read-only job record.',
                  body: 'Use this project for reports, bid accuracy, and historical comparisons.',
                  primary: 'Files',
                  primaryPath: `/projects/${project.id}/takeoff`,
                  secondary: 'Projects',
                  secondaryPath: '/projects',
                }

  return (
    <div style={{ padding: '0 16px 12px' }}>
      <div className="m-card" style={{ background: 'var(--m-card-soft)' }}>
        <div className="m-topbar-eyebrow">{config.eyebrow}</div>
        <div style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}>{config.title}</div>
        <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.45, marginTop: 4 }}>{config.body}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <MButton variant="primary" size="sm" onClick={() => navigate(config.primaryPath)}>
            {config.primary}
          </MButton>
          <MButton variant="ghost" size="sm" onClick={() => navigate(config.secondaryPath)}>
            {config.secondary}
          </MButton>
        </div>
      </div>
    </div>
  )
}

function normalizeProjectState(status: string): 'draft' | 'sent' | 'accepted' | 'active' | 'done' | 'archived' {
  const s = status.toLowerCase()
  if (/archive/.test(s)) return 'archived'
  if (/done|closed|closing|complete/.test(s)) return 'done'
  if (/progress|active/.test(s)) return 'active'
  if (/accepted|won|signed/.test(s)) return 'accepted'
  if (/sent|await|proposal/.test(s)) return 'sent'
  return 'draft'
}

function EstimateTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  return (
    <div style={{ paddingTop: 8, padding: 16 }}>
      <p style={{ color: 'var(--m-ink-2)', fontSize: 14, lineHeight: 1.5, marginTop: 0 }}>
        Estimate detail loads in its own screen — line items, totals, and send-to-client live there.
      </p>
      <div style={{ marginTop: 16 }}>
        <MButton variant="primary" onClick={() => navigate(`/projects/${project.id}/estimate`)}>
          Open estimate
        </MButton>
      </div>
    </div>
  )
}

function CrewTab({
  labor,
  workers,
}: {
  labor: BootstrapResponse['laborEntries']
  workers: BootstrapResponse['workers']
}) {
  const byWorker = useMemo(() => {
    const map = new Map<string, { hours: number; name: string }>()
    for (const l of labor) {
      const wid = l.worker_id ?? 'unassigned'
      const name = workers.find((w) => w.id === wid)?.name ?? 'Unassigned'
      const cur = map.get(wid) ?? { hours: 0, name }
      cur.hours += Number(l.hours ?? 0)
      map.set(wid, cur)
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.hours - a.hours)
  }, [labor, workers])

  if (byWorker.length === 0) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
        No labor entries logged yet.
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px 12px' }}>
        <MAvatarGroup
          avatars={byWorker.slice(0, 6).map((w) => ({
            initials: initialsFor(w.name),
            tone: avatarToneFor(w.id),
          }))}
          max={6}
        />
      </div>
      <MSectionH>Hours by crew member</MSectionH>
      <MListInset>
        {byWorker.map((w) => (
          <MListRow
            key={w.id}
            headline={w.name}
            trailing={<span className="num">{formatDecimalHours(w.hours, 1)}</span>}
          />
        ))}
      </MListInset>
    </div>
  )
}

function MaterialsTab({ bills }: { bills: BootstrapResponse['materialBills'] }) {
  const total = bills.reduce((sum, b) => sum + Number(b.amount ?? 0), 0)
  if (bills.length === 0) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
        No material bills yet.
      </div>
    )
  }
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px 12px' }}>
        <MKpiRow cols={2}>
          <MKpi label="Bills" value={String(bills.length)} />
          <MKpi label="Total" value={formatMoney(total)} />
        </MKpiRow>
      </div>
      <MSectionH>Recent bills</MSectionH>
      <MListInset>
        {bills.map((b) => (
          <MListRow
            key={b.id}
            leading={<MI.Truck size={18} />}
            headline={b.vendor ?? 'Unknown vendor'}
            supporting={b.occurred_on}
            trailing={<span className="num">{formatMoney(Number(b.amount ?? 0))}</span>}
          />
        ))}
      </MListInset>
    </div>
  )
}

function BudgetTab({
  project,
  totalHours,
  spent,
  bid,
  pctSpent,
}: {
  project: ProjectRow
  totalHours: number
  spent: number
  bid: number
  pctSpent: number
}) {
  const remaining = bid - spent
  const tone = pctSpent < 60 ? 'green' : pctSpent < 90 ? 'amber' : 'red'
  return (
    <div style={{ paddingTop: 8 }}>
      {/* Estimate-vs-actual variance per service_item_code — the closing
          half of the foreman/owner feedback loop. Sits above the KPI
          strip so the worst-offender code is the first thing the eye
          lands on when the Budget tab opens. Self-hides on empty. */}
      <LaborVariancePanel projectId={project.id} />
      <MKpiRow cols={2}>
        <MKpi label="Spent" value={formatMoney(spent)} meta={`of ${formatMoney(bid)}`} metaTone={tone} />
        <MKpi label="Pace" value={formatDecimalHours(totalHours, 1)} meta={`@ $${project.labor_rate}/hr`} />
      </MKpiRow>
      <div style={{ padding: '12px 16px' }}>
        <div className="m-progress">
          <div
            className="m-progress-fill"
            style={{ width: `${Math.min(100, pctSpent)}%`, background: `var(--m-${tone})` }}
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--m-ink-3)', marginTop: 6 }}>
          {pctSpent}% of bid · {formatMoney(remaining)} remaining
        </div>
      </div>
      <MSectionH>Notes</MSectionH>
      <div style={{ padding: '0 16px 16px', fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>
        Budget calculated from logged labor entries × project labor rate. Materials and rentals not included in this
        rollup yet — see the Materials tab for that.
      </div>
    </div>
  )
}

/**
 * Per-service-item planned-vs-actual variance card. Wraps
 * GET /api/projects/:id/labor-variance.
 *
 * Surfaces the top 5 worst-offender codes (already sorted by absolute
 * hours_variance_pct on the server) so the foreman can see "are we
 * ahead or behind on labor for this scope code?" without scrolling.
 * Each row shows actual / estimated quantity in the line's unit and an
 * MPill in the variance tone (green < 10%, amber 10–25%, red > 25%).
 *
 * Empty state is a calm hint rather than an error — the panel is
 * useless until `sqft_done` lands on labor entries, which only happens
 * after a job is in progress.
 */
function LaborVariancePanel({ projectId }: { projectId: string }) {
  const variance = useProjectLaborVariance(projectId)

  if (variance.isPending) {
    return (
      <div
        style={{
          margin: '0 16px 12px',
          padding: 14,
          fontSize: 12,
          color: 'var(--m-ink-3)',
          border: '1px solid var(--m-line)',
          borderRadius: 12,
          background: 'var(--m-card-soft)',
        }}
      >
        Loading scope variance…
      </div>
    )
  }

  if (variance.isError) {
    return (
      <div
        style={{
          margin: '0 16px 12px',
          padding: 14,
          fontSize: 12,
          color: 'var(--m-red)',
          border: '1px solid var(--m-line)',
          borderRadius: 12,
        }}
      >
        Could not load scope variance.
      </div>
    )
  }

  const rows = variance.data?.variance ?? []
  if (rows.length === 0) {
    return (
      <div style={{ padding: '0 16px 12px' }}>
        <div
          style={{
            padding: '14px 16px',
            border: '1px solid var(--m-line)',
            borderRadius: 12,
            background: 'var(--m-card-soft)',
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              marginBottom: 4,
            }}
          >
            Labor variance
          </div>
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.45 }}>
            No variance data yet — labor entries with sqft_done populate this once jobs are in progress.
          </div>
        </div>
      </div>
    )
  }

  const topRows = rows.slice(0, 5)
  const hasMore = rows.length > topRows.length

  return (
    <div style={{ padding: '0 16px 12px' }}>
      <div
        style={{
          border: '1px solid var(--m-line)',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'var(--m-card)',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--m-line)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>Labor variance · worst offenders</span>
          <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--m-ink-3)' }}>
            {rows.length} {rows.length === 1 ? 'code' : 'codes'}
          </span>
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {topRows.map((row, idx) => (
            <LaborVarianceRowItem key={row.service_item_code} row={row} isLast={idx === topRows.length - 1} />
          ))}
        </ul>
        {hasMore ? (
          <div
            style={{
              padding: '8px 14px',
              borderTop: '1px solid var(--m-line)',
              fontSize: 11,
              color: 'var(--m-ink-3)',
            }}
          >
            {rows.length - topRows.length} more code{rows.length - topRows.length === 1 ? '' : 's'} · full breakdown
            coming soon
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LaborVarianceRowItem({ row, isLast }: { row: LaborVarianceRow; isLast: boolean }) {
  const pct = row.hours_variance_pct
  const absPct = Math.abs(pct)
  const tone: 'green' | 'amber' | 'red' = absPct < 10 ? 'green' : absPct <= 25 ? 'amber' : 'red'
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
  const pillTone: 'green' | 'amber' | 'red' = tone

  return (
    <li
      style={{
        padding: '10px 14px',
        borderBottom: isLast ? 'none' : '1px solid var(--m-line)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--m-ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.service_item_code}
          </div>
          {row.division_code ? (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.04em',
                color: 'var(--m-ink-3)',
                background: 'var(--m-card-soft)',
                border: '1px solid var(--m-line)',
                borderRadius: 999,
                padding: '1px 6px',
                lineHeight: 1.3,
              }}
            >
              {row.division_code}
            </span>
          ) : null}
        </div>
        <div className="num" style={{ fontSize: 11.5, color: 'var(--m-ink-3)', fontVariantNumeric: 'tabular-nums' }}>
          {formatVarianceQty(row.actual_quantity)} / {formatVarianceQty(row.estimated_quantity)} {row.unit || 'sqft'}
        </div>
      </div>
      <MPill tone={pillTone}>
        <span className="num" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
          {row.estimated_quantity > 0 || row.estimated_hours > 0 ? `${sign}${absPct.toFixed(0)}%` : 'no est.'}
        </span>
      </MPill>
    </li>
  )
}

function formatVarianceQty(n: number): string {
  if (!Number.isFinite(n)) return '0'
  // sqft/lf are typically whole numbers at the foreman level; for very
  // small values keep one decimal so we don't render "0" when there's
  // partial progress.
  if (Math.abs(n) >= 10) return Math.round(n).toLocaleString()
  return n.toFixed(1)
}

function LogTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px 12px' }}>
        <MAiStripe eyebrow="Daily log" title="Pulled from foreman submissions" onDismiss={() => {}}>
          When the foreman ends their day, the daily log lands here. Until then, the desktop log view shows everything
          logged so far.
        </MAiStripe>
      </div>
      <div style={{ padding: '0 16px' }}>
        <MButton variant="ghost" onClick={() => navigate(`/projects/${project.id}`)}>
          Open full project on desktop
        </MButton>
      </div>
    </div>
  )
}

function FilesTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px' }}>
        <MButton variant="ghost" onClick={() => navigate(`/projects/${project.id}/takeoff`)}>
          Open blueprints / takeoff
        </MButton>
      </div>
    </div>
  )
}
