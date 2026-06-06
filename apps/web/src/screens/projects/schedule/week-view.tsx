import { Card } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { type CrewScheduleRow, type Worker } from '@/lib/api'
import { colorForProject } from './helpers'

interface WeekViewProps {
  schedules: CrewScheduleRow[]
  workers: Worker[]
  weekStartMs: number
}

/**
 * Week capacity matrix from Sitemap §7 panel 2. Replaces the prior
 * dot-pip cells with worker-initial avatars + a per-day total chip on
 * the right edge so the foreman can spot capacity gaps across the
 * week at a glance.
 *
 * Columns are top-3 projects by assignment count; rows are days. Each
 * cell shows up to 3 worker initials, then "+N" for the rest, plus a
 * "Nc" total in mono. Empty cells render as a quiet em-dash.
 */
export function WeekView({ schedules, workers, weekStartMs }: WeekViewProps) {
  const workerById = new Map(workers.map((w) => [w.id, w]))
  const projectAssignments = new Map<string, { id: string; name: string; count: number }>()
  for (const s of schedules) {
    const id = s.project_id
    const existing = projectAssignments.get(id) ?? { id, name: s.project_name ?? 'Project', count: 0 }
    existing.count += 1
    projectAssignments.set(id, existing)
  }
  const topProjects = Array.from(projectAssignments.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  const days = Array.from({ length: 7 }, (_, i) => {
    const ms = weekStartMs + i * 24 * 3600 * 1000
    const date = new Date(ms)
    return {
      iso: date.toISOString().slice(0, 10),
      dow: date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
      n: date.getDate(),
      isToday: ms <= Date.now() && Date.now() < ms + 24 * 3600 * 1000,
    }
  })

  // Per (day, project) crew member ids — dedup so the same worker
  // scheduled on two scopes for a project counts once.
  function cellWorkerIds(iso: string, projectId: string): string[] {
    const set = new Set<string>()
    for (const s of schedules) {
      if (s.scheduled_for !== iso || s.project_id !== projectId) continue
      if (!Array.isArray(s.crew)) continue
      for (const id of s.crew as unknown[]) {
        if (typeof id === 'string') set.add(id)
      }
    }
    return Array.from(set)
  }

  // Per-day total = unique workers across all projects that day.
  function dayTotal(iso: string): number {
    const set = new Set<string>()
    for (const s of schedules) {
      if (s.scheduled_for !== iso) continue
      if (!Array.isArray(s.crew)) continue
      for (const id of s.crew as unknown[]) {
        if (typeof id === 'string') set.add(id)
      }
    }
    return set.size
  }

  return (
    <div className="px-4 py-4 pb-24">
      {topProjects.length === 0 ? (
        <Card>
          <div className="text-[13px] font-semibold">Nothing scheduled this week</div>
          <div className="text-[11px] text-ink-3 mt-1">Tap + to add an assignment.</div>
        </Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <div
            className="grid items-center px-3 py-2 border-b border-line text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-4"
            style={{ gridTemplateColumns: `42px repeat(${topProjects.length}, 1fr) 36px`, gap: 6 }}
          >
            <span />
            {topProjects.map((p) => (
              <span key={p.id} className="text-center truncate">
                {p.name.slice(0, 12)}
              </span>
            ))}
            <span className="text-right">Σ</span>
          </div>
          {days.map((d) => {
            const total = dayTotal(d.iso)
            return (
              <div
                key={d.iso}
                className={`grid items-center px-3 py-2.5 border-b border-line last:border-b-0 ${
                  d.isToday ? 'bg-accent-soft' : ''
                }`}
                style={{ gridTemplateColumns: `42px repeat(${topProjects.length}, 1fr) 36px`, gap: 6 }}
              >
                <div>
                  <div className="text-[10px] text-ink-3 font-semibold">{d.dow}</div>
                  <div className={`num text-[18px] font-semibold ${d.isToday ? 'text-accent' : ''}`}>{d.n}</div>
                </div>
                {topProjects.map((p) => {
                  const ids = cellWorkerIds(d.iso, p.id)
                  const accent = colorForProject(p.name)
                  return <CapacityCell key={p.id} ids={ids} accent={accent} workerById={workerById} />
                })}
                <div className="text-right">
                  {total > 0 ? (
                    <span
                      className={`font-mono tabular-nums text-[12px] font-semibold ${d.isToday ? 'text-accent' : 'text-ink-2'}`}
                    >
                      {total}
                    </span>
                  ) : (
                    <span className="text-[11px] text-ink-4">—</span>
                  )}
                </div>
              </div>
            )
          })}
        </Card>
      )}
      {topProjects.length > 0 ? (
        <div className="mt-3 px-1">
          <Attribution source="Top 3 projects this week · per-cell crew avatars + day totals" />
        </div>
      ) : null}
    </div>
  )
}

function CapacityCell({ ids, accent, workerById }: { ids: string[]; accent: string; workerById: Map<string, Worker> }) {
  if (ids.length === 0) {
    return (
      <div
        className="h-12 rounded-md p-1.5 border flex items-center justify-center text-[11px] text-ink-4"
        style={{ background: 'var(--m-card-soft)', borderColor: 'var(--m-line)' }}
      >
        —
      </div>
    )
  }
  const visible = ids.slice(0, 3)
  const rest = ids.length - visible.length
  return (
    <div
      className="h-12 rounded-md p-1.5 border flex flex-col justify-between"
      style={{ background: `${accent}22`, borderColor: `${accent}55` }}
    >
      <div className="flex items-center -space-x-1">
        {visible.map((id) => {
          const w = workerById.get(id)
          const initials = w
            ? w.name
                .split(' ')
                .map((p) => p[0])
                .filter(Boolean)
                .slice(0, 2)
                .join('')
                .toUpperCase()
            : '?'
          return (
            <span
              key={id}
              className="w-5 h-5 rounded-full bg-card text-[8px] font-semibold inline-flex items-center justify-center ring-1"
              style={{ color: accent, ringColor: accent } as React.CSSProperties}
              title={w?.name}
            >
              {initials}
            </span>
          )
        })}
        {rest > 0 ? (
          <span
            className="w-5 h-5 rounded-full bg-card text-[8px] font-semibold inline-flex items-center justify-center ring-1"
            style={{ color: accent, ringColor: accent } as React.CSSProperties}
            aria-label={`${rest} more`}
          >
            +{rest}
          </span>
        ) : null}
      </div>
      <div className="font-mono tabular-nums text-[10px] text-ink-2 font-medium" style={{ color: accent }}>
        {ids.length}c
      </div>
    </div>
  )
}
