/**
 * Mobile foreman Confirm-Day (Cavy + Steve, WhatsApp 4/5–4/6) — the phone-first
 * surface of the desktop `FmConfirmDay` (screens/desktop/fm-confirm-day.tsx).
 * Foremen are phone-first, so the schedule → one-tap "Confirm day" flow lives
 * on the mobile Time tab too, not only on desktop.
 *
 * Same model + write path as the desktop screen: anchored on the worker ROSTER,
 * the day's draft schedule (if any) pre-selects who's expected; the foreman
 * edits hours + service item, removes no-shows, and one "Confirm day" submits.
 * Submitting ensures a schedule row exists for the date, then dispatches CONFIRM
 * through the crew-schedule workflow /events endpoint (which enqueues the same
 * materialize_labor_entries outbox the legacy /confirm did). Distinct from the
 * weekly time-REVIEW surface (time-review.tsx), which approves clock-ins that
 * already exist; Confirm-Day CREATES the day's entries from the schedule.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkers } from '@/lib/api/workers'
import { useServiceItems, type BootstrapResponse } from '@/lib/api'
import { useCreateSchedule, useSchedules, type CrewScheduleRow } from '@/lib/api/schedules'
import { dispatchCrewScheduleEvent, fetchCrewScheduleSnapshot } from '@/lib/api/crew-schedules'
import { MBanner, MBody, MButton, MInput, MListRow, MSectionH, MSelect, MTopBar } from '@/components/m'

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

export function MobileFmConfirmDay({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
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
      // Headless confirm: read the current snapshot for its state_version, then
      // dispatch CONFIRM through /events carrying the per-worker entries.
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

  const numInputStyle: React.CSSProperties = { width: 64, textAlign: 'right' }

  return (
    <>
      <MTopBar title="Confirm day" sub={`Foreman · ${selectedCount} on site · ${totalHours} hrs`} />
      <MBody>
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <MSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 ? <option value="">No projects</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </MSelect>
          <MInput type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} />
          <span style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>
            {daySchedule
              ? daySchedule.status === 'confirmed'
                ? 'Schedule confirmed — re-confirming updates entries.'
                : 'Crew pre-filled from the schedule.'
              : 'No schedule for this day — confirming creates one.'}
          </span>
          {daySchedule?.scope ? (
            <div style={{ fontSize: 13, color: 'var(--m-ink-2)' }}>
              <span className="m-kpi-eyebrow">Scope · </span>
              {daySchedule.scope}
            </div>
          ) : null}
        </div>

        {error ? (
          <div style={{ padding: '0 16px 8px' }}>
            <MBanner tone="error" title="Couldn't confirm" body={error} />
          </div>
        ) : toast ? (
          <div style={{ padding: '0 16px 8px' }}>
            <MBanner tone="ok" title="Day confirmed" body={toast} />
          </div>
        ) : null}

        <MSectionH>Crew</MSectionH>
        {roster.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--m-ink-3)', fontSize: 13 }}>
            {workers.isLoading ? 'Loading crew…' : 'No workers on the roster yet — add crew under Team.'}
          </div>
        ) : (
          roster.map((w) => {
            const r = rows[w.id] ?? { on: false, hours: '8', code: items[0]?.code ?? '' }
            return (
              <div key={w.id} style={{ opacity: r.on ? 1 : 0.55 }}>
                <MListRow
                  leading={
                    <input
                      type="checkbox"
                      checked={r.on}
                      onChange={(e) => setRow(w.id, { on: e.target.checked })}
                      aria-label={`${w.name} on site`}
                    />
                  }
                  headline={w.name}
                  supporting={w.role || 'crew'}
                  trailing={
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <MSelect value={r.code} onChange={(e) => setRow(w.id, { code: e.target.value })} disabled={!r.on}>
                        {items.length === 0 ? <option value="">—</option> : null}
                        {items.map((it) => (
                          <option key={it.code} value={it.code}>
                            {it.code}
                          </option>
                        ))}
                      </MSelect>
                      <MInput
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.5"
                        value={r.hours}
                        onChange={(e) => setRow(w.id, { hours: e.currentTarget.value })}
                        disabled={!r.on}
                        style={numInputStyle}
                      />
                    </span>
                  }
                />
              </div>
            )
          })
        )}

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <MButton variant="primary" onClick={() => void confirmDay()} disabled={saving || selectedCount === 0}>
            {saving ? 'Confirming…' : `Confirm day · ${selectedCount}`}
          </MButton>
          <MButton variant="ghost" onClick={() => navigate('/time')}>
            Back to time review
          </MButton>
        </div>
      </MBody>
    </>
  )
}
