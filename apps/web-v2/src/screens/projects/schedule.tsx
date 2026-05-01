import { useMemo, useState } from 'react'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  useProjects,
  useSchedules,
  useWorkers,
  type CrewScheduleRow,
  type ProjectListRow,
  type Worker,
} from '@/lib/api'
import { request } from '@/lib/api/client'
import { useQueryClient } from '@tanstack/react-query'
import { scheduleQueryKeys } from '@/lib/api/schedules'
import { startOfWeek } from '@/lib/clock-derive'

/**
 * `sch-day` + `sch-week` + `sch-create` from the design's Schedule
 * flow. One screen with two view modes (Day / Week) plus a bottom
 * sheet to create assignments. Real data + mutations against
 * /api/schedules.
 */
export function ScheduleScreen() {
  const [view, setView] = useState<'day' | 'week'>('day')
  const [createOpen, setCreateOpen] = useState(false)
  const todayMs = Date.now()
  const todayIso = new Date(todayMs).toISOString().slice(0, 10)
  const [selectedDate, setSelectedDate] = useState<string>(todayIso)
  const weekStart = startOfWeek(todayMs)
  const weekEnd = new Date(weekStart + 6 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const weekStartIso = new Date(weekStart).toISOString().slice(0, 10)
  const schedules = useSchedules({ from: weekStartIso, to: weekEnd })
  const workers = useWorkers()
  const projects = useProjects({ status: 'active' })

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-2">
        <div className="flex items-baseline justify-between">
          <h1 className="font-display text-[28px] font-bold tracking-tight">Schedule</h1>
          <div className="inline-flex p-1 bg-card-soft rounded-full border border-line">
            {(['day', 'week'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-3 py-1 rounded-full text-[12px] font-medium ${
                  view === v ? 'bg-bg text-ink shadow-1' : 'text-ink-3'
                }`}
              >
                {v === 'day' ? 'Day' : 'Week'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === 'day' ? (
        <DayView
          schedules={schedules.data?.schedules ?? []}
          workers={workers.data?.workers ?? []}
          weekStartMs={weekStart}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />
      ) : (
        <WeekView
          schedules={schedules.data?.schedules ?? []}
          weekStartMs={weekStart}
        />
      )}

      <button
        type="button"
        onClick={() => setCreateOpen(true)}
        aria-label="New assignment"
        className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+88px)] lg:bottom-6 w-14 h-14 rounded-2xl bg-accent text-white shadow-[0_4px_12px_rgba(217,144,74,0.4)] flex items-center justify-center text-[26px] z-30"
      >
        +
      </button>

      <CreateAssignmentSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projects={projects.data?.projects ?? []}
        workers={workers.data?.workers ?? []}
        defaultDate={selectedDate}
      />
    </div>
  )
}

interface DayViewProps {
  schedules: CrewScheduleRow[]
  workers: Worker[]
  weekStartMs: number
  selectedDate: string
  onSelectDate: (iso: string) => void
}

function DayView({ schedules, workers, weekStartMs, selectedDate, onSelectDate }: DayViewProps) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const ms = weekStartMs + i * 24 * 3600 * 1000
    const date = new Date(ms)
    return {
      iso: date.toISOString().slice(0, 10),
      dow: date.toLocaleDateString(undefined, { weekday: 'short' }),
      n: date.getDate(),
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    }
  })

  const todays = schedules.filter((s) => s.scheduled_for === selectedDate)
  const workerById = new Map(workers.map((w) => [w.id, w]))

  return (
    <>
      <div className="flex gap-1.5 px-4 py-2 overflow-x-auto border-b border-line scrollbar-hide">
        {days.map((d) => (
          <button
            key={d.iso}
            type="button"
            onClick={() => onSelectDate(d.iso)}
            className={`shrink-0 min-w-[46px] py-2 px-1 rounded-[10px] text-center ${
              selectedDate === d.iso
                ? 'bg-ink text-white'
                : d.isWeekend
                  ? 'text-ink-4'
                  : 'text-ink'
            }`}
          >
            <div className="text-[10px] font-medium opacity-70">{d.dow}</div>
            <div className="num text-[18px] font-semibold mt-0.5">{d.n}</div>
          </button>
        ))}
      </div>

      <div className="px-4 py-4 pb-24">
        {todays.length === 0 ? (
          <Card>
            <div className="text-[13px] font-semibold">No assignments for this day</div>
            <div className="text-[11px] text-ink-3 mt-1">Tap + to create one.</div>
          </Card>
        ) : (
          <div className="space-y-2.5">
            {todays.map((s) => (
              <ScheduleCard key={s.id} schedule={s} workerById={workerById} />
            ))}
            <div className="pt-1 px-1">
              <Attribution source="Live from /api/schedules" />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function ScheduleCard({ schedule, workerById }: { schedule: CrewScheduleRow; workerById: Map<string, Worker> }) {
  const crewIds = Array.isArray(schedule.crew)
    ? (schedule.crew as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const accent = colorForProject(schedule.project_name ?? schedule.project_id)
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="h-1" style={{ background: accent }} />
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold truncate">{schedule.project_name ?? 'Project'}</div>
            <div className="text-[12px] text-ink-2 mt-0.5 truncate">
              {crewIds.length} crew · {schedule.status === 'confirmed' ? 'all confirmed' : 'pending confirmation'}
            </div>
          </div>
          <Pill tone={schedule.status === 'confirmed' ? 'good' : 'warn'}>{schedule.status}</Pill>
        </div>
        <div className="flex items-center mt-3">
          <div className="flex">
            {crewIds.slice(0, 5).map((id, i) => {
              const w = workerById.get(id)
              return (
                <div
                  key={id}
                  className="w-7 h-7 rounded-full bg-card-soft border-2 border-bg text-[10px] font-semibold flex items-center justify-center text-ink-2"
                  style={{ marginLeft: i === 0 ? 0 : -8 }}
                >
                  {w ? initials(w.name) : '?'}
                </div>
              )
            })}
            {crewIds.length > 5 ? (
              <div
                className="w-7 h-7 rounded-full bg-card-soft border-2 border-bg text-[10px] font-semibold flex items-center justify-center text-ink-3"
                style={{ marginLeft: -8 }}
              >
                +{crewIds.length - 5}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  )
}

interface WeekViewProps {
  schedules: CrewScheduleRow[]
  weekStartMs: number
}

function WeekView({ schedules, weekStartMs }: WeekViewProps) {
  // Pivot: top-3 projects by assignment count, rows are days, cells
  // are crew counts.
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

  // Per (day, project) crew count.
  function cellCount(iso: string, projectId: string): number {
    return schedules
      .filter((s) => s.scheduled_for === iso && s.project_id === projectId)
      .reduce((sum, s) => sum + (Array.isArray(s.crew) ? (s.crew as unknown[]).length : 0), 0)
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
            style={{ gridTemplateColumns: `48px repeat(${topProjects.length}, 1fr)`, gap: 6 }}
          >
            <span />
            {topProjects.map((p) => (
              <span key={p.id} className="text-center truncate">
                {p.name.slice(0, 12)}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <div
              key={d.iso}
              className={`grid items-center px-3 py-2.5 border-b border-line last:border-b-0 ${
                d.isToday ? 'bg-accent-soft' : ''
              }`}
              style={{ gridTemplateColumns: `48px repeat(${topProjects.length}, 1fr)`, gap: 6 }}
            >
              <div>
                <div className="text-[10px] text-ink-3 font-semibold">{d.dow}</div>
                <div className={`num text-[18px] font-semibold ${d.isToday ? 'text-accent' : ''}`}>{d.n}</div>
              </div>
              {topProjects.map((p) => {
                const n = cellCount(d.iso, p.id)
                const accent = colorForProject(p.name)
                return (
                  <div
                    key={p.id}
                    className="h-12 rounded-md p-1.5 border"
                    style={
                      n > 0
                        ? { background: `${accent}22`, borderColor: `${accent}55` }
                        : { background: 'var(--m-card-soft)', borderColor: 'var(--m-line)' }
                    }
                  >
                    {n > 0 ? (
                      <>
                        <div className="flex items-center gap-0.5">
                          {Array.from({ length: Math.min(n, 5) }).map((_, k) => (
                            <span key={k} className="w-1.5 h-1.5 rounded-full" style={{ background: accent }} />
                          ))}
                        </div>
                        <div className="text-[9px] text-ink-2 font-medium mt-1">{n} crew</div>
                      </>
                    ) : (
                      <div className="text-[9px] text-ink-4 text-center pt-2.5">—</div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </Card>
      )}
      {topProjects.length > 0 ? (
        <div className="mt-3 px-1">
          <Attribution source="Top 3 projects this week by assignment count" />
        </div>
      ) : null}
    </div>
  )
}

interface CreateAssignmentSheetProps {
  open: boolean
  onClose: () => void
  projects: ProjectListRow[]
  workers: Worker[]
  defaultDate: string
}

function CreateAssignmentSheet({ open, onClose, projects, workers, defaultDate }: CreateAssignmentSheetProps) {
  const [projectId, setProjectId] = useState<string>('')
  const [scheduledFor, setScheduledFor] = useState(defaultDate)
  const [pickedCrew, setPickedCrew] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const qc = useQueryClient()

  const onSave = async () => {
    setError(null)
    if (!projectId) {
      setError('Pick a project')
      return
    }
    if (!scheduledFor) {
      setError('Pick a date')
      return
    }
    setSaving(true)
    try {
      await request('/api/schedules', {
        method: 'POST',
        json: {
          project_id: projectId,
          scheduled_for: scheduledFor,
          crew: Array.from(pickedCrew),
          status: 'draft',
        },
      })
      void qc.invalidateQueries({ queryKey: scheduleQueryKeys.all() })
      // Reset and close.
      setProjectId('')
      setPickedCrew(new Set())
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const toggleCrew = (id: string) => {
    setPickedCrew((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Sheet open={open} onClose={onClose} title="New assignment">
      <div className="space-y-4">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
            Project
          </label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full p-3 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
          >
            <option value="">Select…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
            Date
          </label>
          <input
            type="date"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            className="w-full p-3 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
            Crew {pickedCrew.size > 0 ? `(${pickedCrew.size})` : ''}
          </label>
          <div className="space-y-1 max-h-[40dvh] overflow-y-auto">
            {workers.length === 0 ? (
              <div className="text-[12px] text-ink-3">No workers on the roster.</div>
            ) : (
              workers.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => toggleCrew(w.id)}
                  className={`w-full p-2.5 rounded border text-left flex items-center gap-2.5 ${
                    pickedCrew.has(w.id)
                      ? 'bg-accent-soft border-accent text-ink'
                      : 'bg-card border-line text-ink-2'
                  }`}
                >
                  <div className="w-7 h-7 rounded-full bg-bg border border-line text-[10px] font-semibold flex items-center justify-center shrink-0">
                    {initials(w.name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold truncate">{w.name}</div>
                    <div className="text-[11px] text-ink-3">{w.role}</div>
                  </div>
                  {pickedCrew.has(w.id) ? <span className="text-accent">✓</span> : null}
                </button>
              ))
            )}
          </div>
        </div>

        {error ? <div className="text-[12px] text-bad px-1">{error}</div> : null}

        <div className="flex gap-2 pt-2">
          <MobileButton variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </MobileButton>
          <MobileButton variant="primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </MobileButton>
        </div>
      </div>
    </Sheet>
  )
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

const PROJECT_TONES = ['#E8A86B', '#A05A33', '#7A8C6F', '#6FA8A0', '#9C7A5B', '#C77B4F'] as const
function colorForProject(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return PROJECT_TONES[Math.abs(hash) % PROJECT_TONES.length]!
}
