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
 * Severity, voice notes, and photo attachments are best-effort:
 * - Severity (`question | slowing | stopped`) is appended to the message
 *   body as a `[severity:slowing]` tag until the schema gets a column.
 * - Voice: captured via MediaRecorder; sent as base64 in the optional
 *   `voice_data_url` field. The current backend ignores the field — this
 *   is a forward-compatible no-op until POST /api/worker-issues accepts
 *   multipart bodies. TODO: revisit once a multipart route lands.
 * - Photo: captured via <input type=file capture=environment>; sent the
 *   same way in `photo_data_url`. Same TODO applies.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, type BootstrapResponse } from '../../api-v1-compat.js'
import {
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

export function WorkerIssue({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const [category, setCategory] = useState<IssueCategory | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [severity, setSeverity] = useState<Severity>('question')
  const [voice, setVoice] = useState<{ blob: Blob; url: string; durationMs: number } | null>(null)
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null)

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
    try {
      const trimmed = message.trim() || `${category.label}: ${category.sub}`
      const tags = [`[${category.designKind}]`, `[severity:${severity}]`].filter(Boolean).join(' ')
      const body: Record<string, unknown> = {
        kind: category.kind,
        message: `${tags} ${trimmed}`.trim(),
      }
      if (projectId) body.project_id = projectId
      if (voice) {
        // Forward-compatible: backend ignores unknown fields today, so
        // this is a soft-launch path. TODO: switch to multipart once the
        // route accepts a `voice_file` part.
        body.voice_data_url = await blobToDataUrl(voice.blob)
        body.voice_duration_ms = voice.durationMs
      }
      if (photo) {
        body.photo_data_url = await fileToDataUrl(photo.file)
      }
      await apiPost('/api/worker-issues', body, companySlug)
      navigate('/today')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
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
          {error ? <div style={{ marginTop: 12, color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
          <div style={{ marginTop: 16 }}>
            <MButtonStack>
              <MButton variant="primary" onClick={handleSend} disabled={busy}>
                {busy ? 'Sending…' : 'Send to foreman'}
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

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '')
    r.onerror = () => reject(r.error ?? new Error('failed to read blob'))
    r.readAsDataURL(blob)
  })
}

async function fileToDataUrl(file: File): Promise<string> {
  return blobToDataUrl(file)
}
