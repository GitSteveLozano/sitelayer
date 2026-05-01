import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution, AgentSurface, Spark } from '@/components/ai'
import {
  ApiError,
  dailyLogPhotoUrl,
  useCreateDailyLog,
  useDailyLogs,
  useDeleteDailyLogPhoto,
  usePatchDailyLog,
  useSubmitDailyLog,
  useUploadDailyLogPhoto,
  type DailyLog,
} from '@/lib/api'

/**
 * `fm-log` — Daily log composer.
 *
 * Real wiring (1D.3 + 1E.4):
 *   - Looks up today's draft for the current foreman + project (or
 *     creates one). Auto-saves notes via PATCH after a short debounce.
 *   - Photo upload via POST /api/daily-logs/:id/photos (multipart);
 *     thumbnails render straight from GET /photos/file?key=… which
 *     either streams bytes or 302s to a presigned Spaces URL.
 *   - Per-photo delete via DELETE /api/daily-logs/:id/photos.
 *   - Submit button → POST /api/daily-logs/:id/submit (status →
 *     'submitted', server stamps submitted_at).
 *
 * Placeholders (Phase 5):
 *   - The AI-drafted narrative shown as a `<AgentSurface>` placeholder
 *     is the Phase 5 takeoff-to-bid agent's sibling: drafts the day's
 *     narrative from photos + clock-in data + voice memos.
 *   - Weather card needs geocoded weather via OpenWeather (Phase 5).
 *   - Issues use the wk-issue ping path; aggregation comes in Phase 2
 *     when the dashboard surfaces them.
 *
 * The screen takes a project_id prop because daily logs are
 * (project, day, foreman)-scoped. The Foreman home will pick the
 * project the foreman is currently on; for now the screen accepts a
 * fallback hint via prop and renders a "no project active" empty state
 * when none is supplied.
 */
export interface ForemanDailyLogProps {
  projectId: string | null
}

export function ForemanDailyLogScreen({ projectId }: ForemanDailyLogProps) {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // Pull today's logs filtered to this foreman (server already filters
  // by foreman_user_id when the role is 'foreman' — daily-logs.ts).
  // We just need the row whose project_id matches.
  const list = useDailyLogs(
    projectId ? { from: todayIso, to: todayIso, projectId } : { from: todayIso, to: todayIso },
    { enabled: Boolean(projectId) },
  )
  const existing = list.data?.dailyLogs.find((d) => d.project_id === projectId && d.occurred_on === todayIso) ?? null

  const create = useCreateDailyLog()
  const log = existing
  const ready = list.isFetched

  // Bootstrap a draft if one doesn't exist yet.
  useEffect(() => {
    if (!projectId || !ready || existing || create.isPending) return
    void create.mutateAsync({ project_id: projectId, occurred_on: todayIso }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ready, existing])

  if (!projectId) {
    return <NoProjectState />
  }
  if (!log) {
    return <PreparingDraftState />
  }
  return <DailyLogEditor log={log} />
}

function NoProjectState() {
  return (
    <div className="px-5 pt-10 max-w-lg">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Foreman · Daily log</div>
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">No project today</h1>
      <p className="text-[14px] text-ink-2 mt-2">
        Daily logs are tied to the project you're working on. Clock in at a project to start one.
      </p>
    </div>
  )
}

function PreparingDraftState() {
  return (
    <div className="px-5 pt-10">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Foreman · Daily log</div>
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Preparing draft…</h1>
    </div>
  )
}

interface DailyLogEditorProps {
  log: DailyLog
}

function DailyLogEditor({ log }: DailyLogEditorProps) {
  const patch = usePatchDailyLog(log.id)
  const submit = useSubmitDailyLog(log.id)

  const [notes, setNotes] = useState(log.notes ?? '')
  const dirtyRef = useRef(false)
  const versionRef = useRef(log.version)

  // Re-sync local state when the server version changes (e.g. after submit).
  useEffect(() => {
    if (!dirtyRef.current) {
      setNotes(log.notes ?? '')
    }
    versionRef.current = log.version
  }, [log.notes, log.version])

  // Debounced auto-save while editing notes.
  useEffect(() => {
    if (log.status !== 'draft') return
    if (notes === (log.notes ?? '')) return
    dirtyRef.current = true
    const id = window.setTimeout(() => {
      void patch
        .mutateAsync({ notes, expected_version: versionRef.current })
        .then(() => {
          dirtyRef.current = false
        })
        .catch(() => {
          // Surface in toast in Phase 1D.4. For now leave the textarea
          // dirty so the next debounce retries.
        })
    }, 1200)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes])

  const isSubmitted = log.status === 'submitted'

  const onSubmit = async () => {
    // Flush pending notes before submitting so we don't lose the last
    // typed phrase if the debounce hasn't fired yet.
    if (dirtyRef.current) {
      await patch.mutateAsync({ notes, expected_version: versionRef.current }).catch(() => {})
    }
    await submit.mutateAsync({ expected_version: versionRef.current }).catch(() => {})
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Daily log</div>
        <h1 className="mt-1 font-display text-[26px] font-bold tracking-tight leading-tight">
          {formatLogDate(log.occurred_on)}
        </h1>
        <div className="mt-1 flex items-center gap-2">
          <Pill tone={isSubmitted ? 'good' : 'default'} withDot>
            {isSubmitted ? 'submitted' : 'draft'}
          </Pill>
          {log.submitted_at ? (
            <span className="text-[11px] text-ink-3">at {formatTime(log.submitted_at)}</span>
          ) : (
            <span className="text-[11px] text-ink-3">{patch.isPending ? 'saving…' : 'auto-saves'}</span>
          )}
        </div>
      </div>

      {/* Status strip — counts pulled from log fields where they exist. */}
      <div className="px-4 pt-2">
        <div className="grid grid-cols-3 gap-2.5">
          <StatTile label="Photos" value={log.photo_keys.length.toString()} />
          <StatTile
            label="Hours"
            value="—"
            note="from clock"
          />
          <StatTile
            label="Issues"
            value={Array.isArray(log.schedule_deviations) ? log.schedule_deviations.length.toString() : '0'}
            tone="warn"
          />
        </div>
      </div>

      {/* Weather placeholder. */}
      <div className="px-4 mt-3">
        <Card tight className="!flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-accent-soft flex items-center justify-center text-accent">
            <Spark state="muted" size={16} aria-label="" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold">Weather attaches in Phase 5</div>
            <div className="text-[11px] text-ink-3">Auto-fetched from project zip code at submit time.</div>
          </div>
        </Card>
      </div>

      {/* Photo grid — real upload + render. */}
      <PhotoGrid log={log} />


      {/* Notes — real, debounced auto-save. */}
      <div className="px-4 mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">Notes</div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What happened today? Any deviations from plan?"
          rows={6}
          disabled={isSubmitted}
          className="w-full p-3 text-[14px] rounded border border-line-2 bg-card focus:outline-none focus:border-accent resize-none disabled:bg-card-soft disabled:text-ink-3"
        />
      </div>

      {/* AI-drafted narrative slot — placeholder until Phase 5. */}
      <div className="px-4 mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">
          Narrative
        </div>
        <AgentSurface>
          <div className="text-[13px] text-ink-2 leading-relaxed">
            The Phase 5 agent will draft this section from photos, voice memos, and clock-in data — you
            edit before submitting.
          </div>
          <div className="mt-2.5 pt-2.5 border-t border-dashed border-line-2 flex items-center justify-between gap-2">
            <Attribution source="Drafts from photos + voice memos + clock-in data" />
            <span className="text-[11px] text-ink-3">Phase 5</span>
          </div>
        </AgentSurface>
      </div>

      {/* Submit. */}
      <div className="px-4 mt-6 pb-8 space-y-2">
        {!isSubmitted ? (
          <MobileButton variant="primary" onClick={onSubmit} disabled={submit.isPending}>
            {submit.isPending ? 'Submitting…' : 'Submit log'}
          </MobileButton>
        ) : (
          <Card tight>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">Submitted</div>
                <div className="text-[11px] text-ink-3">
                  Locked at {log.submitted_at ? formatTime(log.submitted_at) : '—'}
                </div>
              </div>
              <Pill tone="good">v{log.version}</Pill>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}

interface StatTileProps {
  label: string
  value: string
  note?: string
  tone?: 'default' | 'warn'
}

function StatTile({ label, value, note, tone }: StatTileProps) {
  return (
    <Card tight>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className={`num text-[20px] font-semibold mt-1 ${tone === 'warn' ? 'text-warn' : ''}`}>{value}</div>
      {note ? <div className="text-[11px] text-ink-3 mt-0.5">{note}</div> : null}
    </Card>
  )
}

function formatLogDate(occurredOn: string): string {
  const d = new Date(occurredOn + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

interface PhotoGridProps {
  log: DailyLog
}

function PhotoGrid({ log }: PhotoGridProps) {
  const upload = useUploadDailyLogPhoto(log.id)
  const remove = useDeleteDailyLogPhoto(log.id)
  const isSubmitted = log.status === 'submitted'
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null)
    const files = Array.from(event.target.files ?? [])
    // Reset the input so the same file can be re-picked after a delete.
    event.target.value = ''
    if (files.length === 0) return
    void uploadAll(files)
  }

  const uploadAll = async (files: File[]) => {
    for (const file of files) {
      try {
        await upload.mutateAsync(file)
      } catch (err) {
        setError(err instanceof ApiError ? err.message_for_user() : `Upload failed: ${file.name}`)
        // Stop on first error so the user sees what happened.
        break
      }
    }
  }

  const onDelete = async (key: string) => {
    setError(null)
    setPendingDelete(key)
    try {
      await remove.mutateAsync(key)
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : 'Delete failed')
    } finally {
      setPendingDelete(null)
    }
  }

  return (
    <div className="px-4 mt-4">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          Photos {log.photo_keys.length > 0 ? `(${log.photo_keys.length})` : ''}
        </span>
        {!isSubmitted ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-[12px] text-accent font-medium"
            disabled={upload.isPending}
          >
            {upload.isPending ? 'Uploading…' : '+ Add'}
          </button>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple
        capture="environment"
        onChange={onPickFiles}
        className="hidden"
      />

      <div className="grid grid-cols-3 gap-1.5">
        {log.photo_keys.length === 0 ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="aspect-square rounded-md bg-card-soft border border-dashed border-line flex items-center justify-center text-[11px] text-ink-3"
            >
              —
            </div>
          ))
        ) : (
          log.photo_keys.map((key) => (
            <div key={key} className="relative aspect-square rounded-md overflow-hidden bg-card-soft">
              <img
                src={dailyLogPhotoUrl(log.id, key)}
                alt="daily log"
                className="w-full h-full object-cover"
                loading="lazy"
              />
              {!isSubmitted ? (
                <button
                  type="button"
                  onClick={() => void onDelete(key)}
                  disabled={pendingDelete === key}
                  aria-label="Remove photo"
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/55 text-white text-[12px] font-semibold flex items-center justify-center disabled:opacity-50"
                >
                  ×
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>

      {error ? <div className="mt-2 px-1 text-[12px] text-bad">{error}</div> : null}
      {!isSubmitted && log.photo_keys.length === 0 ? (
        <div className="mt-2 px-1 text-[11px] text-ink-3">Tap + Add to capture or upload (max 15 MB each).</div>
      ) : null}
    </div>
  )
}
