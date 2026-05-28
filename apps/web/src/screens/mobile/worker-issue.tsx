/**
 * Flag a problem — `wk-issue`. Six-tile category grid (per the screenshot,
 * not the README's 4 chips). Submits a worker_issues row server-side via
 * the existing /api/worker-issues route.
 *
 * Categories map to the worker_issues.kind enum. Migration 044 currently
 * accepts materials_out / crew_short / safety / other; the design's new
 * 6 categories (out_of_materials / equipment_broken / safety_concern /
 * weather_hold / scope_question / other) will need a follow-up migration
 * to amend the CHECK constraint. For now we send the closest match and
 * surface the design label in copy.
 *
 * Severity is appended to the message body as a `[severity:slowing]` tag
 * until the schema gets a column.
 *
 * Voice + photo attachments persist via migration 054 (`worker_issue_attachments`):
 * after the POST /api/worker-issues row lands, we follow up with one or
 * more multipart POSTs to /api/worker-issues/:id/attachments. The
 * deprecated `voice_data_url` / `photo_data_url` JSON fields used to be
 * sent inline — they were silently dropped by the server and are removed
 * here. Attachment failures don't block the foreman ping; they surface
 * via MBanner so the worker can retry just the upload.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { type BootstrapResponse } from '@/lib/api'
import {
  type PendingAttachment,
  type WorkerIssueCreateBody,
  useWorkerIssueSubmit,
} from '../../machines/worker-issue-submit.js'
import {
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MChip,
  MChipRow,
  MI,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'

type IssueCategory = {
  /** Displayed label */
  label: string
  /** Short brutalist glyph shown big on the v2 tile (MATL / STOP / WX …). */
  glyph: string
  /** Sub label */
  sub: string
  /** Maps to worker_issues.kind on the server. */
  kind: 'materials_out' | 'crew_short' | 'safety' | 'other'
  /** Matching design-level token; lands in the message body until the
   *  server constraint is amended. */
  designKind: 'out_of_materials' | 'equipment_broken' | 'safety_concern' | 'weather_hold' | 'scope_question' | 'other'
  Icon: typeof MI.AlertTri
  /** v2 tile fill: accent yellow, dark ink, or danger red. */
  tone: 'accent' | 'dark' | 'danger'
}

type Severity = 'question' | 'slowing' | 'stopped'

const CATEGORIES: ReadonlyArray<IssueCategory> = [
  {
    label: 'Out of materials',
    glyph: 'MATL',
    sub: 'Need delivery',
    kind: 'materials_out',
    designKind: 'out_of_materials',
    Icon: MI.Layers,
    tone: 'accent',
  },
  {
    label: 'Equipment broken',
    glyph: 'TOOL',
    sub: 'Tool / scaffold',
    kind: 'other',
    designKind: 'equipment_broken',
    Icon: MI.Drill,
    tone: 'dark',
  },
  {
    label: 'Safety concern',
    glyph: 'STOP',
    sub: 'Stop work',
    kind: 'safety',
    designKind: 'safety_concern',
    Icon: MI.ShieldAlert,
    tone: 'danger',
  },
  {
    label: 'Weather hold',
    glyph: 'WX',
    sub: 'Rain / wind',
    kind: 'other',
    designKind: 'weather_hold',
    Icon: MI.CloudRain,
    tone: 'dark',
  },
  {
    label: 'Scope question',
    glyph: '?',
    sub: 'Need clarity',
    kind: 'other',
    designKind: 'scope_question',
    Icon: MI.AlertTri,
    tone: 'dark',
  },
  {
    label: 'Other',
    glyph: '···',
    sub: 'Type it out',
    kind: 'other',
    designKind: 'other',
    Icon: MI.Alert,
    tone: 'dark',
  },
]

export function WorkerIssue({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const [category, setCategory] = useState<IssueCategory | null>(null)
  // UI-only highlight for the v2 tile grid before the worker hits SEND.
  // Tapping a tile selects it (accent fill); SEND advances to the compose
  // step via the existing setCategory transition. No data wiring touched.
  const [picked, setPicked] = useState<IssueCategory | null>(null)
  const [message, setMessage] = useState('')
  const [severity, setSeverity] = useState<Severity>('question')
  const [voice, setVoice] = useState<{ blob: Blob; url: string; durationMs: number } | null>(null)
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null)
  const submission = useWorkerIssueSubmit()

  const projectId = bootstrap?.projects.find((p) => /progress|active/i.test(p.status))?.id ?? null

  // Default severity per category — safety = stopped, everything else
  // starts at "question" so the foreman doesn't get false alarms.
  useEffect(() => {
    if (!category) return
    if (category.kind === 'safety') setSeverity('stopped')
  }, [category])

  // Once everything succeeded the screen navigates away. This stays in
  // an effect because the machine is the source of truth for "are we
  // done" — the form just renders state.
  useEffect(() => {
    if (submission.isDone) navigate('/today')
  }, [submission.isDone, navigate])

  const handleSend = () => {
    if (!category) return
    const trimmed = message.trim() || `${category.label}: ${category.sub}`
    const tags = [`[${category.designKind}]`, `[severity:${severity}]`].filter(Boolean).join(' ')
    const body: WorkerIssueCreateBody = {
      kind: category.kind,
      message: `${tags} ${trimmed}`.trim(),
      ...(projectId ? { project_id: projectId } : {}),
    }
    const attachments: PendingAttachment[] = []
    if (voice) attachments.push({ kind: 'voice', payload: voice.blob, fileName: fileNameForVoice(voice.blob) })
    if (photo) attachments.push({ kind: 'photo', payload: photo.file, fileName: photo.file.name || 'photo.jpg' })
    submission.submit({ companySlug, body, attachments })
  }

  if (category) {
    return (
      <>
        <MTopBar back title="Flag a problem" sub={category.label} onBack={() => setCategory(null)} />
        <MBody pad>
          <SeveritySegmented value={severity} onChange={setSeverity} />
          <div
            style={{
              padding: '12px 0 8px',
              fontSize: 12,
              color: 'var(--m-ink-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            What's wrong?
          </div>
          <MTextarea
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            placeholder="Describe the issue — short is fine."
            style={{ width: '100%', minHeight: 120 }}
          />
          <VoiceRecorder value={voice} onChange={setVoice} onError={() => {}} />
          <PhotoAttach value={photo} onChange={setPhoto} />
          {submission.error ? (
            <div style={{ marginTop: 12 }}>
              <MBanner tone="error" title="Couldn't send the issue" body={submission.error} />
            </div>
          ) : null}
          {submission.isPartial && submission.failed.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <MBanner
                tone="warn"
                title="Attachment didn't upload"
                body={`Issue sent. Failed: ${submission.failed.map((f) => `${f.kind}: ${f.message}`).join('; ')}`}
              />
            </div>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <MButtonStack>
              {submission.isPartial ? (
                <MButton variant="primary" onClick={submission.retryAttachments} disabled={submission.isBusy}>
                  {submission.isBusy ? buttonLabelForStage(submission.stage) : 'Retry attachments'}
                </MButton>
              ) : (
                <MButton variant="primary" onClick={handleSend} disabled={submission.isBusy}>
                  {submission.isBusy ? buttonLabelForStage(submission.stage) : 'Send to foreman'}
                </MButton>
              )}
              {submission.isPartial ? (
                <MButton
                  variant="ghost"
                  onClick={() => {
                    submission.dismissError()
                    navigate('/today')
                  }}
                >
                  Skip and continue
                </MButton>
              ) : null}
              <MButton variant="ghost" onClick={() => setCategory(null)} disabled={submission.isBusy}>
                Pick a different category
              </MButton>
            </MButtonStack>
          </div>
        </MBody>
      </>
    )
  }

  return (
    <>
      <MTopBar back title="Flag a problem" onBack={() => navigate('/today')} />
      <MBody pad>
        <div className="m-topbar-eyebrow" style={{ marginBottom: 12 }}>
          WHAT'S WRONG?
        </div>
        {/* 2×3 grid of large glove-target tiles. Reuses the v2-styled
         * `.m-qa` primitive surface; the picked tile flips to accent
         * yellow. Square min-height keeps every tile a fat tap target. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {CATEGORIES.map((c) => {
            const isPicked = picked?.designKind === c.designKind
            return (
              <button
                key={c.designKind}
                type="button"
                className="m-qa"
                data-tone={isPicked ? 'accent' : c.tone}
                onClick={() => setPicked(c)}
                aria-pressed={isPicked}
                style={{
                  minHeight: 120,
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span className="m-qa-icon">
                  <c.Icon size={20} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                  <span
                    style={{
                      fontFamily: 'var(--m-font-display)',
                      fontSize: 30,
                      fontWeight: 800,
                      lineHeight: 1,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {c.glyph}
                  </span>
                  <span className="m-qa-label">{c.label}</span>
                </span>
              </button>
            )
          })}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            padding: '16px 0 4px',
            fontSize: 12,
            color: 'var(--m-ink-3)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {picked ? `SELECTED · ${picked.glyph} · FOREMAN GETS THE PING` : 'PICK A TILE TO FLAG IT'}
        </div>
        <div style={{ marginTop: 16 }}>
          <MButton
            variant="primary"
            data-size="worker"
            disabled={!picked}
            onClick={() => {
              if (picked) setCategory(picked)
            }}
          >
            Send to foreman
          </MButton>
        </div>
      </MBody>
    </>
  )
}

function SeveritySegmented({ value, onChange }: { value: Severity; onChange: (v: Severity) => void }) {
  return (
    <MChipRow>
      <MChip active={value === 'question'} onClick={() => onChange('question')}>
        Question
      </MChip>
      <MChip active={value === 'slowing'} onClick={() => onChange('slowing')}>
        Slowing down
      </MChip>
      <MChip active={value === 'stopped'} onClick={() => onChange('stopped')}>
        Stopped
      </MChip>
    </MChipRow>
  )
}

function VoiceRecorder({
  value,
  onChange,
  onError,
}: {
  value: { blob: Blob; url: string; durationMs: number } | null
  onChange: (v: { blob: Blob; url: string; durationMs: number } | null) => void
  onError: (msg: string) => void
}) {
  const [recording, setRecording] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const startedAtRef = useRef(0)
  const tickRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current)
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    }
  }, [])

  const start = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      onError('Microphone not available on this device.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        const url = URL.createObjectURL(blob)
        onChange({ blob, url, durationMs: Date.now() - startedAtRef.current })
        for (const track of stream.getTracks()) track.stop()
      }
      recorder.start()
      recorderRef.current = recorder
      startedAtRef.current = Date.now()
      setElapsedMs(0)
      tickRef.current = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200)
      setRecording(true)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not start recording.')
    }
  }

  const stop = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current)
      tickRef.current = null
    }
    setRecording(false)
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="m-topbar-eyebrow" style={{ marginBottom: 8 }}>
        VOICE NOTE · OPTIONAL
      </div>
      {value ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <audio src={value.url} controls style={{ flex: 1 }} />
          <MButton size="sm" variant="ghost" onClick={() => onChange(null)}>
            Re-record
          </MButton>
        </div>
      ) : recording ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: 'var(--m-red)',
              animation: 'm-pulse 1.2s infinite',
            }}
          />
          <span className="num" style={{ fontSize: 18, fontWeight: 600 }}>
            {Math.floor(elapsedMs / 1000)}s
          </span>
          <MButton size="sm" variant="quiet" onClick={stop}>
            Stop
          </MButton>
        </div>
      ) : (
        <MButton size="sm" variant="ghost" onClick={start}>
          <MI.Mic size={16} />
          Tap to record · 30s max
        </MButton>
      )}
    </div>
  )
}

function PhotoAttach({
  value,
  onChange,
}: {
  value: { file: File; url: string } | null
  onChange: (v: { file: File; url: string } | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div style={{ marginTop: 16 }}>
      <div className="m-topbar-eyebrow" style={{ marginBottom: 8 }}>
        PHOTO · OPTIONAL
      </div>
      {value ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <img
            src={value.url}
            alt="Attached"
            style={{ width: 120, height: 120, borderRadius: 10, objectFit: 'cover' }}
          />
          <MButton size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </MButton>
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0]
              if (f) onChange({ file: f, url: URL.createObjectURL(f) })
            }}
          />
          <MButton size="sm" variant="ghost" onClick={() => inputRef.current?.click()}>
            <MI.Camera size={16} />
            Add a photo
          </MButton>
        </>
      )}
    </div>
  )
}

function buttonLabelForStage(stage: 'idle' | 'creating' | 'uploading-voice' | 'uploading-photo' | 'done'): string {
  if (stage === 'creating') return 'Sending…'
  if (stage === 'uploading-voice') return 'Uploading voice note…'
  if (stage === 'uploading-photo') return 'Uploading photo…'
  return 'Sending…'
}

function fileNameForVoice(blob: Blob): string {
  const type = blob.type.toLowerCase()
  if (type.includes('webm')) return 'voice.webm'
  if (type.includes('ogg')) return 'voice.ogg'
  if (type.includes('mp4') || type.includes('m4a')) return 'voice.m4a'
  if (type.includes('mpeg')) return 'voice.mp3'
  if (type.includes('wav')) return 'voice.wav'
  return 'voice.webm'
}
