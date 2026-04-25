import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiPost } from '../api.js'
import type { BootstrapResponse, ScheduleRow, WorkerRow } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import { Checkbox } from '../components/ui/checkbox.js'
import { toastError, toastSuccess } from '../components/ui/toast.js'

type ConfirmViewProps = {
  bootstrap: BootstrapResponse | null
  schedules: ScheduleRow[]
  workers: WorkerRow[]
  serviceItems: BootstrapResponse['serviceItems']
  companySlug: string
  onConfirmed?: () => Promise<void> | void
}

type CrewEntryDraft = {
  key: string
  worker_id: string | null
  name: string
  service_item_code: string
  hours: string
  sqft_done: string
  showUp: boolean
}

type ScheduleDraft = {
  scheduleId: string
  projectId: string
  projectName: string
  customerName: string
  status: string
  version: number
  entries: CrewEntryDraft[]
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function isTodayString(date: string): boolean {
  return date === today()
}

type CrewEntryRaw = {
  worker_id?: string | null
  name?: string | null
  expected_hours?: number | string | null
  default_service_item_code?: string | null
  service_item_code?: string | null
}

// Graceful parser: accepts [{worker_id, name, expected_hours, default_service_item_code?}]
// but also tolerates flat string arrays (legacy fixture shape) and anything in between.
function coerceCrew(crew: unknown, workers: WorkerRow[]): Array<CrewEntryRaw> {
  if (!Array.isArray(crew)) return []
  return crew.map((entry) => {
    if (typeof entry === 'string') {
      const matched = workers.find((worker) => worker.name === entry)
      return { worker_id: matched?.id ?? null, name: entry }
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      return {
        worker_id: typeof record.worker_id === 'string' ? record.worker_id : null,
        name: typeof record.name === 'string' ? record.name : null,
        expected_hours:
          typeof record.expected_hours === 'number' || typeof record.expected_hours === 'string'
            ? (record.expected_hours as number | string)
            : null,
        default_service_item_code:
          typeof record.default_service_item_code === 'string' ? record.default_service_item_code : null,
        service_item_code: typeof record.service_item_code === 'string' ? record.service_item_code : null,
      }
    }
    return { worker_id: null, name: null }
  })
}

function buildInitialDraft(
  schedule: ScheduleRow,
  projects: BootstrapResponse['projects'],
  workers: WorkerRow[],
  serviceItems: BootstrapResponse['serviceItems'],
): ScheduleDraft {
  const project = projects.find((entry) => entry.id === schedule.project_id)
  const defaultCode = serviceItems[0]?.code ?? ''
  const crewRaw = coerceCrew(schedule.crew, workers)
  const entries: CrewEntryDraft[] = crewRaw.map((raw, index) => ({
    key: `${schedule.id}-${index}`,
    worker_id: raw.worker_id ?? null,
    name:
      raw.name ??
      (raw.worker_id ? (workers.find((worker) => worker.id === raw.worker_id)?.name ?? 'Worker') : 'Crew member'),
    service_item_code: raw.service_item_code ?? raw.default_service_item_code ?? defaultCode,
    hours: raw.expected_hours != null ? String(raw.expected_hours) : '8',
    sqft_done: '0',
    showUp: true,
  }))

  return {
    scheduleId: schedule.id,
    projectId: schedule.project_id,
    projectName: project?.name ?? 'Project',
    customerName: project?.customer_name ?? '',
    status: schedule.status,
    version: schedule.version,
    entries,
  }
}

export function ConfirmView({
  bootstrap,
  schedules,
  workers,
  serviceItems,
  companySlug,
  onConfirmed,
}: ConfirmViewProps) {
  const todaySchedules = useMemo(
    () => schedules.filter((schedule) => isTodayString(schedule.scheduled_for) && !schedule.deleted_at),
    [schedules],
  )

  const [drafts, setDrafts] = useState<ScheduleDraft[]>([])
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    if (!bootstrap) {
      setDrafts([])
      return
    }
    setDrafts(todaySchedules.map((schedule) => buildInitialDraft(schedule, bootstrap.projects, workers, serviceItems)))
  }, [bootstrap, serviceItems, todaySchedules, workers])

  function updateEntry(scheduleId: string, entryKey: string, patch: Partial<CrewEntryDraft>) {
    setDrafts((current) =>
      current.map((draft) =>
        draft.scheduleId === scheduleId
          ? {
              ...draft,
              entries: draft.entries.map((entry) => (entry.key === entryKey ? { ...entry, ...patch } : entry)),
            }
          : draft,
      ),
    )
  }

  function addEntry(scheduleId: string) {
    const defaultCode = serviceItems[0]?.code ?? ''
    setDrafts((current) =>
      current.map((draft) =>
        draft.scheduleId === scheduleId
          ? {
              ...draft,
              entries: [
                ...draft.entries,
                {
                  key: `${scheduleId}-extra-${Date.now()}`,
                  worker_id: null,
                  name: 'Additional crew',
                  service_item_code: defaultCode,
                  hours: '8',
                  sqft_done: '0',
                  showUp: true,
                },
              ],
            }
          : draft,
      ),
    )
  }

  function removeEntry(scheduleId: string, entryKey: string) {
    setDrafts((current) =>
      current.map((draft) =>
        draft.scheduleId === scheduleId
          ? { ...draft, entries: draft.entries.filter((entry) => entry.key !== entryKey) }
          : draft,
      ),
    )
  }

  async function confirmAll() {
    if (!drafts.length) return
    const occurredOn = today()
    let completed = 0
    setProgress({ done: 0, total: drafts.length })
    let hadError = false
    for (const draft of drafts) {
      setSubmittingId(draft.scheduleId)
      const entries = draft.entries
        .filter((entry) => entry.showUp && entry.service_item_code)
        .map((entry) => ({
          worker_id: entry.worker_id,
          service_item_code: entry.service_item_code,
          hours: Number(entry.hours) || 0,
          sqft_done: Number(entry.sqft_done) || 0,
          occurred_on: occurredOn,
        }))
      try {
        await apiPost(
          `/api/schedules/${draft.scheduleId}/confirm`,
          { entries, expected_version: draft.version },
          companySlug,
        )
      } catch (caught: unknown) {
        hadError = true
        toastError(
          `Failed to confirm ${draft.projectName}`,
          caught instanceof Error ? caught.message : 'unknown error',
        )
      }
      completed += 1
      setProgress({ done: completed, total: drafts.length })
    }
    setSubmittingId(null)
    setProgress(null)
    if (!hadError) {
      toastSuccess('Day confirmed', `Submitted ${drafts.length} schedule${drafts.length === 1 ? '' : 's'}.`)
      try {
        window.localStorage.setItem('sitelayer.lastConfirmedDay', occurredOn)
      } catch {
        /* localStorage may be unavailable in some contexts */
      }
      window.dispatchEvent(new Event('sitelayer:day-confirmed'))
    }
    if (onConfirmed) {
      await onConfirmed()
    }
  }

  if (!drafts.length) {
    return (
      <section className="panel" data-testid="confirm-empty">
        <h2>Confirm Day</h2>
        <p className="muted">No crews scheduled for today.</p>
        <p>
          <Link to="/takeoffs">Create a schedule →</Link>
        </p>
      </section>
    )
  }

  const busy = submittingId !== null
  const confirmButtonLabel = progress
    ? `Submitting ${progress.done}/${progress.total}…`
    : `Confirm Day (${drafts.length} schedule${drafts.length === 1 ? '' : 's'})`

  return (
    <section className="panel" data-testid="confirm-view">
      <h2>Confirm Day · {today()}</h2>
      <p className="muted">
        Review today&apos;s crews across all active schedules. Adjust hours or add crew members, then submit once.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {drafts.map((draft) => (
          <article
            key={draft.scheduleId}
            className="panel"
            style={{ border: '1px solid rgba(148, 163, 184, 0.3)', padding: 12 }}
            data-testid={`confirm-schedule-${draft.scheduleId}`}
          >
            <header style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <strong>{draft.projectName}</strong>
                <div className="muted">{draft.customerName}</div>
              </div>
              <span className="muted">
                {draft.entries.length} crew · status {draft.status}
              </span>
            </header>

            <ul
              className="list compact"
              style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {draft.entries.map((entry) => (
                <li
                  key={entry.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(140px, 1fr) minmax(140px, 1fr) 90px 90px auto auto',
                    gap: 8,
                    alignItems: 'center',
                  }}
                  className="confirmRow"
                >
                  <div>
                    <strong>{entry.name}</strong>
                    {entry.worker_id ? <div className="muted">{entry.worker_id}</div> : null}
                  </div>
                  <Select
                    aria-label={`Service item for ${entry.name}`}
                    value={entry.service_item_code}
                    onChange={(event) =>
                      updateEntry(draft.scheduleId, entry.key, { service_item_code: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') event.currentTarget.blur()
                    }}
                  >
                    <option value="">— service —</option>
                    {serviceItems.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.code} · {item.name}
                      </option>
                    ))}
                  </Select>
                  <Input
                    aria-label={`Hours for ${entry.name}`}
                    type="number"
                    step="0.25"
                    min="0"
                    value={entry.hours}
                    onChange={(event) => updateEntry(draft.scheduleId, entry.key, { hours: event.target.value })}
                  />
                  <Input
                    aria-label={`Sqft done for ${entry.name}`}
                    type="number"
                    step="1"
                    min="0"
                    value={entry.sqft_done}
                    onChange={(event) =>
                      updateEntry(draft.scheduleId, entry.key, { sqft_done: event.target.value })
                    }
                  />
                  <label
                    className="checkbox"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                  >
                    <Checkbox
                      checked={entry.showUp}
                      onChange={(event) => updateEntry(draft.scheduleId, entry.key, { showUp: event.target.checked })}
                    />
                    <span>Show up</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeEntry(draft.scheduleId, entry.key)}
                    aria-label={`Remove ${entry.name}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>

            <div style={{ marginTop: 8 }}>
              <Button type="button" variant="link" size="sm" onClick={() => addEntry(draft.scheduleId)}>
                + Add another crew member
              </Button>
            </div>
          </article>
        ))}
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button type="button" onClick={() => void confirmAll()} disabled={busy} data-testid="confirm-day-submit">
          {confirmButtonLabel}
        </Button>
        {progress ? (
          <span className="muted" aria-live="polite">
            Submitting schedule {progress.done} of {progress.total}
          </span>
        ) : null}
      </div>
    </section>
  )
}
