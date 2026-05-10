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
import { apiPost, type BootstrapResponse } from '../../api-v1-compat.js'
import { API_URL, buildAuthHeaders } from '../../lib/api/client.js'
import {
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MChip,
  MChipRow,
  MI,
  MTapCard,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'

type IssueCategory = {
  /** Displayed label */
  label: string
  /** Sub label */
  sub: string
  /** Maps to worker_issues.kind on the server. */
  kind: 'materials_out' | 'crew_short' | 'safety' | 'other'
  /** Matching design-level token; lands in the message body until the
   *  server constraint is amended. */
  designKind: 'out_of_materials' | 'equipment_broken' | 'safety_concern' | 'weather_hold' | 'scope_question' | 'other'
  Icon: typeof MI.AlertTri
  tone: 'amber' | 'red' | 'blue' | 'accent'
}

type Severity = 'question' | 'slowing' | 'stopped'

const CATEGORIES: ReadonlyArray<IssueCategory> = [
  {
    label: 'Out of materials',
    sub: 'Need delivery',
    kind: 'materials_out',
    designKind: 'out_of_materials',
    Icon: MI.Layers,
    tone: 'amber',
  },
  {
    label: 'Equipment broken',
    sub: 'Tool / scaffold',
    kind: 'other',
    designKind: 'equipment_broken',
    Icon: MI.Drill,
    tone: 'red',
  },
  {
    label: 'Safety concern',
    sub: 'Stop work',
    kind: 'safety',
    designKind: 'safety_concern',
    Icon: MI.ShieldAlert,
    tone: 'red',
  },
  {
    label: 'Weather hold',
    sub: 'Rain / wind',
    kind: 'other',
    designKind: 'weather_hold',
    Icon: MI.CloudRain,
    tone: 'amber',
  },
  {
    label: 'Scope question',
    sub: 'Need clarity',
    kind: 'other',
    designKind: 'scope_question',
    Icon: MI.AlertTri,
    tone: 'blue',
  },
  { label: 'Other', sub: 'Type it out', kind: 'other', designKind: 'other', Icon: MI.Alert, tone: 'accent' },
]

type UploadStage = 'idle' | 'creating' | 'uploading-voice' | 'uploading-photo' | 'done'

type WorkerIssueCreateResponse = {
  worker_issue: { id: string }
}

export function WorkerIssue({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const [category, setCategory] = useState<IssueCategory | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null)
  const [severity, setSeverity] = useState<Severity>('question')
  const [voice, setVoice] = useState<{ blob: Blob; url: string; durationMs: number } | null>(null)
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null)
  const [stage, setStage] = useState<UploadStage>('idle')

  const projectId = bootstrap?.projects.find((p) => /progress|active/i.test(p.status))?.id ?? null

  // Default severity per category — safety = stopped, everything else
  // starts at "question" so the foreman doesn't get false alarms.
  useEffect(() => {
    if (!category) return
    if (category.kind === 'safety') setSeverity('stopped')
  }, [category])

  const handleSend = async () => {
    if (!category) return
    setBusy(true)
    setError(null)
    setAttachmentWarning(null)
    try {
      const trimmed = message.trim() || `${category.label}: ${category.sub}`
      const tags = [`[${category.designKind}]`, `[severity:${severity}]`].filter(Boolean).join(' ')
      const body: Record<string, unknown> = {
        kind: category.kind,
        message: `${tags} ${trimmed}`.trim(),
      }
      if (projectId) body.project_id = projectId
      // The deprecated `voice_data_url` / `photo_data_url` JSON fields
      // (silently dropped by the server) are gone — attachments are now
      // sent via multipart POST /api/worker-issues/:id/attachments below.

      setStage('creating')
      const resp = await apiPost<WorkerIssueCreateResponse>('/api/worker-issues', body, companySlug)
      const issueId = resp?.worker_issue?.id
      // Best-effort attachment upload — issue ping itself succeeded; if
      // either part fails we surface the failure but still navigate so
      // the foreman sees the ticket. The worker can retry from
      // fm-blocker-detail (TODO: actual retry surface — for v1 this
      // banner prints the error and the foreman can ask for a re-send).
      const failures: string[] = []
      if (issueId && voice) {
        setStage('uploading-voice')
        try {
          await uploadWorkerIssueAttachment(issueId, 'voice', voice.blob, fileNameForVoice(voice.blob))
        } catch (err) {
          failures.push(`voice: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (issueId && photo) {
        setStage('uploading-photo')
        try {
          await uploadWorkerIssueAttachment(issueId, 'photo', photo.file, photo.file.name || 'photo.jpg')
        } catch (err) {
          failures.push(`photo: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      setStage('done')
      if (failures.length > 0) {
        // Issue landed but attachments didn't — keep the user on the
        // form so they can see the warning.
        setAttachmentWarning(`Issue sent. Attachment upload failed — ${failures.join('; ')}`)
        return
      }
      navigate('/today')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      // Leave `stage` at 'done' or whichever step failed; the buttons key
      // off `busy` for disabled state.
    }
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
          <VoiceRecorder value={voice} onChange={setVoice} onError={(msg) => setError(msg)} />
          <PhotoAttach value={photo} onChange={setPhoto} />
          {error ? (
            <div style={{ marginTop: 12 }}>
              <MBanner tone="error" title="Couldn't send the issue" body={error} />
            </div>
          ) : null}
          {attachmentWarning ? (
            <div style={{ marginTop: 12 }}>
              <MBanner tone="warn" title="Attachment didn't upload" body={attachmentWarning} />
            </div>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <MButtonStack>
              <MButton variant="primary" onClick={handleSend} disabled={busy}>
                {busy ? buttonLabelForStage(stage) : 'Send to foreman'}
              </MButton>
              <MButton variant="ghost" onClick={() => setCategory(null)}>
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
          WHAT'S THE ISSUE?
        </div>
        {/* Aspect-ratio sizing keeps the tiles square on a phone but
         * blows them up to ~800px tall on a wide desktop viewport, so
         * cap the tile height. The grid still feels native at mobile
         * widths because the cap is well above the natural square. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {CATEGORIES.map((c) => (
            <MTapCard
              key={c.designKind}
              onClick={() => setCategory(c)}
              style={{
                aspectRatio: '1.1 / 1',
                maxHeight: 180,
                borderRadius: 14,
                padding: 14,
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: `var(--m-${c.tone === 'accent' ? 'accent' : c.tone}-soft)`,
                  color: `var(--m-${c.tone === 'accent' ? 'accent' : c.tone})`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <c.Icon size={18} />
              </span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{c.label}</div>
                <div className="m-quiet-sm" style={{ marginTop: 2 }}>
                  {c.sub}
                </div>
              </div>
            </MTapCard>
          ))}
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

function buttonLabelForStage(stage: UploadStage): string {
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

/**
 * POST /api/worker-issues/:id/attachments — multipart upload for a
 * single voice note or photo. Mirrors the daily-log photo upload helper
 * (apps/web/src/lib/api/daily-logs.ts: uploadDailyLogPhoto).
 */
async function uploadWorkerIssueAttachment(
  issueId: string,
  kind: 'voice' | 'photo',
  payload: Blob | File,
  fileName: string,
): Promise<void> {
  const form = new FormData()
  form.append('kind', kind)
  // Note: append `kind` BEFORE the file part. Busboy delivers fields in
  // wire order; the server reads `fields.kind` inside its `file` handler
  // so the field has to land first.
  form.append('file', payload, fileName)
  const headers = await buildAuthHeaders()
  const path = `/api/worker-issues/${encodeURIComponent(issueId)}/attachments`
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: form,
  })
  if (!response.ok) {
    const ct = response.headers.get('content-type') ?? ''
    let detail: string
    try {
      if (ct.includes('application/json')) {
        const body = (await response.json()) as { error?: string }
        detail = body?.error ?? ''
      } else {
        detail = await response.text()
      }
    } catch {
      detail = ''
    }
    throw new Error(detail || `attachment upload failed (${response.status})`)
  }
}
