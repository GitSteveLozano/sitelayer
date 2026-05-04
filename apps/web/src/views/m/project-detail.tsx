/**
 * Mobile project detail. The most-used screen in the system per the
 * estimator README. Shows project hero + tab nav + per-tab content.
 *
 * For Phase 4 the data is sourced from bootstrap (projects, laborEntries,
 * schedules, materialBills filtered by project_id). Tabs that need
 * heavier data (estimate lines, daily logs, blueprints) render lightly
 * and link out to existing desktop views via /projects/:id; later phases
 * replace those with native mobile implementations.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse, ProjectRow } from '../../api.js'
import {
  MAvatarGroup,
  MBody,
  MI,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { formatDecimalHours, formatMoney, formatStatusLabel, statusTone } from './format.js'

type TabKey = 'overview' | 'crew' | 'materials' | 'budget' | 'log' | 'files'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
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
        <MTopBar back title="Project" onBack={() => navigate('/m/projects')} />
        <MEmptyState
          title="Project not found"
          body="It may have been archived or you may not have access. Try the projects list."
          primaryLabel="Back to projects"
          onPrimary={() => navigate('/m/projects')}
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
        onBack={() => navigate('/m/projects')}
      />
      <MBody>
        <ProjectHero project={project} pctSpent={pctSpent} onTrack={onTrack} spent={spent} bid={bid} />
        <TabBar active={tab} onChange={setTab} />
        {tab === 'overview' && <Overview project={project} totalHours={totalHours} bid={bid} spent={spent} pctSpent={pctSpent} />}
        {tab === 'crew' && <CrewTab labor={labor} workers={bootstrap?.workers ?? []} />}
        {tab === 'materials' && <MaterialsTab bills={materialBills} />}
        {tab === 'budget' && <BudgetTab project={project} totalHours={totalHours} spent={spent} bid={bid} pctSpent={pctSpent} />}
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
      <div style={{ fontSize: 11, color: 'var(--m-ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>
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
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          style={{
            background: active === t.key ? 'var(--m-ink)' : 'transparent',
            color: active === t.key ? 'white' : 'var(--m-ink-2)',
            border: 'none',
            borderRadius: 999,
            padding: '6px 14px',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {t.label}
        </button>
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
}: {
  project: ProjectRow
  totalHours: number
  bid: number
  spent: number
  pctSpent: number
}) {
  const summary = `${project.name}, ${formatMoney(bid)} ${project.division_code} job for ${project.customer_name}.`

  return (
    <div style={{ paddingTop: 8 }}>
      {pctSpent > 75 ? (
        <div style={{ padding: '0 16px 12px' }}>
          <MAiStripe
            tone="warn"
            eyebrow="Budget watch"
            title={`${pctSpent}% of bid spent — keep an eye on materials`}
            attribution={<>Based on <strong>logged labor + materials</strong>.</>}
          >
            Labor pace {formatDecimalHours(totalHours, 1)}; remaining budget {formatMoney(bid - spent)}.
          </MAiStripe>
        </div>
      ) : null}
      <div style={{ padding: '0 20px 14px', fontSize: 14, color: 'var(--m-ink-2)', lineHeight: 1.5 }}>{summary}</div>
      <MSectionH>Drill in</MSectionH>
      <MListInset>
        <MListRow leading={<MI.Users size={18} />} headline="Crew & hours" supporting={`${formatDecimalHours(totalHours, 1)} logged`} chev />
        <MListRow leading={<MI.Truck size={18} />} headline="Materials & costs" supporting="Bills + rental dispatch" chev />
        <MListRow leading={<MI.Clock size={18} />} headline="Schedule" supporting="Slot in 4-week planner" chev />
        <MListRow leading={<MI.FileText size={18} />} headline="Daily log" supporting="From foreman" chev />
        <MListRow leading={<MI.Layers size={18} />} headline="Files" supporting="Drawings, contracts" chev />
      </MListInset>
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
      <MKpiRow cols={2}>
        <MKpi label="Spent" value={formatMoney(spent)} meta={`of ${formatMoney(bid)}`} metaTone={tone} />
        <MKpi label="Pace" value={formatDecimalHours(totalHours, 1)} meta={`@ $${project.labor_rate}/hr`} />
      </MKpiRow>
      <div style={{ padding: '12px 16px' }}>
        <div className="m-progress">
          <div className="m-progress-fill" style={{ width: `${Math.min(100, pctSpent)}%`, background: `var(--m-${tone})` }} />
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

function LogTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px 12px' }}>
        <MAiStripe eyebrow="Daily log" title="Pulled from foreman submissions" onDismiss={() => {}}>
          When the foreman ends their day, the daily log lands here. Until then, the desktop log view shows
          everything logged so far.
        </MAiStripe>
      </div>
      <div style={{ padding: '0 16px' }}>
        <button
          type="button"
          className="m-btn"
          data-variant="ghost"
          onClick={() => navigate(`/projects/${project.id}`)}
        >
          Open full project on desktop
        </button>
      </div>
    </div>
  )
}

function FilesTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px' }}>
        <button
          type="button"
          className="m-btn"
          data-variant="ghost"
          onClick={() => navigate(`/takeoffs/${project.id}`)}
        >
          Open blueprints / takeoff
        </button>
      </div>
    </div>
  )
}
