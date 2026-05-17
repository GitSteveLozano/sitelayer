import { useEffect, useMemo, useState } from 'react'
import { MobileButton, Sheet } from '@/components/mobile'
import { useProjectMeasurements, type ProjectListRow, type TakeoffMeasurement, type Worker } from '@/lib/api'
import { request } from '@/lib/api/client'
import { useQueryClient } from '@tanstack/react-query'
import { scheduleQueryKeys } from '@/lib/api/schedules'
import { initials } from './helpers'
import { hoursBetween } from './day-view'

export interface CreateAssignmentSheetProps {
  open: boolean
  onClose: () => void
  projects: ProjectListRow[]
  workers: Worker[]
  defaultDate: string
  /** Pre-fill the crew picker (used when opening the sheet from a 4-week grid cell). */
  defaultCrew?: ReadonlyArray<string> | undefined
}

export function CreateAssignmentSheet({
  open,
  onClose,
  projects,
  workers,
  defaultDate,
  defaultCrew,
}: CreateAssignmentSheetProps) {
  const [projectId, setProjectId] = useState<string>('')
  const [scheduledFor, setScheduledFor] = useState(defaultDate)
  const [pickedCrew, setPickedCrew] = useState<Set<string>>(() => new Set(defaultCrew ?? []))
  const [startTime, setStartTime] = useState<string>('')
  const [endTime, setEndTime] = useState<string>('')
  const [takeoffMeasurementId, setTakeoffMeasurementId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const qc = useQueryClient()

  // Re-prime the date + crew defaults each time the sheet opens. The
  // 4-week grid uses the same sheet from any cell, so the defaults
  // need to track the click target — without this, the second open
  // would still show the first cell's defaults.
  useEffect(() => {
    if (!open) return
    setScheduledFor(defaultDate)
    setPickedCrew(new Set(defaultCrew ?? []))
  }, [open, defaultDate, defaultCrew])

  // Scope picker depends on the selected project; the hook is gated
  // off so we don't fire a useless request before a project is chosen.
  const measurements = useProjectMeasurements(projectId || null)
  const measurementOptions = useMemo<TakeoffMeasurement[]>(
    () => measurements.data?.measurements ?? [],
    [measurements.data],
  )

  const reset = () => {
    setProjectId('')
    setPickedCrew(new Set())
    setStartTime('')
    setEndTime('')
    setTakeoffMeasurementId('')
    setError(null)
  }

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
    // Mirror the API's both-or-neither rule for the time range so the
    // user gets a clear inline error instead of a 400 body string.
    if ((startTime && !endTime) || (!startTime && endTime)) {
      setError('Set both start and end time, or leave both blank')
      return
    }
    if (startTime && endTime && hoursBetween(startTime, endTime) == null) {
      setError('End time must be after start time')
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
          start_time: startTime || null,
          end_time: endTime || null,
          takeoff_measurement_id: takeoffMeasurementId || null,
        },
      })
      void qc.invalidateQueries({ queryKey: scheduleQueryKeys.all() })
      reset()
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

  // Project change invalidates the scope selection (a measurement
  // belongs to one project). Without this reset the scope dropdown
  // would briefly point at a stale option from the prior project.
  const onProjectChange = (id: string) => {
    setProjectId(id)
    setTakeoffMeasurementId('')
  }

  const crewHourEstimate = (() => {
    const h = hoursBetween(startTime || null, endTime || null)
    if (h == null) return null
    return h * pickedCrew.size
  })()

  return (
    <Sheet open={open} onClose={onClose} title="New assignment">
      <div className="space-y-4">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
            Project
          </label>
          <select
            value={projectId}
            onChange={(e) => onProjectChange(e.target.value)}
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
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">Date</label>
          <input
            type="date"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            className="w-full p-3 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
              Start
            </label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full p-3 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">End</label>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full p-3 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
            Scope (from measurements)
          </label>
          {!projectId ? (
            <div className="text-[12px] text-ink-3 px-1">Pick a project first.</div>
          ) : measurements.isPending ? (
            <div className="text-[12px] text-ink-3 px-1">Loading measurements…</div>
          ) : measurementOptions.length === 0 ? (
            <div className="text-[12px] text-ink-3 px-1">
              No measurements yet — add one from the project's Measurements tab.
            </div>
          ) : (
            <select
              value={takeoffMeasurementId}
              onChange={(e) => setTakeoffMeasurementId(e.target.value)}
              className="w-full p-3 rounded border border-line-2 bg-card text-[14px] focus:outline-none focus:border-accent"
            >
              <option value="">No scope link</option>
              {measurementOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {formatMeasurementOption(m)}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
            Crew{' '}
            {pickedCrew.size > 0 ? (
              <span className="font-mono tabular-nums normal-case tracking-normal text-ink-2">
                ({pickedCrew.size}
                {crewHourEstimate != null ? ` · ${crewHourEstimate.toFixed(1)} crew-hrs` : ''})
              </span>
            ) : null}
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
                    pickedCrew.has(w.id) ? 'bg-accent-soft border-accent text-ink' : 'bg-card border-line text-ink-2'
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

function formatMeasurementOption(m: TakeoffMeasurement): string {
  const code = m.service_item_code
  const elev = m.elevation?.trim()
  const qty = Number(m.quantity)
  const head = elev ? `${code} — ${elev}` : code
  const qtyLabel = Number.isFinite(qty) && qty > 0 ? ` (${qty.toLocaleString()} ${m.unit})` : ''
  return `${head}${qtyLabel}`
}
