import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiPost } from '../api.js'
import type { BootstrapResponse, ScheduleRow, WorkerRow } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Select } from '../components/ui/select.js'
import { toastError, toastSuccess } from '../components/ui/toast.js'

// ---------------------------------------------------------------------------
// Weekly crew schedule grid
// ---------------------------------------------------------------------------
//
// Office admins need to pre-populate the week so foremen arrive knowing who's
// expected. We render one row per active project across 7 day columns (ISO
// week, Mon–Sun). Each cell aggregates the most-recent non-deleted
// crew_schedule row for that (project, day) pair and shows crew member chips.
//
// Mutations: there is no PATCH endpoint for crew_schedules today, so every
// change POSTs a fresh row via /api/schedules. listSchedules (server-side) and
// the grid below both resolve duplicates by picking the most recent by
// created_at; this matches what /confirm already assumes.
//
// Drag-drop: HTML5 native drag events from a left-rail worker palette onto
// cells. Touch devices fall back to a long-press-to-lift gesture driven by
// pointer events, since iOS Safari does not fire HTML5 drag events from
// touches.
// ---------------------------------------------------------------------------

type ScheduleViewProps = {
  bootstrap: BootstrapResponse | null
  schedules: ScheduleRow[]
  workers: WorkerRow[]
  serviceItems: BootstrapResponse['serviceItems']
  companySlug: string
  onMutated?: () => Promise<void> | void
}

type CrewMember = {
  worker_id: string
  name: string
  expected_hours: number
  default_service_item_code?: string
}

type CellKey = string // `${projectId}::${yyyyMmDd}`

type CellState = {
  scheduleId: string | null
  status: string
  version: number
  crew: CrewMember[]
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const LONG_PRESS_MS = 400

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Returns the Monday (00:00 local time) of the ISO week containing `date`.
function startOfISOWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = d.getDay() // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  d.setDate(d.getDate() + days)
  return d
}

function weekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

function formatDayHeader(date: Date, index: number): string {
  return `${DAY_LABELS[index]} ${date.getMonth() + 1}/${date.getDate()}`
}

function buildCellKey(projectId: string, scheduledFor: string): CellKey {
  return `${projectId}::${scheduledFor}`
}

// Coerce the jsonb crew column (server stores `unknown[]`) into the shape the
// grid and /confirm both expect. Tolerates legacy `string[]` fixtures.
function coerceCrew(raw: unknown, workers: WorkerRow[]): CrewMember[] {
  if (!Array.isArray(raw)) return []
  const result: CrewMember[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const matched = workers.find((worker) => worker.name === entry)
      if (matched) {
        result.push({ worker_id: matched.id, name: matched.name, expected_hours: 8 })
      }
      continue
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      const workerId = typeof record.worker_id === 'string' ? record.worker_id : null
      const name =
        typeof record.name === 'string'
          ? record.name
          : (workerId && workers.find((worker) => worker.id === workerId)?.name) || null
      if (!workerId || !name) continue
      const hours =
        typeof record.expected_hours === 'number'
          ? record.expected_hours
          : typeof record.expected_hours === 'string'
            ? Number(record.expected_hours) || 8
            : 8
      const defaultServiceItemCode =
        typeof record.default_service_item_code === 'string' ? record.default_service_item_code : undefined
      const member: CrewMember = { worker_id: workerId, name, expected_hours: hours }
      if (defaultServiceItemCode) member.default_service_item_code = defaultServiceItemCode
      result.push(member)
    }
  }
  return result
}

// Collapse possibly-many rows per (project, day) into one authoritative cell.
// The server's listSchedules already orders by created_at desc; we re-apply
// here so offline-queued mutations that mutate the local copy stay consistent.
function buildCellMap(
  schedules: ScheduleRow[],
  workers: WorkerRow[],
  projectIds: Set<string>,
  weekDates: string[],
): Map<CellKey, CellState> {
  const weekSet = new Set(weekDates)
  const byKey = new Map<CellKey, ScheduleRow>()
  for (const schedule of schedules) {
    if (schedule.deleted_at) continue
    if (!projectIds.has(schedule.project_id)) continue
    if (!weekSet.has(schedule.scheduled_for)) continue
    const key = buildCellKey(schedule.project_id, schedule.scheduled_for)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, schedule)
      continue
    }
    const existingAt = existing.created_at ?? ''
    const candidateAt = schedule.created_at ?? ''
    if (candidateAt > existingAt) {
      byKey.set(key, schedule)
    }
  }

  const cells = new Map<CellKey, CellState>()
  for (const [key, schedule] of byKey) {
    cells.set(key, {
      scheduleId: schedule.id,
      status: schedule.status,
      version: schedule.version,
      crew: coerceCrew(schedule.crew, workers),
    })
  }
  return cells
}

function emptyCell(): CellState {
  return { scheduleId: null, status: 'draft', version: 0, crew: [] }
}

type DragPayload = { kind: 'worker'; workerId: string; name: string }

// A tiny in-memory drag state that covers both HTML5 drag-and-drop and
// pointer-based long-press fallback. HTML5 drag events can carry data in
// dataTransfer, but on touch devices we never get those events — so we keep a
// ref that a hit-tested drop handler can consult.
const pointerDragState: { payload: DragPayload | null } = { payload: null }

export function ScheduleView({
  bootstrap,
  schedules,
  workers,
  serviceItems,
  companySlug,
  onMutated,
}: ScheduleViewProps) {
  const projects = useMemo(
    () => (bootstrap?.projects ?? []).filter((project) => !project.closed_at && project.status !== 'closed'),
    [bootstrap?.projects],
  )
  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects])

  const [weekStart, setWeekStart] = useState<Date>(() => startOfISOWeek(new Date()))
  const [busyCell, setBusyCell] = useState<CellKey | null>(null)
  const [copying, setCopying] = useState(false)
  const [popoverCell, setPopoverCell] = useState<CellKey | null>(null)
  const [dragHoverCell, setDragHoverCell] = useState<CellKey | null>(null)

  const days = useMemo(() => weekDays(weekStart), [weekStart])
  const weekDates = useMemo(() => days.map((day) => toISODate(day)), [days])
  const weekDatesKey = weekDates.join(',')

  // Keep a local overlay on top of the server-provided schedules so a fresh
  // POST reflects instantly even if the parent refresh hasn't re-hydrated yet.
  const [localCells, setLocalCells] = useState<Map<CellKey, CellState>>(() => new Map())
  useEffect(() => {
    setLocalCells(buildCellMap(schedules, workers, projectIds, weekDates))
    // weekDatesKey is a derived string, safe in deps; avoids re-running on
    // every render of the seven-element array. eslint does not know this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedules, workers, projectIds, weekDatesKey])

  const getCell = useCallback(
    (projectId: string, scheduledFor: string): CellState => {
      return localCells.get(buildCellKey(projectId, scheduledFor)) ?? emptyCell()
    },
    [localCells],
  )

  const persistCell = useCallback(
    async (projectId: string, scheduledFor: string, nextCrew: CrewMember[], statusHint?: string) => {
      const key = buildCellKey(projectId, scheduledFor)
      const existing = localCells.get(key) ?? emptyCell()
      const optimistic: CellState = {
        scheduleId: existing.scheduleId,
        status: statusHint ?? existing.status,
        version: existing.version,
        crew: nextCrew,
      }
      // Optimistic overlay so chips appear/disappear without a full refresh.
      setLocalCells((current) => {
        const next = new Map(current)
        next.set(key, optimistic)
        return next
      })
      setBusyCell(key)
      try {
        const body = {
          project_id: projectId,
          scheduled_for: scheduledFor,
          status: optimistic.status || 'draft',
          crew: nextCrew.map((member) => ({
            worker_id: member.worker_id,
            name: member.name,
            expected_hours: member.expected_hours,
            ...(member.default_service_item_code
              ? { default_service_item_code: member.default_service_item_code }
              : {}),
          })),
        }
        await apiPost('/api/schedules', body, companySlug)
      } catch (error) {
        toastError('Schedule save failed', error instanceof Error ? error.message : 'unknown error')
        // Roll back to whatever the props said.
        setLocalCells(buildCellMap(schedules, workers, projectIds, weekDates))
      } finally {
        setBusyCell((current) => (current === key ? null : current))
      }
      if (onMutated) await onMutated()
    },
    [companySlug, localCells, onMutated, projectIds, schedules, weekDates, workers],
  )

  const addWorker = useCallback(
    (projectId: string, scheduledFor: string, workerId: string) => {
      const worker = workers.find((candidate) => candidate.id === workerId)
      if (!worker) return
      const cell = getCell(projectId, scheduledFor)
      if (cell.crew.some((member) => member.worker_id === workerId)) return
      const nextCrew = [
        ...cell.crew,
        { worker_id: worker.id, name: worker.name, expected_hours: 8 } satisfies CrewMember,
      ]
      void persistCell(projectId, scheduledFor, nextCrew)
    },
    [getCell, persistCell, workers],
  )

  const removeWorker = useCallback(
    (projectId: string, scheduledFor: string, workerId: string) => {
      const cell = getCell(projectId, scheduledFor)
      const nextCrew = cell.crew.filter((member) => member.worker_id !== workerId)
      if (nextCrew.length === cell.crew.length) return
      void persistCell(projectId, scheduledFor, nextCrew)
    },
    [getCell, persistCell],
  )

  const copyLastWeek = useCallback(async () => {
    const lastWeekStart = addDays(weekStart, -7)
    const lastWeekDates = weekDays(lastWeekStart).map((day) => toISODate(day))
    const sourceMap = buildCellMap(schedules, workers, projectIds, lastWeekDates)
    if (sourceMap.size === 0) {
      toastError('Copy skipped', 'No schedules found in the previous week.')
      return
    }
    setCopying(true)
    let created = 0
    let failed = 0
    for (const [key, cell] of sourceMap) {
      if (cell.crew.length === 0) continue
      const [projectId, sourceDate] = key.split('::')
      if (!projectId || !sourceDate) continue
      const offsetDate = addDays(new Date(`${sourceDate}T00:00:00`), 7)
      const targetDate = toISODate(offsetDate)
      const targetKey = buildCellKey(projectId, targetDate)
      const targetExisting = localCells.get(targetKey)
      if (targetExisting && targetExisting.crew.length > 0) continue
      try {
        await apiPost(
          '/api/schedules',
          {
            project_id: projectId,
            scheduled_for: targetDate,
            status: 'draft',
            crew: cell.crew.map((member) => ({
              worker_id: member.worker_id,
              name: member.name,
              expected_hours: member.expected_hours,
              ...(member.default_service_item_code
                ? { default_service_item_code: member.default_service_item_code }
                : {}),
            })),
          },
          companySlug,
        )
        setLocalCells((current) => {
          const next = new Map(current)
          next.set(targetKey, {
            scheduleId: null,
            status: 'draft',
            version: 0,
            crew: cell.crew.slice(),
          })
          return next
        })
        created += 1
      } catch {
        failed += 1
      }
    }
    setCopying(false)
    if (created > 0) {
      toastSuccess('Copied last week', `${created} schedule${created === 1 ? '' : 's'} created`)
    } else if (failed === 0) {
      toastError('Copy skipped', 'Last week had no crew to copy or this week is already populated.')
    }
    if (failed > 0) {
      toastError('Partial copy', `${failed} schedule${failed === 1 ? '' : 's'} failed to create`)
    }
    if (onMutated) await onMutated()
  }, [companySlug, localCells, onMutated, projectIds, schedules, weekStart, workers])

  if (!bootstrap || projects.length === 0) {
    return (
      <section className="panel" data-testid="schedule-empty">
        <h2>Weekly Schedule</h2>
        <p className="muted">No active projects yet. Create a project to start scheduling crews.</p>
      </section>
    )
  }

  const weekLabel = `${toISODate(days[0]!)} → ${toISODate(days[6]!)}`

  return (
    <section className="panel" data-testid="schedule-view">
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Weekly Schedule</h2>
          <p className="muted" style={{ margin: 0 }}>
            {weekLabel}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setWeekStart((current) => addDays(current, -7))}
            data-testid="schedule-prev-week"
          >
            ← Prev
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setWeekStart(startOfISOWeek(new Date()))}
            data-testid="schedule-this-week"
          >
            This week
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setWeekStart((current) => addDays(current, 7))}
            data-testid="schedule-next-week"
          >
            Next →
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void copyLastWeek()}
            disabled={copying}
            data-testid="schedule-copy-last-week"
          >
            {copying ? 'Copying…' : 'Copy last week'}
          </Button>
        </div>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(180px, 260px) 1fr',
          gap: 16,
          marginTop: 16,
        }}
        className="scheduleLayout"
      >
        <WorkerRail workers={workers} />

        <div style={{ overflowX: 'auto' }} data-testid="schedule-grid" role="grid" aria-label="Weekly crew schedule">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `minmax(160px, 1.2fr) repeat(7, minmax(140px, 1fr))`,
              gap: 6,
              minWidth: 960,
            }}
          >
            <div className="scheduleHeaderCell" style={headerCellStyle}>
              Project
            </div>
            {days.map((day, index) => (
              <div key={toISODate(day)} className="scheduleHeaderCell" style={headerCellStyle} role="columnheader">
                {formatDayHeader(day, index)}
              </div>
            ))}
            {projects.map((project) => (
              <Fragment key={project.id}>
                <div style={rowLabelStyle} role="rowheader">
                  <strong>{project.name}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {project.customer_name}
                  </div>
                </div>
                {days.map((day) => {
                  const scheduledFor = toISODate(day)
                  const cellKey = buildCellKey(project.id, scheduledFor)
                  const cell = getCell(project.id, scheduledFor)
                  return (
                    <ScheduleCell
                      key={cellKey}
                      cellKey={cellKey}
                      projectName={project.name}
                      scheduledFor={scheduledFor}
                      cell={cell}
                      workers={workers}
                      serviceItems={serviceItems}
                      busy={busyCell === cellKey}
                      popoverOpen={popoverCell === cellKey}
                      dragHover={dragHoverCell === cellKey}
                      onOpenPopover={(open) => setPopoverCell(open ? cellKey : null)}
                      onDragHoverChange={(hovering) => setDragHoverCell(hovering ? cellKey : null)}
                      onAddWorker={(workerId) => addWorker(project.id, scheduledFor, workerId)}
                      onRemoveWorker={(workerId) => removeWorker(project.id, scheduledFor, workerId)}
                    />
                  )
                })}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

// React.Fragment alias so JSX inline usage stays compact; avoids importing the
// whole React namespace at the top of the file.
function Fragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

const headerCellStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  background: 'rgba(30, 41, 59, 0.6)',
  padding: '8px 10px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  textAlign: 'center',
}

const rowLabelStyle: React.CSSProperties = {
  padding: '10px 12px',
  background: 'rgba(30, 41, 59, 0.35)',
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  minHeight: 72,
}

function WorkerRail({ workers }: { workers: WorkerRow[] }) {
  const active = workers.filter((worker) => !worker.deleted_at)
  return (
    <aside
      data-testid="schedule-worker-rail"
      style={{
        background: 'rgba(30, 41, 59, 0.35)',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignSelf: 'start',
        position: 'sticky',
        top: 8,
      }}
    >
      <strong style={{ fontSize: 13 }}>Workers</strong>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Drag onto a day cell to assign. On touch, long-press to lift.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {active.map((worker) => (
          <WorkerChipDraggable key={worker.id} worker={worker} />
        ))}
        {active.length === 0 ? <li className="muted">No active workers yet.</li> : null}
      </ul>
    </aside>
  )
}

function WorkerChipDraggable({ worker }: { worker: WorkerRow }) {
  const [lifted, setLifted] = useState(false)
  const longPressTimer = useRef<number | null>(null)

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  // Pointer-based fallback: on touch devices the native HTML5 drag events
  // don't fire, so we emulate drag through pointermove / pointerup hit-testing.
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLLIElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
      cancelLongPress()
      const payload: DragPayload = { kind: 'worker', workerId: worker.id, name: worker.name }
      longPressTimer.current = window.setTimeout(() => {
        pointerDragState.payload = payload
        setLifted(true)
        // Prevent the browser from scrolling while dragging.
        event.currentTarget.setPointerCapture(event.pointerId)
      }, LONG_PRESS_MS)
    },
    [cancelLongPress, worker.id, worker.name],
  )

  const onPointerMove = useCallback(() => {
    // Once lifted, nothing to do here — the cells handle hit-testing via
    // pointerenter / pointerleave that fires when capture releases them.
  }, [])

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLLIElement>) => {
      cancelLongPress()
      if (!lifted) return
      // Release capture so pointerup bubbles to the underlying cell via the
      // synthetic `touchend` elementFromPoint lookup.
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        /* no-op */
      }
      const target = document.elementFromPoint(event.clientX, event.clientY)
      const cellEl = target?.closest<HTMLElement>('[data-cell-key]')
      if (cellEl && pointerDragState.payload) {
        cellEl.dispatchEvent(
          new CustomEvent('sitelayer:pointer-drop', {
            detail: pointerDragState.payload,
            bubbles: true,
          }),
        )
      }
      pointerDragState.payload = null
      setLifted(false)
    },
    [cancelLongPress, lifted],
  )

  const onPointerCancel = useCallback(() => {
    cancelLongPress()
    pointerDragState.payload = null
    setLifted(false)
  }, [cancelLongPress])

  return (
    <li
      draggable
      data-testid={`worker-chip-${worker.id}`}
      onDragStart={(event) => {
        const payload: DragPayload = { kind: 'worker', workerId: worker.id, name: worker.name }
        pointerDragState.payload = payload
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('application/x-sitelayer-worker', JSON.stringify(payload))
        event.dataTransfer.setData('text/plain', worker.name)
      }}
      onDragEnd={() => {
        pointerDragState.payload = null
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid rgba(148, 163, 184, 0.35)',
        background: lifted ? 'rgba(56, 189, 248, 0.25)' : 'rgba(15, 23, 42, 0.6)',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 13 }}>{worker.name}</span>
      <span className="muted" style={{ fontSize: 11 }}>
        {worker.role}
      </span>
    </li>
  )
}

type ScheduleCellProps = {
  cellKey: CellKey
  projectName: string
  scheduledFor: string
  cell: CellState
  workers: WorkerRow[]
  serviceItems: BootstrapResponse['serviceItems']
  busy: boolean
  popoverOpen: boolean
  dragHover: boolean
  onOpenPopover: (open: boolean) => void
  onDragHoverChange: (hovering: boolean) => void
  onAddWorker: (workerId: string) => void
  onRemoveWorker: (workerId: string) => void
}

function ScheduleCell({
  cellKey,
  projectName,
  scheduledFor,
  cell,
  workers,
  serviceItems,
  busy,
  popoverOpen,
  dragHover,
  onOpenPopover,
  onDragHoverChange,
  onAddWorker,
  onRemoveWorker,
}: ScheduleCellProps) {
  const cellRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = cellRef.current
    if (!node) return
    // Pointer-based drop bridge. WorkerChipDraggable dispatches a custom
    // `sitelayer:pointer-drop` event after long-press touch drags, because
    // touch events skip the dataTransfer flow.
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DragPayload>).detail
      if (!detail || detail.kind !== 'worker') return
      onAddWorker(detail.workerId)
    }
    node.addEventListener('sitelayer:pointer-drop', handler as EventListener)
    return () => {
      node.removeEventListener('sitelayer:pointer-drop', handler as EventListener)
    }
  }, [onAddWorker])

  const assigned = cell.crew
  const unassigned = workers.filter(
    (worker) => !worker.deleted_at && !assigned.some((member) => member.worker_id === worker.id),
  )

  const statusStyle: React.CSSProperties = {
    position: 'relative',
    minHeight: 96,
    padding: 8,
    borderRadius: 8,
    background: dragHover ? 'rgba(56, 189, 248, 0.18)' : 'rgba(15, 23, 42, 0.5)',
    border: dragHover ? '2px dashed rgba(56, 189, 248, 0.8)' : '1px solid rgba(148, 163, 184, 0.25)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    transition: 'background 0.12s ease, border-color 0.12s ease',
    opacity: busy ? 0.6 : 1,
  }

  return (
    <div
      ref={cellRef}
      data-testid={`schedule-cell-${cellKey}`}
      data-cell-key={cellKey}
      role="gridcell"
      aria-label={`${projectName} on ${scheduledFor}, ${assigned.length} crew assigned`}
      style={statusStyle}
      onDragOver={(event) => {
        // Allow drop; default would reject.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        if (!dragHover) onDragHoverChange(true)
      }}
      onDragEnter={(event) => {
        event.preventDefault()
        onDragHoverChange(true)
      }}
      onDragLeave={(event) => {
        // dragleave fires when entering a child too — only react if we left
        // the whole cell.
        if (!cellRef.current?.contains(event.relatedTarget as Node | null)) {
          onDragHoverChange(false)
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDragHoverChange(false)
        const raw = event.dataTransfer.getData('application/x-sitelayer-worker')
        if (raw) {
          try {
            const payload = JSON.parse(raw) as DragPayload
            if (payload.kind === 'worker' && payload.workerId) {
              onAddWorker(payload.workerId)
              return
            }
          } catch {
            /* fall through to pointer state */
          }
        }
        if (pointerDragState.payload?.kind === 'worker') {
          onAddWorker(pointerDragState.payload.workerId)
        }
      }}
      onClick={(event) => {
        // Clicking inside a chip should not open the add popover.
        const target = event.target as HTMLElement
        if (target.closest('[data-role="crew-chip"]')) return
        if (target.closest('[data-role="cell-popover"]')) return
        onOpenPopover(!popoverOpen)
      }}
    >
      {assigned.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 18 }}>
          Drop worker here
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {assigned.map((member) => (
            <CrewChip
              key={member.worker_id}
              member={member}
              serviceItems={serviceItems}
              onRemove={() => onRemoveWorker(member.worker_id)}
            />
          ))}
        </div>
      )}

      {popoverOpen ? (
        <div
          data-role="cell-popover"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 20,
            background: 'rgba(15, 23, 42, 0.98)',
            border: '1px solid rgba(148, 163, 184, 0.4)',
            borderRadius: 8,
            padding: 8,
            marginTop: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <label style={{ fontSize: 12 }} className="muted">
            Add worker
          </label>
          <Select
            aria-label={`Add worker to ${projectName} on ${scheduledFor}`}
            value=""
            onChange={(event) => {
              const value = event.target.value
              if (!value) return
              onAddWorker(value)
              onOpenPopover(false)
            }}
            data-testid={`schedule-cell-add-${cellKey}`}
          >
            <option value="">— choose —</option>
            {unassigned.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.name} · {worker.role}
              </option>
            ))}
          </Select>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenPopover(false)}>
            Close
          </Button>
        </div>
      ) : null}

      {busy ? (
        <span aria-live="polite" className="muted" style={{ fontSize: 11, position: 'absolute', bottom: 4, right: 6 }}>
          saving…
        </span>
      ) : null}
    </div>
  )
}

function CrewChip({
  member,
  serviceItems,
  onRemove,
}: {
  member: CrewMember
  serviceItems: BootstrapResponse['serviceItems']
  onRemove: () => void
}) {
  const code = member.default_service_item_code
  const item = code ? serviceItems.find((entry) => entry.code === code) : null
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-role="crew-chip"
      data-testid={`crew-chip-${member.worker_id}`}
      onClick={onRemove}
      title={`Click to remove ${member.name}`}
      className="h-auto justify-between rounded-full border border-sky-400/60 bg-sky-400/15 px-2 py-1 text-xs font-normal hover:bg-sky-400/25"
    >
      <span>
        <strong>{member.name}</strong>
        <span className="muted" style={{ marginLeft: 6 }}>
          {member.expected_hours}h{item ? ` · ${item.code}` : ''}
        </span>
      </span>
      <span aria-hidden style={{ opacity: 0.7 }}>
        ×
      </span>
    </Button>
  )
}
