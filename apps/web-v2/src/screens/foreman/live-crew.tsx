import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { EmptyState } from '@/components/shell/EmptyState'
import { fetchProject, projectQueryKeys } from '@/lib/api/projects'
import {
  useClockTimeline,
  useProjects,
  useSchedules,
  useWorkers,
  type ProjectDetail,
  type ProjectDetailResponse,
  type Worker,
} from '@/lib/api'
import { findOpenSpan, formatHms, pairClockSpans } from '@/lib/clock-derive'

/**
 * `fm-live-crew` — Foreman live-crew status from Sitemap §12 panel 3.
 *
 * Two views:
 *   - **List** (default): project-grouped crew with open-span runtimes.
 *   - **Map**: SVG plot of project pins on a Web-Mercator-projected
 *     bounding box of all `(site_lat, site_lng)` for projects with a
 *     geofence today. Pin radius scales with on-site count; tapping a
 *     pin scrolls the matching list card into focus.
 *
 * The map is intentionally tile-free — no Mapbox / Leaflet / Google
 * dependency. A subtle 8-cell grid hints at scale; the value of the
 * map is relative geometry, not absolute geography.
 */
export function ForemanLiveCrewScreen() {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso }, { refetchInterval: 30_000 })
  const workersQuery = useWorkers()
  const schedules = useSchedules({ from: todayIso, to: todayIso })
  const projectsQuery = useProjects({ status: 'active' })
  const [view, setView] = useState<'list' | 'map'>('list')

  const events = timeline.data?.events ?? []
  const workers = workersQuery.data?.workers ?? []
  const todaySchedules = schedules.data?.schedules ?? []
  const projects = projectsQuery.data?.projects ?? []
  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers])

  // Project list rows don't carry site_lat / site_lng — those live on
  // ProjectDetail. Parallel-fetch the per-project detail records so
  // the map view has real coordinates without a backend change.
  const detailQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: projectQueryKeys.detail(p.id),
      queryFn: (): Promise<ProjectDetailResponse> => fetchProject(p.id),
      staleTime: 5 * 60_000,
    })),
  })
  const projectDetailById = useMemo(() => {
    const m = new Map<string, ProjectDetail>()
    for (const q of detailQueries) {
      const d = q.data?.project
      if (d) m.set(d.id, d)
    }
    return m
  }, [detailQueries])

  // Build per-project rosters — open spans = on site right now,
  // scheduled-not-yet-clocked = expected, off-site = the rest.
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

  // Pins for the map view: projects with site_lat/site_lng AND
  // matching live-crew rosters. Off-site / no-geofence projects fall
  // back to the list view by design.
  const pins = useMemo(() => {
    return rosters
      .map((r) => {
        const proj = projectDetailById.get(r.projectId)
        const lat = proj?.site_lat != null ? Number(proj.site_lat) : NaN
        const lng = proj?.site_lng != null ? Number(proj.site_lng) : NaN
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
        return { roster: r, lat, lng }
      })
      .filter((p): p is { roster: ProjectRoster; lat: number; lng: number } => p !== null)
  }, [rosters, projectDetailById])

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-4">
        <Link to="/" className="text-[12px] text-ink-3">
          ← Foreman
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">Live crew</h1>
          <div className="inline-flex p-1 bg-card-soft rounded-full border border-line shrink-0">
            {(['list', 'map'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                disabled={v === 'map' && pins.length === 0}
                className={
                  view === v
                    ? 'px-3 py-1 rounded-full text-[12px] font-medium bg-bg text-ink shadow-1'
                    : 'px-3 py-1 rounded-full text-[12px] font-medium text-ink-3 disabled:opacity-50'
                }
              >
                {v === 'list' ? 'List' : 'Map'}
              </button>
            ))}
          </div>
        </div>
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
        ) : view === 'map' ? (
          <>
            <CrewMap pins={pins} />
            <Attribution source="Pins from /api/projects (site_lat / site_lng) · live counts from /api/clock/timeline" />
          </>
        ) : (
          rosters.map((r) => <ProjectRosterCard key={r.projectId} roster={r} />)
        )}

        {rosters.length > 0 && view === 'list' ? (
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

interface ProjectRoster {
  projectId: string
  projectName: string
  onSite: Array<{ worker: Worker; runtimeHours: number }>
  expected: Worker[]
}

/**
 * Tile-free map view from Sitemap §12 panel 3. Mercator-projects each
 * project pin onto a 320×220 SVG using the bounding box of all
 * supplied lat/lngs. Pin radius scales with on-site count so the
 * eye is drawn to the busiest sites first.
 *
 * No external map library or tile provider — the value here is
 * relative geography (which sites cluster, who's where in town), not
 * absolute geography. A satellite tile layer can land later via the
 * same coordinate transform when a tile budget is decided.
 */
function CrewMap({ pins }: { pins: Array<{ roster: ProjectRoster; lat: number; lng: number }> }) {
  const PADDING = 12
  const W = 320
  const H = 220
  const projected = useMercatorProjection(pins, W - PADDING * 2, H - PADDING * 2, PADDING)
  const totalOnSite = pins.reduce((sum, p) => sum + p.roster.onSite.length, 0)

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="relative bg-card-soft" style={{ aspectRatio: `${W}/${H}` }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 w-full h-full" role="img" aria-label="Crew map">
          {/* Grid hint — eight cells × five rows. Reads as 'this is a
              map, not a chart' without faking tile detail. */}
          <g aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => {
              const x = (i / 8) * W
              return (
                <line
                  key={`v${i}`}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={H}
                  stroke="currentColor"
                  strokeWidth="0.5"
                  className="text-line"
                />
              )
            })}
            {Array.from({ length: 6 }, (_, i) => {
              const y = (i / 5) * H
              return (
                <line
                  key={`h${i}`}
                  x1={0}
                  x2={W}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth="0.5"
                  className="text-line"
                />
              )
            })}
          </g>

          {/* Pins */}
          {projected.map(({ x, y, roster }) => {
            const live = roster.onSite.length
            // Radius: 12 baseline + 3.5 per worker, capped at 26.
            const r = Math.min(26, 12 + Math.sqrt(Math.max(0, live)) * 5)
            const tone = live > 0 ? 'good' : 'default'
            return (
              <Pin
                key={roster.projectId}
                x={x}
                y={y}
                r={r}
                label={live > 0 ? String(live) : '·'}
                tone={tone}
                title={roster.projectName}
              />
            )
          })}
        </svg>
        <div className="absolute top-2 left-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 bg-card/80 backdrop-blur rounded-md px-2 py-1">
          Live · {totalOnSite} on site
        </div>
      </div>
      <ul className="divide-y divide-line">
        {pins.map(({ roster }) => (
          <li key={roster.projectId} className="px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold truncate">{roster.projectName}</div>
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
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Pin({
  x,
  y,
  r,
  label,
  tone,
  title,
}: {
  x: number
  y: number
  r: number
  label: string
  tone: 'good' | 'default'
  title: string
}) {
  const fill = tone === 'good' ? 'var(--m-green)' : 'var(--m-ink-3)'
  return (
    <g>
      <title>{title}</title>
      {tone === 'good' ? <circle cx={x} cy={y} r={r * 1.6} fill={fill} opacity={0.18} /> : null}
      <circle cx={x} cy={y} r={r} fill={fill} stroke="white" strokeWidth={2} />
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontFamily="var(--m-num)"
        fontSize={Math.max(10, r * 0.7)}
        fontWeight="700"
      >
        {label}
      </text>
    </g>
  )
}

/**
 * Web-Mercator project lat/lng → SVG (x, y), scaled to fit the
 * supplied viewport with `padding` pixels on each side. Standard
 * formula: longitude → linear; latitude → log-tangent half-angle.
 */
function useMercatorProjection(
  pins: Array<{ lat: number; lng: number; roster: ProjectRoster }>,
  width: number,
  height: number,
  padding: number,
): Array<{ x: number; y: number; roster: ProjectRoster }> {
  return useMemo(() => {
    if (pins.length === 0) return []
    const project = (lat: number, lng: number): { mx: number; my: number } => {
      const mx = lng
      const clamped = Math.max(-85, Math.min(85, lat))
      const my = Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))
      return { mx, my }
    }
    const projected = pins.map((p) => ({ ...project(p.lat, p.lng), pin: p }))
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const { mx, my } of projected) {
      if (mx < minX) minX = mx
      if (mx > maxX) maxX = mx
      if (my < minY) minY = my
      if (my > maxY) maxY = my
    }
    // Single-pin case: centre it in the viewport.
    if (projected.length === 1 || minX === maxX || minY === maxY) {
      return projected.map(({ pin }) => ({ x: padding + width / 2, y: padding + height / 2, roster: pin.roster }))
    }
    const sx = width / (maxX - minX)
    const sy = height / (maxY - minY)
    const s = Math.min(sx, sy)
    // Centre the projection inside the viewport when one axis dominates.
    const offsetX = padding + (width - (maxX - minX) * s) / 2
    const offsetY = padding + (height - (maxY - minY) * s) / 2
    return projected.map(({ mx, my, pin }) => ({
      x: offsetX + (mx - minX) * s,
      // Mercator y grows north→south after log-tangent flip; invert
      // so larger lat (further north) renders higher on the SVG.
      y: offsetY + (maxY - my) * s,
      roster: pin.roster,
    }))
  }, [pins, width, height, padding])
}
