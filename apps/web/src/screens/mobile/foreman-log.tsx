/**
 * Daily log builder — `fm-log` (mobile).
 *
 * The end-of-day report. Mirrors `apps/web/src/screens/foreman/daily-log.tsx`
 * scaled for the mobile shell:
 *
 *   - Real daily-log row via the daily-logs API (`useCreateDailyLog`,
 *     `usePatchDailyLog`, `useSubmitDailyLog`). The screen finds or
 *     creates today's draft for the active foreman + project.
 *   - Voice-to-log AgentSurface using `MAiAgent` + `MAttribution` from
 *     the `m/` primitives. The agent endpoint is the same one
 *     (POST /api/ai/agents/voice-to-log) wrapped by `useTriggerVoiceToLog`.
 *   - Auto-assembly fallback: if the agent hasn't run, pre-populate
 *     scope_progress (from briefs) + crew_summary (from labor entries)
 *     once on mount, surfacing a "Pre-filled from today's data" pill.
 *     See `apps/web/src/lib/daily-log-assembly.ts`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import {
  DailyLogSubmittedBanner,
  MBody,
  MButton,
  MI,
  MPill,
  MSectionH,
  MSelect,
  MStat,
  MStatStrip,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { MAiAgent, MAttribution } from '../../components/m/ai.js'
import {
  dailyLogPhotoUrl,
  useAiInsights,
  useApplyInsight,
  useCreateDailyLog,
  useDailyLogPhotos,
  useDailyLogs,
  useDismissInsight,
  usePatchDailyLog,
  useProjectBriefs,
  useSubmitDailyLog,
  useTriggerVoiceToLog,
  type DailyLog,
  type DailyLogPhotoMetadata,
  type VoiceToLogProposal,
} from '../../lib/api/index.js'
import type { ProjectBriefStep } from '../../lib/api/project-briefs.js'
import { assembleDailyLogDefaults, isEmptyDailyLogDraft } from '../../lib/daily-log-assembly.js'
import { endOfWeek, formatDecimalHours, startOfWeek, todayIso } from './format.js'

export function ForemanLog({ bootstrap }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const projects = useMemo(
    () => bootstrap?.projects.filter((p) => /progress|active/i.test(p.status)) ?? [],
    [bootstrap?.projects],
  )
  const [projectId, setProjectId] = useState<string>(() => projects[0]?.id ?? '')

  // Snap projectId onto the first active project once bootstrap lands.
  // Without this, an empty initial value sticks even after data arrives.
  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id)
  }, [projectId, projects])

  const today = todayIso()
  const list = useDailyLogs(projectId ? { from: today, to: today, projectId } : { from: today, to: today }, {
    enabled: Boolean(projectId),
  })
  const log = list.data?.dailyLogs.find((d) => d.project_id === projectId && d.occurred_on === today) ?? null

  const create = useCreateDailyLog()
  useEffect(() => {
    if (!projectId || !list.isFetched || log || create.isPending) return
    void create.mutateAsync({ project_id: projectId, occurred_on: today }).catch(() => {})
  }, [projectId, list.isFetched, log])

  return (
    <>
      <MTopBar title="Daily log" sub={today} actionIcon={<MI.FileText size={20} />} />
      <MBody pad>
        {projects.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--m-ink-3)', fontSize: 13 }}>No active projects today.</div>
        ) : (
          <>
            {projects.length > 1 ? (
              <div style={{ marginBottom: 12 }}>
                <MSelect
                  value={projectId}
                  onChange={(e) => setProjectId(e.currentTarget.value)}
                  style={{ width: '100%' }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </MSelect>
              </div>
            ) : null}
            {log ? (
              <DailyLogEditor log={log} bootstrap={bootstrap} onDone={() => navigate('/today')} />
            ) : (
              <div className="m-quiet-sm" style={{ padding: 16 }}>
                Preparing draft…
              </div>
            )}
          </>
        )}
      </MBody>
    </>
  )
}

interface DailyLogEditorProps {
  log: DailyLog
  bootstrap: BootstrapResponse | null
  onDone: () => void
}

function DailyLogEditor({ log, bootstrap, onDone }: DailyLogEditorProps) {
  const patch = usePatchDailyLog(log.id)
  const submit = useSubmitDailyLog(log.id)

  const isSubmitted = log.status === 'submitted'
  const today = log.occurred_on

  // Weekly strip data — the foreman's logs for the current week on this
  // project, used by the submitted confirmation surface (design msg__41).
  // Only fetched once the log is submitted so the draft path pays nothing.
  const weekLogs = useDailyLogs(
    { from: startOfWeek(today), to: endOfWeek(today), projectId: log.project_id },
    { enabled: isSubmitted },
  )
  const weekEntries = useMemo(
    () => (weekLogs.data?.dailyLogs ?? []).map((d) => ({ occurred_on: d.occurred_on, status: d.status })),
    [weekLogs.data],
  )

  // Today's labor on this project — used both for the Hours stat and
  // for the auto-assembly crew_summary fallback.
  const todayLabor = useMemo(() => {
    return (bootstrap?.laborEntries ?? []).filter(
      (l) => l.occurred_on === today && !l.deleted_at && l.project_id === log.project_id,
    )
  }, [bootstrap?.laborEntries, today, log.project_id])
  const totalHours = todayLabor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)

  // Auto-assembly fallback. Same pure function as the foreman desktop
  // screen — see lib/daily-log-assembly.ts.
  const briefs = useProjectBriefs(log.project_id, today)
  const [prefilled, setPrefilled] = useState(false)
  const prefillAttempted = useRef(false)
  useEffect(() => {
    if (prefillAttempted.current) return
    if (isSubmitted) return
    if (briefs.isPending) return
    if (!isEmptyDailyLogDraft(log)) {
      prefillAttempted.current = true
      return
    }
    prefillAttempted.current = true
    const defaults = assembleDailyLogDefaults({
      briefs: briefs.data?.briefs ?? [],
      laborEntries: todayLabor.map((l) => ({
        worker_id: l.worker_id,
        hours: l.hours,
        occurred_on: l.occurred_on,
        deleted_at: l.deleted_at,
      })),
      workers: bootstrap?.workers.map((w) => ({ id: w.id, name: w.name })) ?? [],
      photos: [],
      occurredOn: today,
    })
    if (!defaults.scope_progress && !defaults.crew_summary) return
    setPrefilled(true)
    void patch
      .mutateAsync({
        scope_progress: defaults.scope_progress || undefined,
        crew_summary: defaults.crew_summary || undefined,
        expected_version: log.version,
      })
      .catch(() => {})
  }, [briefs.isPending, briefs.data, todayLabor, isSubmitted])

  // Notes textarea + debounced auto-save.
  const [notes, setNotes] = useState(log.notes ?? '')
  const dirtyRef = useRef(false)
  const versionRef = useRef(log.version)
  useEffect(() => {
    if (!dirtyRef.current) setNotes(log.notes ?? '')
    versionRef.current = log.version
  }, [log.notes, log.version])
  useEffect(() => {
    if (isSubmitted) return
    if (notes === (log.notes ?? '')) return
    dirtyRef.current = true
    const id = window.setTimeout(() => {
      void patch
        .mutateAsync({ notes, expected_version: versionRef.current })
        .then(() => {
          dirtyRef.current = false
        })
        .catch(() => {})
    }, 1200)
    return () => window.clearTimeout(id)
  }, [notes])

  const photoCount = log.photo_keys.length
  const issuesCount = Array.isArray(log.schedule_deviations) ? log.schedule_deviations.length : 0

  const onSubmit = async () => {
    if (dirtyRef.current) {
      await patch.mutateAsync({ notes, expected_version: versionRef.current }).catch(() => {})
    }
    await submit.mutateAsync({ expected_version: versionRef.current }).catch(() => {})
    onDone()
  }

  // Explicit "Save draft" — flushes the pending notes patch immediately
  // (the 1.2s auto-save is a backstop) and shows a brief saved confirmation,
  // matching the design's two-button draft footer (msg__40).
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const onSaveDraft = async () => {
    await patch
      .mutateAsync({ notes, expected_version: versionRef.current })
      .then(() => {
        dirtyRef.current = false
        setSavedAt(Date.now())
      })
      .catch(() => {})
  }

  return (
    <>
      {isSubmitted ? (
        <div style={{ padding: '0 16px 12px' }}>
          <DailyLogSubmittedBanner submittedAt={log.submitted_at} weekLogs={weekEntries} />
        </div>
      ) : null}

      <MStatStrip>
        <MStat label="PHOTOS" value={String(photoCount)} />
        <MStat label="HOURS" value={formatDecimalHours(totalHours, 1)} />
        <MStat
          label={<span style={{ color: issuesCount > 0 ? 'var(--m-amber)' : undefined }}>ISSUES</span>}
          value={<span style={{ color: issuesCount > 0 ? 'var(--m-amber)' : undefined }}>{String(issuesCount)}</span>}
        />
      </MStatStrip>

      {prefilled ? (
        <div style={{ padding: '8px 16px 0' }}>
          <MPill tone="accent">Pre-filled from today's data</MPill>
        </div>
      ) : null}

      <MSectionH>Notes</MSectionH>
      <div style={{ padding: '0 16px' }}>
        <MTextarea
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          placeholder="What happened today? Any deviations from plan?"
          disabled={isSubmitted}
          style={{ width: '100%', minHeight: 100 }}
        />
      </div>

      <MSectionH>Agent draft</MSectionH>
      <div style={{ padding: '0 16px' }}>
        <VoiceToLogBlock
          dailyLogId={log.id}
          isSubmitted={isSubmitted}
          attributionCounts={{
            clockEvents: 0,
            photos: photoCount,
            fieldEvents: todayLabor.length + issuesCount,
          }}
          onApplyProposal={async (proposal) => {
            const nextNotes = notes.trim() ? `${notes.trim()}\n\n${proposal.narrative}` : proposal.narrative
            setNotes(nextNotes)
            await patch
              .mutateAsync({
                notes: nextNotes,
                weather: proposal.weather_summary ? { summary: proposal.weather_summary } : null,
                schedule_deviations: proposal.schedule_deviations,
                expected_version: versionRef.current,
              })
              .catch(() => {})
          }}
        />
      </div>

      <PhotoTimeline log={log} briefs={briefs.data?.briefs ?? []} />

      <div style={{ padding: 16 }}>
        {!isSubmitted ? (
          <div className="m-btn-row">
            <MButton variant="ghost" onClick={onSaveDraft} disabled={patch.isPending} style={{ flex: 1 }}>
              {patch.isPending ? 'Saving…' : savedAt ? 'Saved ✓' : 'Save draft'}
            </MButton>
            <MButton variant="primary" onClick={onSubmit} disabled={submit.isPending} style={{ flex: 2 }}>
              {submit.isPending ? 'Submitting…' : 'Submit to PM'}
            </MButton>
          </div>
        ) : (
          <MButton variant="primary" disabled>
            Submitted
          </MButton>
        )}
      </div>
    </>
  )
}

/**
 * Photo timeline grouped by scope step. Reads per-photo metadata from
 * `useDailyLogPhotos` (GET /api/daily-logs/:id/photos) — each photo
 * carries an optional `scope_step_id` set by `wk-log` at capture time.
 *
 * Layout:
 *   - One section per brief step. Filters photos by `scope_step_id`.
 *     Empty steps still render the title with a quiet placeholder so
 *     the foreman sees the structure of the day.
 *   - One trailing "Untagged" section for photos with no step id
 *     (legacy backfilled rows + uploads without an active step).
 *   - Falls back to a flat strip when there are no brief steps at all,
 *     so the screen still works on projects without a brief today.
 */
function PhotoTimeline({ log, briefs }: { log: DailyLog; briefs: { steps: unknown }[] }) {
  const steps = useMemo<ProjectBriefStep[]>(() => {
    const first = briefs[0]
    if (!first) return []
    return Array.isArray(first.steps) ? (first.steps as ProjectBriefStep[]) : []
  }, [briefs])

  // Per-photo metadata. The hook stays disabled until the log id is
  // known; on first load we may render before photos resolve, in
  // which case we synthesize minimal records from `log.photo_keys`
  // so the strip never goes blank for newly uploaded photos.
  const photosQuery = useDailyLogPhotos(log.id)
  const photos = useMemo<DailyLogPhotoMetadata[]>(() => {
    if (photosQuery.data?.photos && photosQuery.data.photos.length > 0) {
      return photosQuery.data.photos
    }
    // Fall back to the legacy array — photos that haven't been backfilled
    // yet, or the brief moment before the photos query resolves.
    return log.photo_keys.map((key, idx) => ({
      id: `legacy-${idx}`,
      storage_key: key,
      scope_step_id: null,
      scope_step_label: null,
      captured_at: log.created_at,
    }))
  }, [photosQuery.data, log.photo_keys, log.created_at])

  if (photos.length === 0 && steps.length === 0) return null

  const stepBuckets = steps.map((step, idx) => ({
    step,
    idx,
    photos: photos.filter((p) => p.scope_step_id && step.id && p.scope_step_id === step.id),
  }))
  const untagged = photos.filter((p) => {
    if (!p.scope_step_id) return true
    // Photo references a step id that is no longer in this brief
    // (e.g. brief was edited and the step removed). Surface it in
    // the untagged bucket so the photo never disappears from view.
    return !steps.some((s) => s.id && s.id === p.scope_step_id)
  })

  return (
    <>
      <MSectionH>Photos</MSectionH>
      {steps.length > 0 ? (
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {stepBuckets.map(({ step, idx, photos: stepPhotos }) => (
            <div key={step.id ?? idx}>
              <div className="m-topbar-eyebrow" style={{ marginBottom: 6 }}>
                {step.title || `Step ${idx + 1}`}
                {stepPhotos.length > 0 ? <span style={{ opacity: 0.7 }}> · {stepPhotos.length}</span> : null}
              </div>
              {stepPhotos.length > 0 ? (
                <PhotoStrip logId={log.id} photos={stepPhotos} />
              ) : (
                <div className="m-quiet-sm">No photos tagged to this step yet.</div>
              )}
            </div>
          ))}
          {untagged.length > 0 ? (
            <div>
              <div className="m-topbar-eyebrow" style={{ marginBottom: 6 }}>
                Untagged · {untagged.length}
              </div>
              <PhotoStrip logId={log.id} photos={untagged} />
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ padding: '0 16px' }}>
          <PhotoStrip logId={log.id} photos={photos} />
        </div>
      )}
    </>
  )
}

function PhotoStrip({ logId, photos }: { logId: string; photos: DailyLogPhotoMetadata[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
      {photos.map((photo) => (
        <img
          key={photo.id}
          src={dailyLogPhotoUrl(logId, photo.storage_key)}
          alt="Daily log"
          style={{
            width: '100%',
            aspectRatio: '1',
            objectFit: 'cover',
            border: '2px solid var(--m-ink)',
          }}
        />
      ))}
    </div>
  )
}

interface VoiceToLogBlockProps {
  dailyLogId: string
  isSubmitted: boolean
  attributionCounts: { clockEvents: number; photos: number; fieldEvents: number }
  onApplyProposal: (proposal: VoiceToLogProposal) => Promise<void>
}

function VoiceToLogBlock({ dailyLogId, isSubmitted, attributionCounts, onApplyProposal }: VoiceToLogBlockProps) {
  const trigger = useTriggerVoiceToLog()
  const insights = useAiInsights<VoiceToLogProposal>({ kind: 'voice_to_log', entityId: dailyLogId, open: true })
  const apply = useApplyInsight()
  const dismiss = useDismissInsight()
  const [transcript, setTranscript] = useState('')

  const latest = insights.data?.insights[0]

  const onRunAgent = async () => {
    if (!transcript.trim()) return
    await trigger.mutateAsync({ daily_log_id: dailyLogId, transcript, source: 'text' }).catch(() => {})
  }

  return (
    <MAiAgent
      attribution={
        <>
          Based on{' '}
          <strong>
            {attributionCounts.clockEvents} clock events, {attributionCounts.photos} photos,{' '}
            {attributionCounts.fieldEvents} field events
          </strong>
          .
        </>
      }
      onDismiss={
        latest && !isSubmitted
          ? () => {
              void dismiss.mutateAsync({ id: latest.id, reason: 'not_useful' }).catch(() => {})
            }
          : undefined
      }
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Voice-to-log</div>
      {!isSubmitted ? (
        <>
          <MTextarea
            value={transcript}
            onChange={(e) => setTranscript(e.currentTarget.value)}
            placeholder="Type the day's narrative; the agent drafts a structured log."
            style={{ width: '100%', minHeight: 80, marginBottom: 8 }}
          />
          <MButton variant="primary" size="sm" onClick={onRunAgent} disabled={!transcript.trim() || trigger.isPending}>
            {trigger.isPending ? 'Drafting…' : 'Draft narrative'}
          </MButton>
        </>
      ) : (
        <div className="m-quiet-sm">Submitted logs are locked.</div>
      )}

      {latest ? (
        <div
          style={{
            marginTop: 12,
            paddingTop: 8,
            borderTop: '1px dashed var(--m-line-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--m-ink-2)', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
            {latest.payload.narrative}
          </div>
          {latest.payload.weather_summary ? (
            <div style={{ fontSize: 11, fontStyle: 'italic', color: 'var(--m-ink-3)' }}>
              {latest.payload.weather_summary}
            </div>
          ) : null}
          {latest.payload.schedule_deviations.length ? (
            <ul style={{ paddingLeft: 16, margin: 0, fontSize: 11, color: 'var(--m-ink-3)' }}>
              {latest.payload.schedule_deviations.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : null}
          {!isSubmitted ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
              <MButton
                variant="primary"
                size="sm"
                onClick={async () => {
                  await onApplyProposal(latest.payload)
                  await apply.mutateAsync({ id: latest.id }).catch(() => {})
                }}
              >
                Apply to log
              </MButton>
              <MButton
                variant="quiet"
                size="sm"
                onClick={() => {
                  void dismiss.mutateAsync({ id: latest.id, reason: 'not_useful' }).catch(() => {})
                }}
              >
                Dismiss
              </MButton>
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 10 }}>
        <MAttribution>
          Drafted from foreman dictation by <strong>agent:voice_to_log</strong>.
        </MAttribution>
      </div>
    </MAiAgent>
  )
}
