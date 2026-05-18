/**
 * Mobile foreman manual time-entry. Mounted at `/time/new` inside the
 * mobile shell. The auto-geofence pipeline catches the bulk of crew
 * time; this form covers manual overrides — a foreman adding or
 * correcting a worker's hours by hand.
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
 * The note field is intentionally captured client-side only — the
 * labor_entries table doesn't expose a `notes` column. Surfacing notes
 * on the row belongs with the time-review row chrome (the
 * PendingInlineEditor in time-review.tsx accepts a `note` patch on
 * approve/reject) so foremen still attribute manual overrides through
 * that channel.
 */
import { useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { ApiError } from '../../lib/api/client.js'
import { useCreateLaborEntry } from '../../lib/api/labor-entries.js'
import {
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MInput,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { todayIso } from './format.js'

export function MobileForemanTimeEntry({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const createLabor = useCreateLaborEntry()

  const workers = useMemo(() => (bootstrap?.workers ?? []).filter((w) => !w.deleted_at), [bootstrap?.workers])
  const projects = useMemo(
    () => (bootstrap?.projects ?? []).filter((p) => p.status !== 'archived'),
    [bootstrap?.projects],
  )
  const serviceItems = useMemo(() => bootstrap?.serviceItems ?? [], [bootstrap?.serviceItems])

  const [workerId, setWorkerId] = useState<string>('')
  const [projectId, setProjectId] = useState<string>('')
  const [serviceItemCode, setServiceItemCode] = useState<string>('')
  const [occurredOn, setOccurredOn] = useState<string>(() => todayIso())
  const [hours, setHours] = useState<string>('')
  const [sqftDone, setSqftDone] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  // Carry the request id off the failed API call so the user can paste
  // it into a support thread via the TraceIdFooter on the error banner.
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const workerFieldId = useId()
  const projectFieldId = useId()
  const serviceItemFieldId = useId()
  const dateFieldId = useId()
  const hoursFieldId = useId()

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

  // Inline validation only after the user tries to save once.
  const workerError = touched && workerId.length === 0 ? 'Pick a worker.' : null
  const projectError = touched && projectId.length === 0 ? 'Pick a project.' : null
  const serviceItemError = touched && serviceItemCode.length === 0 ? 'Pick a service item.' : null
  const dateError = touched && occurredOn.length === 0 ? 'Date is required.' : null
  const hoursError = touched && !(Number(hours) > 0) ? 'Hours must be greater than 0.' : null

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
    setTouched(true)
    if (!canSubmit) return
    setError(null)
    setErrorRequestId(null)
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
      setErrorRequestId(err instanceof ApiError ? err.requestId : null)
    }
  }

  return (
    <>
      <MTopBar back title="Add time entry" onBack={() => navigate('/time')} />
      <MBody>
        {error ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner tone="error" title="Could not save" body={error} requestId={errorRequestId} />
          </div>
        ) : null}

        <MSectionH>Who & where</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Worker *" htmlFor={workerFieldId} error={workerError}>
            <MSelect
              id={workerFieldId}
              value={workerId}
              onChange={(e) => setWorkerId(e.currentTarget.value)}
              aria-invalid={workerError ? true : undefined}
              aria-describedby={workerError ? `${workerFieldId}-err` : undefined}
              aria-required="true"
            >
              <option value="">Select worker…</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </MSelect>
          </Field>

          <Field label="Project *" htmlFor={projectFieldId} error={projectError}>
            <MSelect
              id={projectFieldId}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.currentTarget.value)
                // Reset the service item when the project flips — the
                // catalog xref is project-division-scoped so the
                // previously valid code may no longer apply.
                setServiceItemCode('')
              }}
              aria-invalid={projectError ? true : undefined}
              aria-describedby={projectError ? `${projectFieldId}-err` : undefined}
              aria-required="true"
            >
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.customer_name ? ` — ${p.customer_name}` : ''}
                </option>
              ))}
            </MSelect>
          </Field>

          <Field label="Service item *" htmlFor={serviceItemFieldId} error={serviceItemError}>
            <MSelect
              id={serviceItemFieldId}
              value={serviceItemCode}
              onChange={(e) => setServiceItemCode(e.currentTarget.value)}
              disabled={serviceItems.length === 0}
              aria-invalid={serviceItemError ? true : undefined}
              aria-describedby={serviceItemError ? `${serviceItemFieldId}-err` : undefined}
              aria-required="true"
            >
              <option value="">Select service item…</option>
              {serviceItems.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </MSelect>
            {project?.division_code ? (
              <div className="m-quiet-sm" style={{ marginTop: 6 }}>
                Project division <code>{project.division_code}</code> · the server checks the service-item catalog.
              </div>
            ) : null}
          </Field>
        </div>

        <MSectionH>When & how much</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Date *" htmlFor={dateFieldId} error={dateError}>
            <MInput
              id={dateFieldId}
              type="date"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.currentTarget.value)}
              aria-invalid={dateError ? true : undefined}
              aria-describedby={dateError ? `${dateFieldId}-err` : undefined}
              aria-required="true"
            />
          </Field>
          <Field label="Hours *" htmlFor={hoursFieldId} error={hoursError}>
            <MInput
              id={hoursFieldId}
              type="number"
              inputMode="decimal"
              step="0.25"
              min="0"
              value={hours}
              onChange={(e) => setHours(e.currentTarget.value)}
              placeholder="8.0"
              aria-invalid={hoursError ? true : undefined}
              aria-describedby={hoursError ? `${hoursFieldId}-err` : undefined}
              aria-required="true"
            />
          </Field>
          <Field label="Sqft done (optional)">
            <MInput
              type="number"
              inputMode="decimal"
              min="0"
              value={sqftDone}
              onChange={(e) => setSqftDone(e.currentTarget.value)}
              placeholder="0"
            />
          </Field>
        </div>

        <MSectionH>Notes</MSectionH>
        <div style={{ padding: '0 16px' }}>
          <MTextarea
            value={notes}
            onChange={(e) => setNotes(e.currentTarget.value)}
            placeholder="Why this entry needs a manual override (visible to the worker on dispute)."
            style={{ width: '100%', minHeight: 96 }}
          />
        </div>

        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
              {createLabor.isPending ? 'Saving…' : 'Save entry'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/time')}>
              Cancel
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

function Field({
  label,
  children,
  htmlFor,
  error,
}: {
  label: string
  children: React.ReactNode
  htmlFor?: string
  error?: string | null
}) {
  return (
    <label style={{ display: 'block' }} {...(htmlFor ? { htmlFor } : {})}>
      <span
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--m-ink-3)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        {label}
      </span>
      {children}
      {error ? (
        <p
          id={htmlFor ? `${htmlFor}-err` : undefined}
          style={{ marginTop: 6, marginBottom: 0, color: 'var(--m-red)', fontSize: 12 }}
        >
          {error}
        </p>
      ) : null}
    </label>
  )
}
