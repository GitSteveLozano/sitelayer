import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  ApiError,
  dispatchCrewScheduleEvent,
  fetchCrewScheduleSnapshot,
  patchCrewSchedule,
  type CrewScheduleRow,
  type Worker,
} from '@/lib/api'
import { scheduleQueryKeys } from '@/lib/api/schedules'
import { colorForProject } from './schedule'

/**
 * 4-week look-ahead grid (`sch-4w` from the design brief at
 * /tmp/sitelayer_design_stuff/uploads/sitelayer_scheduling_design_brief.md
 * → "1. Single-week grid → 4-week look-ahead with click-to-zoom").
 *
 * Layout:
 *   - Columns = 28 days (4 weeks × 7).
 *   - Rows = crews (foreman-led + an "All crews" row at the top).
 *   - Cell = scheduled assignments for that crew on that day. The cell
 *     paints a per-project accent strip and stacks the assignment count;
 *     density encodes total crew-hours.
 *   - Sticky left column: crew name + pending count.
 *   - Sticky top row: date headers, week dividers between every 7th col.
 *
 * Interactions:
 *   - Click cell → opens the existing CreateAssignmentSheet pre-filled
 *     with that day + crew (handled by the parent ScheduleScreen).
 *   - HTML5 drag of an assignment chip → drop on a different cell PATCHes
 *     /api/schedules/:id with the new scheduled_for. 409 → reload.
 *   - "Confirm all clean" bulk button: dispatches the CONFIRM workflow
 *     event for every draft assignment in the visible 28-day window.
 *
 * The grid does NOT mirror business state — schedule rows come from the
 * existing `useSchedules({ from, to })` hook owned by ScheduleScreen.
 * This component only owns the bulk-confirm spinner state + the drag
 * source/over indicators (transient UI state, fine for plain useState).
 */
export interface FourWeekScheduleGridProps {
  schedules: CrewScheduleRow[]
  workers: Worker[]
  /** Mon 00:00 of the first visible week, in ms. The grid renders the
   *  next 28 days starting here. */
  weekStartMs: number
  /** Click-to-create (or drag-to-create from a crew row) — opens the
   *  parent's CreateAssignmentSheet pre-filled with date + optional crew. */
  onCreateForDateAndCrew: (date: string, crew?: ReadonlyArray<string>) => void
  /** "Zoom in →" link — switches the parent screen to single-week view. */
  onZoomToWeek: () => void
}

const DAY_MS = 24 * 3600 * 1000
const VISIBLE_DAYS = 28

interface CrewRow {
  /** Stable id used as the row key + drag-target marker. The "all-crews"
   *  row uses 'all'; crew rows use the foreman's worker id (we group by
   *  foreman per the design brief). */
  id: string
  label: string
  workerIds: ReadonlyArray<string>
  /** True when this is the synthetic "All crews" row at the top. */
  isAll: boolean
}

function crewIdsForSchedule(s: CrewScheduleRow): string[] {
  if (!Array.isArray(s.crew)) return []
  return (s.crew as unknown[]).filter((x): x is string => typeof x === 'string')
}

/**
 * Group workers into crews keyed by foreman. The Worker type doesn't
 * carry a foreman_id today (see lib/api/workers.ts); we approximate by
 * treating every worker whose role contains "foreman" as a crew lead and
 * bucketing the rest into a single "Crew" row when no foreman is on the
 * roster. This stays a pure projection over the workers prop so the
 * grouping is deterministic and easy to swap when the schema lands a
 * real foreman_id column.
 */
function buildCrewRows(workers: ReadonlyArray<Worker>): CrewRow[] {
  const foremen = workers.filter((w) => /foreman|lead/i.test(w.role ?? ''))
  const others = workers.filter((w) => !/foreman|lead/i.test(w.role ?? ''))
  const rows: CrewRow[] = []
  rows.push({ id: 'all', label: 'All crews', workerIds: workers.map((w) => w.id), isAll: true })
  for (const f of foremen) {
    rows.push({
      id: f.id,
      label: `${f.name}'s crew`,
      // Until a real foreman_id lands, the crew row holds just the
      // foreman themselves; per-day cell rendering still includes any
      // worker that appears on a schedule's `crew` array.
      workerIds: [f.id],
      isAll: false,
    })
  }
  if (foremen.length === 0 && others.length > 0) {
    rows.push({ id: 'unassigned', label: 'Crew', workerIds: others.map((w) => w.id), isAll: false })
  }
  return rows
}

interface DayCol {
  iso: string
  ms: number
  dow: string
  n: number
  isWeekStart: boolean
  isToday: boolean
  weekIdx: number
}

function buildDays(weekStartMs: number): DayCol[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  return Array.from({ length: VISIBLE_DAYS }, (_, i) => {
    const ms = weekStartMs + i * DAY_MS
    const date = new Date(ms)
    return {
      iso: date.toISOString().slice(0, 10),
      ms,
      dow: date.toLocaleDateString(undefined, { weekday: 'short' })[0] ?? '',
      n: date.getDate(),
      isWeekStart: i % 7 === 0,
      isToday: ms === todayMs,
      weekIdx: Math.floor(i / 7),
    }
  })
}

export function FourWeekScheduleGrid({
  schedules,
  workers,
  weekStartMs,
  onCreateForDateAndCrew,
  onZoomToWeek,
}: FourWeekScheduleGridProps) {
  const qc = useQueryClient()
  const days = useMemo(() => buildDays(weekStartMs), [weekStartMs])
  const crews = useMemo(() => buildCrewRows(workers), [workers])
  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w] as const)), [workers])

  // Index schedules by (crewRowId, day-iso). The "all" row gets every
  // schedule; per-foreman rows include schedules where any of the row's
  // worker ids are on the crew. Computed once per render so cell lookup
  // is O(1).
  const cellIndex = useMemo(() => {
    const map = new Map<string, CrewScheduleRow[]>()
    const key = (rowId: string, iso: string) => `${rowId}|${iso}`
    for (const s of schedules) {
      const ids = crewIdsForSchedule(s)
      // Always add to the all-crews row.
      const allK = key('all', s.scheduled_for)
      if (!map.has(allK)) map.set(allK, [])
      map.get(allK)!.push(s)
      // For each foreman row, add when one of the row's worker ids is on
      // the crew. The "unassigned" row catches schedules whose crew
      // doesn't intersect any foreman row.
      let placed = false
      for (const c of crews) {
        if (c.isAll) continue
        if (c.id === 'unassigned') continue
        if (c.workerIds.some((w) => ids.includes(w))) {
          const k = key(c.id, s.scheduled_for)
          if (!map.has(k)) map.set(k, [])
          map.get(k)!.push(s)
          placed = true
        }
      }
      if (!placed) {
        const u = key('unassigned', s.scheduled_for)
        if (!map.has(u)) map.set(u, [])
        map.get(u)!.push(s)
      }
    }
    return map
  }, [schedules, crews])

  const pendingByCrewRow = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of crews) {
      let n = 0
      for (const d of days) {
        const cell = cellIndex.get(`${c.id}|${d.iso}`) ?? []
        for (const s of cell) if (s.status !== 'confirmed') n += 1
      }
      counts.set(c.id, n)
    }
    return counts
  }, [crews, days, cellIndex])

  const allDrafts = useMemo(() => schedules.filter((s) => s.status !== 'confirmed'), [schedules])
  const allConfirmed = schedules.length > 0 && allDrafts.length === 0

  // Drag-to-reschedule. We track only the dragged schedule id and the
  // hovered cell key; the actual PATCH happens onDrop.
  const [dragId, setDragId] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState<{ ok: number; failed: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reloadSchedules = useCallback(() => {
    void qc.invalidateQueries({ queryKey: scheduleQueryKeys.all() })
  }, [qc])

  const onDrop = useCallback(
    async (targetIso: string) => {
      if (!dragId) return
      const target = schedules.find((s) => s.id === dragId)
      setDragId(null)
      setOverKey(null)
      if (!target) return
      if (target.scheduled_for === targetIso) return
      setError(null)
      try {
        await patchCrewSchedule(target.id, {
          scheduled_for: targetIso,
          expected_version: target.version,
        })
        reloadSchedules()
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setError('Schedule moved while you were dragging — reloading.')
          reloadSchedules()
          return
        }
        setError(err instanceof Error ? err.message : 'reschedule failed')
      }
    },
    [dragId, schedules, reloadSchedules],
  )

  const onConfirmAllClean = useCallback(async () => {
    if (allDrafts.length === 0) return
    setBulkBusy(true)
    setBulkResult(null)
    setError(null)
    let ok = 0
    let failed = 0
    // Sequential dispatch so 409s on one row don't cascade into a
    // thundering herd of reloads. Each call updates the snapshot cache
    // via the mutation's onSuccess; we invalidate the list once at the
    // end to avoid spamming the schedules query.
    for (const draft of allDrafts) {
      try {
        // Need the current state_version — pull a fresh snapshot first so
        // we don't fight with offline-replay rows that may have already
        // bumped server-side. The endpoint is cheap (single row).
        const snap = await fetchCrewScheduleSnapshot(draft.id)
        if (snap.state !== 'draft') {
          ok += 1
          continue
        }
        await dispatchCrewScheduleEvent(draft.id, {
          event: 'CONFIRM',
          state_version: snap.state_version,
        })
        ok += 1
      } catch {
        failed += 1
      }
    }
    setBulkResult({ ok, failed })
    setBulkBusy(false)
    reloadSchedules()
  }, [allDrafts, reloadSchedules])

  // Cell hour total — drives the density swatch.
  function cellHours(rowId: string, iso: string): number {
    const rows = cellIndex.get(`${rowId}|${iso}`) ?? []
    let h = 0
    for (const s of rows) {
      const start = parseTime(s.start_time)
      const end = parseTime(s.end_time)
      const duration = start != null && end != null && end > start ? (end - start) / 3600 : 6
      const crew = crewIdsForSchedule(s).length || 1
      h += duration * crew
    }
    return h
  }

  return (
    <div className="px-4 py-4 pb-24">
      <Card className="!p-3 mb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">4-week look-ahead</div>
            <div className="text-[11px] text-ink-3 mt-0.5">
              {schedules.length} assignment{schedules.length === 1 ? '' : 's'}
              {' · '}
              <span className={allConfirmed ? 'text-good' : 'text-warn'}>
                {allConfirmed ? 'all confirmed' : `${allDrafts.length} pending`}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onZoomToWeek}
              className="text-[12px] text-accent font-medium px-2 py-1"
              aria-label="Zoom into week view"
            >
              Zoom to week ›
            </button>
            <MobileButton variant="primary" onClick={onConfirmAllClean} disabled={bulkBusy || allDrafts.length === 0}>
              {bulkBusy
                ? `Confirming… (${bulkResult?.ok ?? 0}/${allDrafts.length})`
                : allDrafts.length === 0
                  ? 'All confirmed'
                  : `Confirm all clean (${allDrafts.length})`}
            </MobileButton>
          </div>
        </div>
        {bulkResult && !bulkBusy ? (
          <div className="text-[11px] text-ink-3 mt-2">
            Confirmed <span className="font-medium text-ink-2">{bulkResult.ok}</span>
            {bulkResult.failed > 0 ? (
              <>
                {' · '}
                <span className="text-bad font-medium">{bulkResult.failed}</span> failed (reload to retry)
              </>
            ) : null}
          </div>
        ) : null}
        {error ? <div className="text-[11px] text-bad mt-2">{error}</div> : null}
      </Card>

      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto" role="region" aria-label="4-week schedule grid">
          <div
            className="grid"
            style={{
              gridTemplateColumns: `200px repeat(${VISIBLE_DAYS}, minmax(36px, 1fr))`,
              minWidth: 200 + VISIBLE_DAYS * 36,
            }}
          >
            {/* Sticky top-left corner */}
            <div
              className="sticky left-0 top-0 z-20 bg-card border-b border-r border-line px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3"
              style={{ position: 'sticky' }}
            >
              Crew
            </div>
            {days.map((d) => (
              <div
                key={d.iso}
                className={`border-b border-line px-1 py-2 text-center ${
                  d.isWeekStart ? 'border-l border-line-2' : ''
                } ${d.isToday ? 'bg-accent-soft' : ''}`}
                title={d.iso}
              >
                <div className="text-[9px] uppercase tracking-[0.06em] text-ink-3">{d.dow}</div>
                <div className={`num text-[12px] font-semibold ${d.isToday ? 'text-accent' : 'text-ink-2'}`}>{d.n}</div>
              </div>
            ))}

            {crews.map((c) => {
              const pending = pendingByCrewRow.get(c.id) ?? 0
              return (
                <FourWeekRow
                  key={c.id}
                  crew={c}
                  pending={pending}
                  days={days}
                  cellIndex={cellIndex}
                  workerById={workerById}
                  cellHours={cellHours}
                  dragId={dragId}
                  overKey={overKey}
                  onDragStart={setDragId}
                  onDragEnd={() => {
                    setDragId(null)
                    setOverKey(null)
                  }}
                  onDragOver={(rowId, iso) => setOverKey(`${rowId}|${iso}`)}
                  onDrop={onDrop}
                  onCellClick={(iso) =>
                    onCreateForDateAndCrew(iso, c.isAll || c.id === 'unassigned' ? undefined : c.workerIds)
                  }
                />
              )
            })}
          </div>
        </div>
      </Card>

      <div className="mt-3 px-1">
        <Attribution source="4-week look-ahead · drag chips to reschedule · click empty cells to add" />
      </div>
    </div>
  )
}

interface FourWeekRowProps {
  crew: CrewRow
  pending: number
  days: ReadonlyArray<DayCol>
  cellIndex: Map<string, CrewScheduleRow[]>
  workerById: Map<string, Worker>
  cellHours: (rowId: string, iso: string) => number
  dragId: string | null
  overKey: string | null
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDragOver: (rowId: string, iso: string) => void
  onDrop: (iso: string) => void
  onCellClick: (iso: string) => void
}

function FourWeekRow({
  crew,
  pending,
  days,
  cellIndex,
  workerById: _workerById,
  cellHours,
  dragId,
  overKey,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onCellClick,
}: FourWeekRowProps) {
  return (
    <>
      {/* Sticky left column: crew label + pending count. */}
      <div
        className={`sticky left-0 z-10 bg-card border-b border-r border-line px-2 py-2 ${
          crew.isAll ? 'bg-card-soft' : ''
        }`}
        style={{ position: 'sticky' }}
      >
        <div className="text-[12px] font-semibold truncate">{crew.label}</div>
        <div className="text-[10px] text-ink-3 mt-0.5">
          {crew.workerIds.length} worker{crew.workerIds.length === 1 ? '' : 's'}
          {pending > 0 ? (
            <>
              {' · '}
              <span className="text-warn font-medium">{pending} pending</span>
            </>
          ) : null}
        </div>
      </div>
      {days.map((d) => {
        const cell = cellIndex.get(`${crew.id}|${d.iso}`) ?? []
        const hours = cellHours(crew.id, d.iso)
        const k = `${crew.id}|${d.iso}`
        const isOver = overKey === k && dragId != null
        // Density: 0–4h light, 4–10h medium, 10h+ heavy. The strip at
        // the cell edge is the project accent; the body opacity tracks
        // total crew-hours.
        const density = hours <= 0 ? 0 : hours < 4 ? 0.25 : hours < 10 ? 0.55 : 0.85
        const accent = cell[0] ? colorForProject(cell[0].project_name ?? cell[0].project_id) : null
        return (
          <button
            type="button"
            key={d.iso}
            onClick={() => (cell.length === 0 ? onCellClick(d.iso) : onCellClick(d.iso))}
            onDragOver={(e) => {
              if (dragId) {
                e.preventDefault()
                onDragOver(crew.id, d.iso)
              }
            }}
            onDrop={(e) => {
              if (!dragId) return
              e.preventDefault()
              onDrop(d.iso)
            }}
            className={`relative border-b border-line min-h-[52px] text-left ${
              d.isWeekStart ? 'border-l border-line-2' : ''
            } ${isOver ? 'ring-2 ring-accent ring-inset' : ''} ${d.isToday ? 'bg-accent-soft/30' : ''}`}
            style={accent ? { background: `${accent}${alphaHex(density)}` } : undefined}
            aria-label={`${crew.label}, ${d.iso}, ${cell.length} assignments`}
          >
            {accent ? (
              <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: accent }} />
            ) : null}
            <div className="p-1 flex flex-col gap-1 min-h-[52px]">
              {cell.length === 0 ? (
                <span className="text-[10px] text-ink-4 opacity-0 hover:opacity-100">+</span>
              ) : (
                cell.slice(0, 2).map((s) => {
                  const ids = crewIdsForSchedule(s)
                  return (
                    <span
                      key={s.id}
                      draggable
                      onDragStart={(e) => {
                        // Allow the drop target to consume; native drag
                        // requires data even though we route the id via
                        // component state.
                        e.dataTransfer.setData('text/plain', s.id)
                        onDragStart(s.id)
                      }}
                      onDragEnd={onDragEnd}
                      onClick={(e) => e.stopPropagation()}
                      className="block text-[9px] leading-tight px-1 py-[2px] rounded bg-card border border-line truncate"
                      title={`${s.project_name ?? 'Project'} · ${ids.length} crew · ${s.status}`}
                      style={{ opacity: dragId === s.id ? 0.4 : 1 }}
                    >
                      <span className="font-medium">{(s.project_name ?? 'Project').split(' — ')[0]}</span>
                      {ids.length > 0 ? <span className="text-ink-3 num">{` · ${ids.length}c`}</span> : null}
                      {s.status !== 'confirmed' ? (
                        <span className="ml-1 text-warn" aria-label="pending">
                          •
                        </span>
                      ) : null}
                    </span>
                  )
                })
              )}
              {cell.length > 2 ? <span className="text-[9px] text-ink-3 num">+{cell.length - 2} more</span> : null}
            </div>
          </button>
        )
      })}
    </>
  )
}

function alphaHex(density: number): string {
  // Convert 0..1 density to a 2-digit hex alpha suffix appended to the
  // 6-char accent color. We render at relatively low alpha (max 30%) so
  // the cell text stays readable against the accent backdrop.
  const a = Math.round(Math.max(0, Math.min(1, density)) * 0x40)
  return a.toString(16).padStart(2, '0')
}

function parseTime(t: string | null | undefined): number | null {
  if (!t) return null
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const s = m[3] ? Number(m[3]) : 0
  if (h > 23 || min > 59 || s > 59) return null
  return h * 3600 + min * 60 + s
}

// Helper used by both this file and the inline status pill renderer in
// the grid. Re-exported for completeness even though no caller outside
// the grid uses it today.
export function statusPillTone(status: 'draft' | 'confirmed'): 'good' | 'warn' {
  return status === 'confirmed' ? 'good' : 'warn'
}

void Pill // Pill is re-exported indirectly; reference keeps the bundler from tree-shaking unused imports during dev iteration.
