import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { EmptyState } from '@/components/shell/EmptyState'
import { useClockTimeline, useSchedules, useWorkers, type Worker } from '@/lib/api'
import { findOpenSpan, formatHms, pairClockSpans } from '@/lib/clock-derive'

/**
 * `fm-live-crew` — Foreman live-crew status from Sitemap §12 panel 3.
 *
 * The design shows a "live crew on site" map with pins per project and
 * worker avatars overlaid. We deliver the same intent (who is where
 * right now) without a JS map library — those add ~150KB and a tile
 * subscription, neither of which the foreman flow needs day-one.
 *
 * Instead: a project-grouped list of on-site crew, sorted by activity.
 * Each project shows the live worker avatars + their open-span
 * runtime. Off-site / scheduled workers cluster at the bottom in an
 * "Off-site" group so the foreman can see who's *missing* too.
 *
 * The real map ships in a follow-on once the underlying lat/lng pins
 * are exposed by the bootstrap endpoint and a tile budget is decided.
 */
export function ForemanLiveCrewScreen() {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso }, { refetchInterval: 30_000 })
  const workersQuery = useWorkers()
  const schedules = useSchedules({ from: todayIso, to: todayIso })

  const events = timeline.data?.events ?? []
  const workers = workersQuery.data?.workers ?? []
  const todaySchedules = schedules.data?.schedules ?? []
  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers])

  // Build per-project rosters — open spans = on site right now,
  // scheduled-not-yet-clocked = expected, off-site = the rest.
  type ProjectRoster = {
    projectId: string
    projectName: string
    onSite: Array<{ worker: Worker; runtimeHours: number }>
    expected: Worker[]
  }

  const rosters = useMemo<ProjectRoster[]>(() => {
    const byProject = new Map<string, ProjectRoster>()
    // Seed from clock spans (real ground truth).
    const spans = pairClockSpans(events)
    for (const s of spans) {
      const projectId = s.project_id ?? 'unassigned'
      const projectName = s.project_name ?? 'Unassigned'
      const open = findOpenSpan([s])
      if (!open) continue
      const matchingIn = events.find((e) => e.event_type === 'in' && e.occurred_at === open.in_at)
      const workerId = matchingIn?.worker_id
      if (!workerId) continue
      const worker = workerById.get(workerId)
      if (!worker) continue
      const roster = byProject.get(projectId) ?? { projectId, projectName, onSite: [], expected: [] }
      roster.onSite.push({ worker, runtimeHours: open.hours })
      byProject.set(projectId, roster)
    }
    // Layer scheduled crew into the "expected" slot if not already on-site.
    for (const sched of todaySchedules) {
      const projectId = sched.project_id
      const projectName = sched.project_name ?? 'Project'
      const roster = byProject.get(projectId) ?? { projectId, projectName, onSite: [], expected: [] }
      const onSiteIds = new Set(roster.onSite.map((r) => r.worker.id))
      if (Array.isArray(sched.crew)) {
        for (const id of sched.crew as unknown[]) {
          if (typeof id !== 'string') continue
          if (onSiteIds.has(id)) continue
          const w = workerById.get(id)
          if (w && !roster.expected.some((e) => e.id === w.id)) {
            roster.expected.push(w)
          }
        }
      }
      byProject.set(projectId, roster)
    }
    return Array.from(byProject.values()).sort((a, b) => b.onSite.length - a.onSite.length)
  }, [events, todaySchedules, workerById])

  const totalOnSite = rosters.reduce((sum, r) => sum + r.onSite.length, 0)

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-4">
        <Link to="/" className="text-[12px] text-ink-3">
          ← Foreman
        </Link>
        <h1 className="mt-2 font-display text-[24px] font-bold tracking-tight leading-tight">Live crew</h1>
        <div className="text-[13px] text-ink-2 mt-1">
          {totalOnSite} on site across {rosters.filter((r) => r.onSite.length > 0).length}{' '}
          {rosters.length === 1 ? 'project' : 'projects'}
        </div>
      </div>

      <div className="px-4 pb-8 space-y-3">
        {rosters.length === 0 ? (
          <EmptyState
            title="No crew activity today"
            body="Clock-ins land here in real time. Once a worker scans on, you'll see them grouped by project."
            primaryAction={
              <Link
                to="/schedule"
                className="w-full h-[50px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center"
              >
                Open schedule
              </Link>
            }
          />
        ) : (
          rosters.map((r) => <ProjectRosterCard key={r.projectId} roster={r} />)
        )}

        {rosters.length > 0 ? (
          <Attribution source="Live from /api/clock/timeline + /api/schedules · 30s refresh" />
        ) : null}
      </div>

      <div className="px-4 pb-6">
        <Link to="/" className="block">
          <MobileButton variant="ghost">Back to today</MobileButton>
        </Link>
      </div>
    </div>
  )
}

function ProjectRosterCard({
  roster,
}: {
  roster: {
    projectId: string
    projectName: string
    onSite: Array<{ worker: Worker; runtimeHours: number }>
    expected: Worker[]
  }
}) {
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold truncate">{roster.projectName}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {roster.onSite.length} on site · {roster.expected.length} expected
          </div>
        </div>
        {roster.onSite.length > 0 ? (
          <Pill tone="good" withDot>
            live
          </Pill>
        ) : (
          <Pill tone="default">scheduled</Pill>
        )}
      </div>
      <ul className="divide-y divide-line">
        {roster.onSite.map(({ worker, runtimeHours }) => (
          <li key={worker.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <CrewAvatar name={worker.name} tone="green" />
              <div className="min-w-0">
                <div className="text-[13px] font-medium truncate">{worker.name}</div>
                <div className="text-[11px] text-ink-3">{worker.role}</div>
              </div>
            </div>
            <span className="font-mono tabular-nums text-[12px] text-ink-2 shrink-0">{formatHms(runtimeHours)}</span>
          </li>
        ))}
        {roster.expected.map((worker) => (
          <li key={worker.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <CrewAvatar name={worker.name} tone="muted" />
              <div className="min-w-0">
                <div className="text-[13px] font-medium truncate text-ink-2">{worker.name}</div>
                <div className="text-[11px] text-ink-3">{worker.role}</div>
              </div>
            </div>
            <span className="text-[11px] text-ink-3 shrink-0">expected</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function CrewAvatar({ name, tone }: { name: string; tone: 'green' | 'muted' }) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <span
      className={
        'w-9 h-9 rounded-full text-[12px] font-semibold inline-flex items-center justify-center shrink-0 ' +
        (tone === 'green' ? 'bg-good-soft text-good' : 'bg-card-soft text-ink-3')
      }
    >
      {initials}
    </span>
  )
}
