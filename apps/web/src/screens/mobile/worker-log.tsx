/**
 * Photo + note logger — `wk-log`. Camera-first capture surface; auto-tags
 * the photo by geofence (project) + active scope step. Uploads to the
 * existing daily-log photos endpoint via `useUploadDailyLogPhoto` and
 * `useCreateDailyLog` (apps/web/src/lib/api/daily-logs.ts).
 *
 * Flow:
 *   1. Capture a photo via <input capture="environment">.
 *   2. Find or lazily create today's daily log for the active project
 *      (POST /api/daily-logs creates an empty log if none exists).
 *   3. Upload the photo (POST /api/daily-logs/:id/photos).
 *   4. PATCH the daily log to append the note to `notes` if the worker
 *      typed one.
 *
 * If the daily-log routes aren't reachable (network offline, role
 * permission denied), surface the error inline so the worker can retry.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { MButton, MI, MInput, MTextarea, Spark } from '../../components/m/index.js'
import { fetchDailyLogs, patchDailyLog, useCreateDailyLog, useUploadDailyLogPhoto } from '../../lib/api/daily-logs.js'
import { useProjectBriefs } from '../../lib/api/projects.js'
import type { ProjectBriefStep } from '../../lib/api/project-briefs.js'
import { todayIso } from './format.js'

export function WorkerLog({
  bootstrap,
}: {
  bootstrap: BootstrapResponse | null
  /** Accepted for compatibility with the mobile-shell routing — TanStack
   *  hooks read the active slug from the request client. */
  companySlug?: string
}) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const projectId = useMemo(
    () => bootstrap?.projects.find((p) => /progress|active/i.test(p.status))?.id ?? null,
    [bootstrap?.projects],
  )
  const projectName = useMemo(
    () => bootstrap?.projects.find((p) => p.id === projectId)?.name ?? 'this site',
    [bootstrap?.projects, projectId],
  )

  // Lazily-resolved daily-log id. We fetch existing logs for today on
  // mount so we attach to the foreman's log instead of creating a
  // duplicate. If none exists we'll create one on send.
  const [dailyLogId, setDailyLogId] = useState<string | null>(null)
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    fetchDailyLogs({ projectId, from: todayIso(), to: todayIso() })
      .then((res) => {
        if (cancelled) return
        const log = res.dailyLogs[0]
        if (log) setDailyLogId(log.id)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [projectId])

  // Today's brief steps for the active project. Workers tap a step
  // chip before capturing so the photo lands in the right timeline
  // bucket on `fm-log`. Untapped uploads still work — they fall into
  // the foreman screen's "untagged" bucket.
  const briefs = useProjectBriefs(projectId ?? null, todayIso())
  const steps = useMemo<ProjectBriefStep[]>(() => {
    const first = briefs.data?.briefs?.[0]
    if (!first) return []
    return Array.isArray(first.steps) ? (first.steps as ProjectBriefStep[]) : []
  }, [briefs.data?.briefs])
  const [activeStepId, setActiveStepId] = useState<string | null>(null)
  const activeStep = useMemo(() => steps.find((s) => s.id && s.id === activeStepId) ?? null, [steps, activeStepId])

  const createDailyLog = useCreateDailyLog()
  const uploadPhoto = useUploadDailyLogPhoto(dailyLogId ?? '')

  const handleFile = (f: File) => {
    setFile(f)
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return URL.createObjectURL(f)
    })
  }

  // Revoke the object URL when it changes or the screen unmounts (avoids leaks).
  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview)
  }, [preview])

  const handleSend = async () => {
    if (!file || !projectId) return
    setBusy(true)
    setError(null)
    try {
      let logId = dailyLogId
      if (!logId) {
        const created = await createDailyLog.mutateAsync({ project_id: projectId, occurred_on: todayIso() })
        // createDailyLog can resolve with `{ queued: true }` when the
        // call was enqueued for offline replay. In that case we don't
        // have a server-assigned daily-log id yet, so the photo upload
        // can't proceed today — surface a friendly error and stop.
        if ('queued' in created) {
          setError("You're offline — your log was queued. Try sending the photo when reconnected.")
          return
        }
        logId = created.dailyLog.id
        setDailyLogId(logId)
      }
      const photoMeta = {
        scope_step_id: activeStep?.id ?? null,
        scope_step_label: activeStep?.title ?? null,
      }
      // useUploadDailyLogPhoto closes over the id at hook construction;
      // when we lazily created the log above, fall back to the helper
      // function so the upload targets the right id.
      if (logId === dailyLogId) {
        await uploadPhoto.mutateAsync({ file, ...photoMeta })
      } else {
        const { uploadDailyLogPhoto } = await import('../../lib/api/daily-logs.js')
        await uploadDailyLogPhoto(logId, file, photoMeta)
      }
      const trimmed = note.trim()
      if (trimmed) {
        await patchDailyLog(logId, { notes: trimmed })
      }
      navigate('/today')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const autoTagLabel = `${projectName}${activeStep ? ` · ${activeStep.title}` : ''}`

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--m-bg)',
        color: 'var(--m-ink)',
        overflow: 'hidden',
      }}
    >
      {/* Hidden native-camera input. The whole capture area taps into this. */}
      <MInput
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0]
          if (f) handleFile(f)
          // Reset so re-selecting the same file still fires onChange.
          e.currentTarget.value = ''
        }}
        style={{ display: 'none' }}
      />

      {/* App bar — brutalist close + mono title. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          borderBottom: '2px solid var(--m-line)',
        }}
      >
        <ViewfinderIconButton label="Close" onClick={() => navigate('/today')}>
          <MI.X size={20} />
        </ViewfinderIconButton>
        <div
          className="m-topbar-eyebrow"
          style={{ flex: 1, fontSize: 13, color: 'var(--m-ink)', letterSpacing: '0.08em' }}
        >
          NEW PHOTO
        </div>
      </div>

      {/* Full-bleed photo capture area. Before capture it's a tappable
          surface that opens the camera; after capture it shows the shot
          full-frame. The hi-vis AUTO-TAGGED chip overlays the top. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
          borderBottom: '2px solid var(--m-line-2)',
        }}
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label={preview ? 'Retake photo' : 'Open camera'}
          style={{
            position: 'absolute',
            inset: 0,
            padding: 0,
            border: 'none',
            background: 'var(--m-card-soft)',
            color: 'var(--m-ink-3)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {preview ? (
            <img src={preview} alt="Captured" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 12,
                color: 'var(--m-ink-4)',
              }}
            >
              <MI.Camera size={44} />
              <span className="m-topbar-eyebrow" style={{ fontSize: 11, color: 'var(--m-ink-4)' }}>
                TAP TO OPEN CAMERA
              </span>
            </span>
          )}
        </button>

        {/* Hi-vis auto-tag overlay — what the system already knows we're
            shooting. Yellow block, ink border, mono micro-label. */}
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: 16,
            right: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            border: '2px solid var(--m-ink)',
          }}
        >
          <span
            style={{ width: 12, height: 12, flexShrink: 0, background: 'var(--m-accent-ink)', display: 'inline-flex' }}
            aria-hidden
          >
            <Spark state="strong" size={12} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontWeight: 700,
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              AUTO-TAGGED
            </div>
            <div
              style={{
                fontFamily: 'var(--m-font-display)',
                fontWeight: 700,
                fontSize: 15,
                marginTop: 2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {autoTagLabel}
            </div>
          </div>
        </div>

        {/* Step picker — tag the shot to a scope step before capturing. */}
        {steps.length > 0 && !preview ? (
          <div
            style={{
              position: 'absolute',
              left: 16,
              right: 16,
              bottom: 16,
              display: 'flex',
              gap: 8,
              overflowX: 'auto',
            }}
          >
            <ScopeStepChip label="Untagged" active={activeStepId === null} onClick={() => setActiveStepId(null)} />
            {steps.map((step, idx) => {
              const stepId = step.id ?? null
              return (
                <ScopeStepChip
                  key={stepId ?? idx}
                  label={step.title || `Step ${idx + 1}`}
                  active={stepId !== null && stepId === activeStepId}
                  onClick={() => stepId && setActiveStepId(stepId)}
                  disabled={!stepId}
                />
              )
            })}
          </div>
        ) : null}
      </div>

      {/* Note field — mono micro-label + bordered surface. */}
      <div style={{ padding: '14px 20px 8px' }}>
        <div className="m-topbar-eyebrow" style={{ color: 'var(--m-ink-4)', marginBottom: 8 }}>
          NOTE (OPTIONAL)
        </div>
        <MTextarea
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          placeholder="Add a note — optional"
          style={{ width: '100%', minHeight: 64 }}
        />
        {error ? (
          <div style={{ marginTop: 10, fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-red)' }}>{error}</div>
        ) : null}
      </div>

      {/* Bottom controls — gloved 64px voice button + SAVE primary. The
          camera/retake action lives on the photo area; voice is the
          secondary attach affordance. */}
      <div style={{ padding: '12px 20px 20px', display: 'flex', gap: 10 }}>
        <ViewfinderIconButton label="Voice note" onClick={() => inputRef.current?.click()} solid size={64}>
          <MI.Mic size={22} />
        </ViewfinderIconButton>
        <div style={{ flex: 1 }}>
          <MButton variant="primary" data-size="worker" onClick={handleSend} disabled={busy || !projectId}>
            {busy ? 'SAVING…' : 'SAVE TO LOG'}
          </MButton>
        </div>
      </div>
    </div>
  )
}

/** Square brutalist icon button. `solid` inverts to the ink fill (the
 *  gloved 64px voice control); default is an outlined square that reads
 *  in the app bar. `size` sets the square edge in px (default 44). */
function ViewfinderIconButton({
  children,
  label,
  onClick,
  disabled,
  solid,
  size = 44,
}: {
  children: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  solid?: boolean
  size?: number
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        border: '2px solid var(--m-ink)',
        background: solid ? 'var(--m-ink)' : 'var(--m-bg)',
        color: solid ? 'var(--m-bg)' : 'var(--m-ink)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}

/** Compact pill used in the wk-log step picker. Active steps render in
 *  the accent tone; disabled (no persisted id) chips hint that the
 *  brief step is still pending a save and can't be tagged yet. */
function ScopeStepChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flexShrink: 0,
        padding: '6px 12px',
        border: '2px solid var(--m-ink)',
        background: active ? 'var(--m-accent)' : 'var(--m-bg)',
        color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
        fontFamily: 'var(--m-num)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}
