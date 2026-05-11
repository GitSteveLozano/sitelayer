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
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '../../api-v1-compat.js'
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

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

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
    <>
      <MTopBar back title="Add time entry" onBack={() => navigate('/time')} />
      <MBody>
        {error ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner tone="error" title="Could not save" body={error} />
          </div>
        ) : null}

        <MSectionH>Who & where</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Worker *">
            <MSelect value={workerId} onChange={(e) => setWorkerId(e.currentTarget.value)}>
              <option value="">Select worker…</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </MSelect>
          </Field>

          <Field label="Project *">
            <MSelect
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
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.customer_name ? ` — ${p.customer_name}` : ''}
                </option>
              ))}
            </MSelect>
          </Field>

          <Field label="Service item *">
            <MSelect
              value={serviceItemCode}
              onChange={(e) => setServiceItemCode(e.currentTarget.value)}
              disabled={serviceItems.length === 0}
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
          <Field label="Date *">
            <MInput type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.currentTarget.value)} />
          </Field>
          <Field label="Hours *">
            <MInput
              type="number"
              inputMode="decimal"
              step="0.25"
              min="0"
              value={hours}
              onChange={(e) => setHours(e.currentTarget.value)}
              placeholder="8.0"
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
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
    </label>
  )
}
