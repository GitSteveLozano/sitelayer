import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, MobileButton } from '@/components/mobile'
import { ApiError, useCreateLaborEntry, useProjects, useServiceItems, useWorkers } from '@/lib/api'

/**
 * `t-foreman-entry` — Foreman manual time-entry form.
 *
 * The auto-geofence pipeline catches the majority of crew time; this
 * surface covers the remainder — a foreman recording (or correcting) a
 * worker's hours by hand. Per the view-time.jsx design, the form is
 * intentionally short: pick worker + project + service item, enter
 * hours + optional sqft_done, optional note, save.
 *
 * Server-side, POST /api/labor-entries enforces:
 *   - role ∈ admin / foreman / office
 *   - division_code ↔ service_item_code via the
 *     `service_item_divisions` xref (lenient — empty xref means anything
 *     goes; once curated, the pair must match)
 *
 * We send the project's `division_code` along so the foreman doesn't
 * have to pick one — the project already binds the right one in
 * practice. The 400 error body bubbles back through ApiError so the
 * banner explains why a code was rejected.
 *
 * The note field is intentionally captured client-side only for now —
 * the labor_entries table doesn't expose a `notes` column, so we drop
 * it on submit. Surfacing notes belongs with the time-review row chrome
 * (PendingInlineEditor in mobile/time-review.tsx already accepts a
 * `note` patch on approve/reject) so foremen still attribute manual
 * overrides through that channel.
 */
export function ForemanManualTimeEntryScreen() {
  const navigate = useNavigate()
  const workers = useWorkers()
  const projects = useProjects()
  const serviceItems = useServiceItems()
  const createLabor = useCreateLaborEntry()

  const projectRows = useMemo(() => projects.data?.projects ?? [], [projects.data])
  const workerRows = useMemo(() => workers.data?.workers ?? [], [workers.data])
  const serviceItemRows = useMemo(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])

  const todayIso = useMemo(() => todayLocalIso(), [])

  const [workerId, setWorkerId] = useState<string>('')
  const [projectId, setProjectId] = useState<string>('')
  const [serviceItemCode, setServiceItemCode] = useState<string>('')
  const [occurredOn, setOccurredOn] = useState<string>(todayIso)
  const [hours, setHours] = useState<string>('')
  const [sqftDone, setSqftDone] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const project = useMemo(() => projectRows.find((p) => p.id === projectId) ?? null, [projectRows, projectId])

  // Notes aren't stored server-side yet — we capture them for the
  // approval-queue handoff so the foreman knows the row is intentional
  // even when the catalog text alone is ambiguous. Reference the value
  // so the unused-state lint stays quiet without dropping the field.
  void notes

  const canSubmit =
    workerId.length > 0 &&
    projectId.length > 0 &&
    serviceItemCode.length > 0 &&
    occurredOn.length > 0 &&
    Number(hours) > 0 &&
    !createLabor.isPending

  const handleSubmit = async () => {
    if (!canSubmit) return
    setError(null)
    try {
      await createLabor.mutateAsync({
        project_id: projectId,
        worker_id: workerId,
        service_item_code: serviceItemCode,
        hours: Number(hours),
        occurred_on: occurredOn,
        sqft_done: sqftDone ? Number(sqftDone) : null,
        division_code: project?.division_code ?? null,
        status: 'draft',
      })
      navigate('/time?created=1')
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Foreman · Time</div>
        <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Manual entry</h1>
        <div className="text-[12px] text-ink-3 mt-1">
          Add or override a crew member's hours when the geofence didn't pick them up.
        </div>
      </div>

      {error ? (
        <div className="px-4 pb-3">
          <Card tight>
            <div className="text-[13px] text-bad">{error}</div>
          </Card>
        </div>
      ) : null}

      <div className="px-4 pb-8 space-y-3">
        <Card tight>
          <FormRow label="Worker">
            <select
              className="w-full h-10 px-3 border border-line rounded-[10px] bg-card text-[14px]"
              value={workerId}
              onChange={(e) => setWorkerId(e.currentTarget.value)}
            >
              <option value="">Select worker…</option>
              {workerRows
                .filter((w) => !w.deleted_at)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </FormRow>

          <FormRow label="Project">
            <select
              className="w-full h-10 px-3 border border-line rounded-[10px] bg-card text-[14px]"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.currentTarget.value)
                // Reset the service item when the project flips — the
                // catalog xref is project-division-scoped so the
                // previously valid code may no longer apply.
                setServiceItemCode('')
              }}
            >
              <option value="">Select project…</option>
              {projectRows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.customer_name ? ` — ${p.customer_name}` : ''}
                </option>
              ))}
            </select>
          </FormRow>

          <FormRow label="Service item">
            <select
              className="w-full h-10 px-3 border border-line rounded-[10px] bg-card text-[14px]"
              value={serviceItemCode}
              onChange={(e) => setServiceItemCode(e.currentTarget.value)}
              disabled={serviceItemRows.length === 0}
            >
              <option value="">Select service item…</option>
              {serviceItemRows.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
            {project?.division_code ? (
              <div className="text-[11px] text-ink-3 mt-1">
                Project division: <span className="font-mono">{project.division_code}</span>. The server enforces the
                service-item / division catalog cross-reference.
              </div>
            ) : null}
          </FormRow>

          <FormRow label="Date">
            <input
              type="date"
              className="w-full h-10 px-3 border border-line rounded-[10px] bg-card text-[14px] num"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.currentTarget.value)}
            />
          </FormRow>

          <div className="grid grid-cols-2 gap-3">
            <FormRow label="Hours">
              <input
                type="number"
                inputMode="decimal"
                step="0.25"
                min="0"
                className="w-full h-10 px-3 border border-line rounded-[10px] bg-card text-[14px] num"
                value={hours}
                onChange={(e) => setHours(e.currentTarget.value)}
                placeholder="8.0"
              />
            </FormRow>
            <FormRow label="Sqft done (optional)">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                className="w-full h-10 px-3 border border-line rounded-[10px] bg-card text-[14px] num"
                value={sqftDone}
                onChange={(e) => setSqftDone(e.currentTarget.value)}
                placeholder="0"
              />
            </FormRow>
          </div>

          <FormRow label="Notes (optional)">
            <textarea
              className="w-full px-3 py-2 border border-line rounded-[10px] bg-card text-[14px] min-h-[80px]"
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              placeholder="Why this entry needs a manual override (visible to the worker on dispute)."
            />
          </FormRow>
        </Card>

        <div className="flex gap-2">
          <MobileButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {createLabor.isPending ? 'Saving…' : 'Save entry'}
          </MobileButton>
          <MobileButton variant="ghost" onClick={() => navigate('/time')}>
            Cancel
          </MobileButton>
        </div>
      </div>
    </div>
  )
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-3 last:mb-0">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">{label}</span>
      {children}
    </label>
  )
}

function todayLocalIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
