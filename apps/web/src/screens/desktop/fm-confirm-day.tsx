/**
 * Foreman Confirm-Day (Cavy + Steve, WhatsApp 4/5–4/6). Cavy validated the
 * "scheduled crew + daily confirm" model: the schedule pre-populates the
 * expected crew, the foreman just edits hours + service item and removes
 * no-shows, then one "Confirm Day" submits everyone's time. Confirmed entries
 * feed the bonus calc + QBO sync.
 *
 * Anchored on the worker ROSTER (not the loosely-typed crew jsonb): the day's
 * draft schedule (if any) pre-selects who's expected; the foreman confirms.
 * Submitting ensures a schedule row exists for the date, then POSTs
 * /api/schedules/:id/confirm with one labor entry per on-site worker.
 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkers } from '@/lib/api/workers'
import { useServiceItems, type BootstrapResponse } from '@/lib/api'
import { useCreateSchedule, useSchedules, type CrewScheduleRow } from '@/lib/api/schedules'
import { dispatchCrewScheduleEvent, fetchCrewScheduleSnapshot } from '@/lib/api/crew-schedules'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MSelect } from '@/components/m'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// Best-effort worker ids out of the untyped crew jsonb (elements may be a
// string id, { worker_id }, or { id }).
function crewWorkerIds(crew: unknown): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(crew)) {
    for (const c of crew) {
      if (typeof c === 'string') out.add(c)
      else if (c && typeof c === 'object') {
        const rec = c as Record<string, unknown>
        const id = rec.worker_id ?? rec.id
        if (typeof id === 'string') out.add(id)
      }
    }
  }
  return out
}

type Row = { on: boolean; hours: string; code: string }

export function FmConfirmDay({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap])
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [date, setDate] = useState(todayIso())
  const workers = useWorkers()
  const serviceItems = useServiceItems()
  const items = useMemo(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])
  const schedulesQuery = useSchedules({ from: date, to: date })

  const daySchedule: CrewScheduleRow | null = useMemo(() => {
    const all = schedulesQuery.data?.schedules ?? []
    return all.find((s) => s.project_id === projectId && s.scheduled_for === date) ?? null
  }, [schedulesQuery.data, projectId, date])

  const roster = useMemo(() => workers.data?.workers ?? [], [workers.data])
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Gap 7 — create draft through the TanStack mutation (refreshes the
  // schedule + bootstrap caches) and confirm through the headless
  // /events endpoint (which enqueues the same materialize_labor_entries
  // outbox row the legacy /confirm did — so both paths are equivalent).
  const createSchedule = useCreateSchedule()

  // Seed: pre-select the workers on the day's schedule (or none), default 8 hrs
  // and the first service item.
  useEffect(() => {
    const scheduled = crewWorkerIds(daySchedule?.crew)
    const firstCode = items[0]?.code ?? ''
    const seed: Record<string, Row> = {}
    for (const w of roster) {
      seed[w.id] = { on: scheduled.has(w.id), hours: '8', code: firstCode }
    }
    setRows(seed)
    setToast(null)
    setError(null)
  }, [daySchedule, roster, items])

  const selectedCount = Object.values(rows).filter((r) => r.on).length
  const totalHours = Object.values(rows).reduce((s, r) => (r.on ? s + (Number(r.hours) || 0) : s), 0)

  const setRow = (id: string, patch: Partial<Row>) => setRows((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }))

  const confirmDay = async () => {
    if (!projectId) {
      setError('Pick a project first.')
      return
    }
    const entries = roster
      .filter((w) => rows[w.id]?.on)
      .map((w) => ({
        worker_id: w.id,
        service_item_code: rows[w.id]!.code,
        hours: Number(rows[w.id]!.hours) || 0,
        occurred_on: date,
      }))
      .filter((e) => e.service_item_code && e.hours > 0)
    if (entries.length === 0) {
      setError('Mark at least one worker on-site with hours and a service item.')
      return
    }
    setSaving(true)
    setError(null)
    setToast(null)
    try {
      // Ensure a schedule row exists for this project + date to confirm against.
      let scheduleId = daySchedule?.id ?? null
      if (!scheduleId) {
        const created = await createSchedule.mutateAsync({
          project_id: projectId,
          scheduled_for: date,
          crew: entries.map((e) => ({ worker_id: e.worker_id })),
        })
        scheduleId = created.id
      }
      // Headless confirm: read the current snapshot for its state_version,
      // then dispatch CONFIRM through /events carrying the per-worker
      // entries. The labor-entry materialization + project bump are a
      // declared outbox side effect drained by the worker (Gap 1) — no
      // more legacy /confirm call.
      const snapshot = await fetchCrewScheduleSnapshot(scheduleId)
      if (snapshot.state === 'confirmed') {
        setToast('Schedule already confirmed.')
      } else {
        await dispatchCrewScheduleEvent(scheduleId, {
          event: 'CONFIRM',
          state_version: snapshot.state_version,
          entries,
        })
        setToast(`Confirmed ${entries.length} worker${entries.length === 1 ? '' : 's'} · ${totalHours} hrs.`)
      }
      void schedulesQuery.refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: 72,
    textAlign: 'right',
    fontFamily: 'var(--m-num)',
    fontSize: 14,
    padding: '6px 8px',
    border: '2px solid var(--m-ink)',
    background: 'var(--m-paper)',
  }

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Foreman · Time</DEyebrow>
          <DH1>Confirm day</DH1>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <MSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 ? <option value="">No projects</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </MSelect>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
          />
          <span style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>
            {daySchedule
              ? daySchedule.status === 'confirmed'
                ? 'Schedule confirmed — re-confirming updates entries.'
                : 'Crew pre-filled from the schedule.'
              : 'No schedule for this day — confirming creates one.'}
          </span>
        </div>
        {daySchedule?.scope ? (
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', padding: '0 2px' }}>
            <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em' }}>
              SCOPE ·{' '}
            </span>
            {daySchedule.scope}
          </div>
        ) : null}

        <div className="d-card" style={{ display: 'grid', gap: 2 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '28px minmax(0, 1fr) 150px 90px',
              gap: 10,
              padding: '6px 4px',
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            <span>On</span>
            <span>Worker</span>
            <span>Service item</span>
            <span style={{ textAlign: 'right' }}>Hours</span>
          </div>
          {roster.length === 0 ? (
            <div style={{ padding: 12, color: 'var(--m-ink-3)', fontSize: 13 }}>
              {workers.isLoading ? 'Loading crew…' : 'No workers on the roster yet — add crew under Team.'}
            </div>
          ) : null}
          {roster.map((w) => {
            const r = rows[w.id] ?? { on: false, hours: '8', code: items[0]?.code ?? '' }
            return (
              <div
                key={w.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '28px minmax(0, 1fr) 150px 90px',
                  gap: 10,
                  alignItems: 'center',
                  padding: '6px 4px',
                  borderTop: '1px solid var(--m-ink-5, rgba(0,0,0,0.06))',
                  opacity: r.on ? 1 : 0.55,
                }}
              >
                <input
                  type="checkbox"
                  checked={r.on}
                  onChange={(e) => setRow(w.id, { on: e.target.checked })}
                  aria-label={`${w.name} on site`}
                />
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {w.name}
                  <span style={{ color: 'var(--m-ink-3)', fontWeight: 400 }}> · {w.role || 'crew'}</span>
                </span>
                <MSelect value={r.code} onChange={(e) => setRow(w.id, { code: e.target.value })} disabled={!r.on}>
                  {items.length === 0 ? <option value="">—</option> : null}
                  {items.map((it) => (
                    <option key={it.code} value={it.code}>
                      {it.code}
                    </option>
                  ))}
                </MSelect>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={r.hours}
                  onChange={(e) => setRow(w.id, { hours: e.target.value })}
                  disabled={!r.on}
                  style={inputStyle}
                />
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 13, color: error ? 'var(--m-red)' : toast ? 'var(--m-green)' : 'var(--m-ink-3)' }}>
            {error ?? toast ?? `${selectedCount} on site · ${totalHours} hrs total`}
          </span>
          <MButton variant="primary" onClick={() => void confirmDay()} disabled={saving || selectedCount === 0}>
            {saving ? 'Confirming…' : 'Confirm day'}
          </MButton>
        </div>
      </div>
    </div>
  )
}
