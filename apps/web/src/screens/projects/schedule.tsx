import { useState } from 'react'
import { useSchedules, useWorkers, useProjects } from '@/lib/api'
import { startOfWeek } from '@/lib/clock-derive'
import { FourWeekScheduleGrid } from './schedule-four-week'
import { DayView } from './schedule/day-view'
import { WeekView } from './schedule/week-view'
import { CreateAssignmentSheet } from './schedule/create-assignment-sheet'

export { initials, colorForProject } from './schedule/helpers'

export type ScheduleViewMode = 'day' | 'week' | 'four-week'

/**
 * `sch-day` + `sch-week` + `sch-4w` + `sch-create` from the design's
 * Schedule flow. One screen with three view modes (Day / Week / 4 Weeks)
 * plus a bottom sheet to create assignments. Real data + mutations
 * against /api/schedules.
 *
 * The 4-week look-ahead is per the iteration-2 design brief
 * (uploads/sitelayer_scheduling_design_brief.md → "1. Single-week grid
 * → 4-week look-ahead with click-to-zoom"). Day and Week stay around as
 * zoom-in modes.
 */
export function ScheduleScreen({ defaultView = 'week' }: { defaultView?: ScheduleViewMode } = {}) {
  const [view, setView] = useState<ScheduleViewMode>(defaultView)
  const [createOpen, setCreateOpen] = useState(false)
  const [createDefaults, setCreateDefaults] = useState<{
    date: string
    crew?: ReadonlyArray<string> | undefined
  } | null>(null)
  const todayMs = Date.now()
  const todayIso = new Date(todayMs).toISOString().slice(0, 10)
  const [selectedDate, setSelectedDate] = useState<string>(todayIso)
  const weekStart = startOfWeek(todayMs)
  const weekEnd = new Date(weekStart + 6 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const weekStartIso = new Date(weekStart).toISOString().slice(0, 10)
  // 4-week look-ahead: pull 28 days starting from the current week
  // start (per design brief §"1. Single-week grid → 4-week look-ahead").
  // Day and Week views share the same query but slice into the
  // visible week.
  const fourWeekEndMs = weekStart + 28 * 24 * 3600 * 1000 - 1
  const fourWeekEndIso = new Date(fourWeekEndMs).toISOString().slice(0, 10)
  const queryTo = view === 'four-week' ? fourWeekEndIso : weekEnd
  const schedules = useSchedules({ from: weekStartIso, to: queryTo })
  const workers = useWorkers()
  const projects = useProjects({ status: 'active' })

  const openCreateForDate = (date: string, crew?: ReadonlyArray<string>) => {
    setCreateDefaults({ date, crew })
    setCreateOpen(true)
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-2">
        <div className="flex items-baseline justify-between">
          <h1 className="font-display text-[28px] font-bold tracking-tight">Schedule</h1>
          <div className="inline-flex p-1 bg-card-soft rounded-full border border-line">
            {(['day', 'week', 'four-week'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-3 py-1 rounded-full text-[12px] font-medium ${
                  view === v ? 'bg-bg text-ink shadow-1' : 'text-ink-3'
                }`}
              >
                {v === 'day' ? 'Day' : v === 'week' ? 'Week' : '4 Weeks'}
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
      ) : view === 'week' ? (
        <WeekView
          schedules={schedules.data?.schedules ?? []}
          workers={workers.data?.workers ?? []}
          weekStartMs={weekStart}
        />
      ) : (
        <FourWeekScheduleGrid
          schedules={schedules.data?.schedules ?? []}
          workers={workers.data?.workers ?? []}
          weekStartMs={weekStart}
          onCreateForDateAndCrew={openCreateForDate}
          onZoomToWeek={() => setView('week')}
        />
      )}

      <button
        type="button"
        onClick={() => {
          setCreateDefaults({ date: selectedDate })
          setCreateOpen(true)
        }}
        aria-label="New assignment"
        className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+88px)] lg:bottom-6 w-14 h-14 rounded-2xl bg-accent text-white shadow-[0_4px_12px_rgba(217,144,74,0.4)] flex items-center justify-center text-[26px] z-30"
      >
        +
      </button>

      <CreateAssignmentSheet
        open={createOpen}
        onClose={() => {
          setCreateOpen(false)
          setCreateDefaults(null)
        }}
        projects={projects.data?.projects ?? []}
        workers={workers.data?.workers ?? []}
        defaultDate={createDefaults?.date ?? selectedDate}
        defaultCrew={createDefaults?.crew}
      />
    </div>
  )
}

export { CreateAssignmentSheet } from './schedule/create-assignment-sheet'
export type { CreateAssignmentSheetProps } from './schedule/create-assignment-sheet'
