/**
 * Foreman desktop — FM · DAILY LOG · AI DRAFT REVIEW (Desktop v2).
 *
 * Mirrors the template's `m-fmdl` frame: an eyebrow + display headline, a
 * three-stat KPI strip (Photos / Hours / Issues), then a `.d-split` with the
 * AGENT DRAFT narrative + a notes editor on the LEFT and a photo grid +
 * "Submit to PM" primary action on the RIGHT.
 *
 * Reuses the SAME daily-log hook surface as the mobile composer
 * (screens/mobile/foreman-log.tsx): the screen finds-or-creates today's
 * draft for the active foreman + project, drafts a narrative through
 * `useTriggerVoiceToLog` + `useAiInsights`, and submits through the
 * `daily_log` workflow reducer via `useSubmitDailyLog`. No new hooks.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
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
} from '@/lib/api'
import { DEyebrow, DH1, DKpi, DKpiStrip } from '@/components/d'
import { DailyLogSubmittedBanner, MButton, MPill, MSelect, MTextarea } from '@/components/m'
import { MAiAgent, MAttribution } from '@/components/m/ai'
import { assembleDailyLogDefaults, isEmptyDailyLogDraft } from '@/lib/daily-log-assembly'
import { endOfWeek, formatDecimalHours, startOfWeek, todayIso } from '../mobile/format.js'

const MONO_LABEL: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--m-ink-3)',
}

/**
 * The daily-log `weather` column is free-form JSON. The voice-to-log agent
 * writes `{ summary }`; richer rows may carry `{ temp_f, condition, wind_mph }`.
 * Normalize whatever's there into a KPI value + meta line for the Weather tile
 * (design dsg__42: "62°" / "CLEAR · WIND 8MPH"). Returns null when empty.
 */
function parseWeather(raw: unknown): { value: string; meta: string | null } | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    const s = raw.trim()
    return s ? { value: s, meta: null } : null
  }
  if (typeof raw === 'object') {
    const w = raw as Record<string, unknown>
    const tempRaw = w.temp_f ?? w.temp ?? w.temperature
    const temp = typeof tempRaw === 'number' ? `${Math.round(tempRaw)}°` : null
    const condition = typeof w.condition === 'string' ? w.condition : typeof w.summary === 'string' ? w.summary : null
    const windRaw = w.wind_mph ?? w.wind
    const wind = typeof windRaw === 'number' ? `WIND ${Math.round(windRaw)}MPH` : null
    const metaParts = [condition?.toUpperCase(), wind].filter(Boolean) as string[]
    const value = temp ?? condition ?? null
    if (!value) return null
    return { value, meta: metaParts.filter((p) => p !== value.toUpperCase()).join(' · ') || null }
  }
  return null
}

export function FmLog({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const params = useParams<{ projectId?: string }>()

  // Active projects this foreman can log against. The optional :projectId
  // route param seeds the selection; otherwise fall back to the first.
  const projects = useMemo(
    () => bootstrap?.projects.filter((p) => /progress|active/i.test(p.status)) ?? [],
    [bootstrap?.projects],
  )
  const [projectId, setProjectId] = useState<string>(() => params.projectId ?? projects[0]?.id ?? '')

  // Snap onto a valid project once bootstrap lands (route param wins if valid).
  useEffect(() => {
    if (projectId && projects.some((p) => p.id === projectId)) return
    const next =
      (params.projectId && projects.some((p) => p.id === params.projectId) ? params.projectId : '') ||
      projects[0]?.id ||
      ''
    if (next && next !== projectId) setProjectId(next)
  }, [params.projectId, projectId, projects])

  const today = todayIso()
  const list = useDailyLogs(projectId ? { from: today, to: today, projectId } : { from: today, to: today }, {
    enabled: Boolean(projectId),
  })
  const log = list.data?.dailyLogs.find((d) => d.project_id === projectId && d.occurred_on === today) ?? null

  // Find-or-create today's draft for the active foreman + project.
  const create = useCreateDailyLog()
  useEffect(() => {
    if (!projectId || !list.isFetched || log || create.isPending) return
    void create.mutateAsync({ project_id: projectId, occurred_on: today }).catch(() => {})
  }, [projectId, list.isFetched, log, today])

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Foreman · Daily Log</DEyebrow>
          <DH1>End the day on record.</DH1>
        </div>

        {projects.length === 0 ? (
          <div className="d-card" style={{ color: 'var(--m-ink-3)', fontSize: 14 }}>
            No active jobs today. The daily log opens once a project is on site.
          </div>
        ) : (
          <>
            {projects.length > 1 ? (
              <div style={{ maxWidth: 360 }}>
                <div style={MONO_LABEL}>Project</div>
                <MSelect
                  value={projectId}
                  onChange={(e) => setProjectId(e.currentTarget.value)}
                  style={{ width: '100%', marginTop: 8 }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </MSelect>
              </div>
            ) : null}

            {!projectId ? (
              <div className="d-card" style={{ color: 'var(--m-ink-3)', fontSize: 14 }}>
                Select a project to start its log.
              </div>
            ) : log ? (
              <DailyLogEditor key={log.id} log={log} bootstrap={bootstrap} />
            ) : list.isLoading || create.isPending || !list.isFetched ? (
              <div className="d-card" style={{ color: 'var(--m-ink-3)', fontSize: 14 }}>
                Preparing today&apos;s draft…
              </div>
            ) : (
              <div className="d-card" style={{ color: 'var(--m-ink-3)', fontSize: 14 }}>
                No draft yet — it will appear in a moment.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface DailyLogEditorProps {
  log: DailyLog
  bootstrap: BootstrapResponse | null
}

function DailyLogEditor({ log, bootstrap }: DailyLogEditorProps) {
  const patch = usePatchDailyLog(log.id)
  const submit = useSubmitDailyLog(log.id)

  const isSubmitted = log.status === 'submitted'
  const today = log.occurred_on

  // Weekly strip for the submitted confirmation surface (design msg__41).
  // Only fetched when submitted so the draft path pays nothing.
  const weekLogs = useDailyLogs(
    { from: startOfWeek(today), to: endOfWeek(today), projectId: log.project_id },
    { enabled: isSubmitted },
  )
  const weekEntries = useMemo(
    () => (weekLogs.data?.dailyLogs ?? []).map((d) => ({ occurred_on: d.occurred_on, status: d.status })),
    [weekLogs.data],
  )

  // Today's labor on this project — feeds the Hours stat + agent attribution.
  const todayLabor = useMemo(
    () =>
      (bootstrap?.laborEntries ?? []).filter(
        (l) => l.occurred_on === today && !l.deleted_at && l.project_id === log.project_id,
      ),
    [bootstrap?.laborEntries, today, log.project_id],
  )
  const totalHours = todayLabor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)

  // One-shot auto-assembly prefill — ported from the mobile composer to
  // close the drift the audit flagged (desktop previously omitted this).
  // Same pure `assembleDailyLogDefaults` / `isEmptyDailyLogDraft` path.
  const briefs = useProjectBriefs(log.project_id, today)
  const [prefilled, setPrefilled] = useState(false)
  const prefillAttempted = useRef(false)

  // Notes editor with debounced auto-save (same shape as the mobile composer).
  const [notes, setNotes] = useState(log.notes ?? '')
  const dirtyRef = useRef(false)
  const versionRef = useRef(log.version)
  useEffect(() => {
    if (!dirtyRef.current) setNotes(log.notes ?? '')
    versionRef.current = log.version
  }, [log.notes, log.version])

  // Prefill scope_progress (from briefs) + crew_summary (from labor) once,
  // only on a still-empty draft. Mirrors foreman-log.tsx exactly.
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
  }, [notes, isSubmitted, log.notes])

  const photoCount = log.photo_keys.length
  const issuesCount = Array.isArray(log.schedule_deviations) ? log.schedule_deviations.length : 0
  const weather = parseWeather(log.weather)

  const onSubmit = async () => {
    if (isSubmitted) return
    if (dirtyRef.current) {
      await patch.mutateAsync({ notes, expected_version: versionRef.current }).catch(() => {})
    }
    await submit.mutateAsync({ expected_version: versionRef.current }).catch(() => {})
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={MONO_LABEL}>
          {today} · {isSubmitted ? 'Submitted' : 'Draft'} · AI-assembled
        </span>
        <MPill tone={isSubmitted ? 'green' : 'amber'} dot>
          {isSubmitted ? 'SUBMITTED' : 'DRAFT · NOT SENT'}
        </MPill>
      </div>

      <DKpiStrip>
        <DKpi label="Photos" value={String(photoCount)} meta={photoCount > 0 ? 'On record' : 'None yet'} />
        <DKpi
          label="Crew hours"
          value={formatDecimalHours(totalHours, 1).replace('h', '')}
          unit="h"
          meta={totalHours > 0 ? `${todayLabor.length} entries` : 'No clock-ins'}
          metaTone={totalHours > 0 ? 'good' : undefined}
        />
        <DKpi label="Weather" value={weather?.value ?? '—'} meta={weather?.meta ?? (weather ? null : 'Not logged')} />
        <DKpi
          label="Issues"
          value={String(issuesCount)}
          tone={issuesCount > 0 ? 'accent' : undefined}
          meta={issuesCount > 0 ? 'Deviations flagged' : 'On plan'}
          metaTone={issuesCount > 0 ? 'bad' : undefined}
        />
      </DKpiStrip>

      <div className="d-split">
        {/* LEFT — agent draft + notes editor */}
        <div className="d-stack" style={{ gap: 20 }}>
          <div>
            <div style={MONO_LABEL}>Agent draft</div>
            <div style={{ marginTop: 8 }}>
              <VoiceToLogBlock
                dailyLogId={log.id}
                isSubmitted={isSubmitted}
                attributionCounts={{
                  photos: photoCount,
                  fieldEvents: todayLabor.length + issuesCount,
                }}
                onApplyProposal={async (proposal) => {
                  const nextNotes = notes.trim() ? `${notes.trim()}\n\n${proposal.narrative}` : proposal.narrative
                  dirtyRef.current = true
                  setNotes(nextNotes)
                  await patch
                    .mutateAsync({
                      notes: nextNotes,
                      weather: proposal.weather_summary ? { summary: proposal.weather_summary } : null,
                      schedule_deviations: proposal.schedule_deviations,
                      expected_version: versionRef.current,
                    })
                    .then(() => {
                      dirtyRef.current = false
                    })
                    .catch(() => {})
                }}
              />
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={MONO_LABEL}>Notes</div>
              {prefilled ? <MPill tone="accent">Pre-filled from today's data</MPill> : null}
            </div>
            <MTextarea
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              placeholder="What happened today? Any deviations from plan?"
              disabled={isSubmitted}
              style={{
                width: '100%',
                minHeight: 180,
                marginTop: 8,
                background: 'var(--m-card-soft)',
                border: '2px solid var(--m-ink)',
                fontSize: 15,
                lineHeight: 1.5,
              }}
            />
          </div>
        </div>

        {/* RIGHT — photo grid + submit (sticky) */}
        <div className="d-card" style={{ position: 'sticky', top: 24 }}>
          <div style={MONO_LABEL}>Photos · {photoCount}</div>
          <div style={{ marginTop: 12 }}>
            <PhotoGrid log={log} />
          </div>

          <div style={{ marginTop: 20 }}>
            <MButton
              variant="primary"
              onClick={onSubmit}
              disabled={isSubmitted || submit.isPending}
              style={{ width: '100%' }}
            >
              {isSubmitted ? 'Submitted to PM' : submit.isPending ? 'Submitting…' : 'Submit to PM'}
            </MButton>
            {isSubmitted ? (
              <div style={{ marginTop: 12 }}>
                <DailyLogSubmittedBanner submittedAt={log.submitted_at} weekLogs={weekEntries} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * Photo grid. Reads per-photo metadata from `useDailyLogPhotos`, falling
 * back to the legacy `log.photo_keys` array before the query resolves so
 * the grid never flashes empty for freshly-uploaded photos.
 */
function PhotoGrid({ log }: { log: DailyLog }) {
  const photosQuery = useDailyLogPhotos(log.id)
  const photos = useMemo<DailyLogPhotoMetadata[]>(() => {
    if (photosQuery.data?.photos && photosQuery.data.photos.length > 0) {
      return photosQuery.data.photos
    }
    return log.photo_keys.map((key, idx) => ({
      id: `legacy-${idx}`,
      storage_key: key,
      scope_step_id: null,
      scope_step_label: null,
      captured_at: log.created_at,
    }))
  }, [photosQuery.data, log.photo_keys, log.created_at])

  if (photos.length === 0) {
    return (
      <div style={{ color: 'var(--m-ink-3)', fontSize: 13, padding: '8px 0' }}>
        No photos captured yet. They show here as the crew uploads from the field.
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4 }}>
      {photos.map((photo) => (
        <img
          key={photo.id}
          src={dailyLogPhotoUrl(log.id, photo.storage_key)}
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
  attributionCounts: { photos: number; fieldEvents: number }
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
            {attributionCounts.photos} photos, {attributionCounts.fieldEvents} field events
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
            style={{ width: '100%', minHeight: 90, marginBottom: 8 }}
          />
          <MButton variant="primary" size="sm" onClick={onRunAgent} disabled={!transcript.trim() || trigger.isPending}>
            {trigger.isPending ? 'Drafting…' : 'Draft narrative'}
          </MButton>
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>Submitted logs are locked.</div>
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
            <div
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8, marginTop: 6 }}
            >
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
