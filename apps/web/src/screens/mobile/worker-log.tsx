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

  const retake = () => {
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setNote('')
    setFile(null)
    setError(null)
    // Re-open the camera straight away — capture flow chains.
    inputRef.current?.click()
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

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#000',
        overflow: 'hidden',
      }}
    >
      {/* Hidden native-camera input. The whole viewfinder taps into this. */}
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

      {/* Full-bleed viewfinder. Before capture it's a tappable dark
          surface that opens the camera; after capture it shows the shot,
          dimmed so the slide-up note reads on top. */}
      <button
        type="button"
        onClick={() => {
          if (!preview) inputRef.current?.click()
        }}
        aria-label={preview ? 'Captured photo' : 'Open camera'}
        style={{
          position: 'absolute',
          inset: 0,
          padding: 0,
          border: 'none',
          background: preview ? '#000' : 'radial-gradient(circle at 50% 38%, #2a2420 0%, #14110d 70%, #0a0806 100%)',
          color: 'var(--m-ink-3)',
          cursor: preview ? 'default' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {preview ? (
          <img
            src={preview}
            alt="Captured"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: 0.55,
              transition: 'opacity 0.2s ease',
            }}
          />
        ) : (
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, opacity: 0.7 }}>
            <MI.Camera size={40} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>Tap to open camera</span>
          </span>
        )}
      </button>

      {/* Top overlay strip — close / title / flash / flip. Flash and flip
          are presentational only; the native camera owns those controls. */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
        }}
      >
        <ViewfinderIconButton label="Close" onClick={() => navigate('/today')}>
          <MI.X size={20} />
        </ViewfinderIconButton>
        <div style={{ flex: 1, textAlign: 'center', color: '#fff', fontSize: 15, fontWeight: 600 }}>Log photo</div>
        <ViewfinderIconButton label="Toggle flash" disabled>
          <MI.AlertTri size={18} />
        </ViewfinderIconButton>
        <ViewfinderIconButton label="Flip camera" disabled>
          <MI.Camera size={18} />
        </ViewfinderIconButton>
      </div>

      {/* Auto-tag chip — what the system already knows we're shooting. */}
      <div style={{ position: 'relative', zIndex: 2, display: 'flex', justifyContent: 'center', padding: '0 16px' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 999,
            background: 'rgba(217,144,74,0.92)',
            backdropFilter: 'blur(8px)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <Spark state="strong" size={13} />
          <span>
            {projectName}
            {activeStep ? ` · ${activeStep.title}` : ''} · auto-tagged
          </span>
        </div>
      </div>

      {/* Step picker — tag the shot to a scope step before capturing. */}
      {steps.length > 0 && !preview ? (
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            marginTop: 10,
            padding: '0 16px',
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

      <div style={{ flex: 1 }} />

      {/* Bottom controls — pre-capture: roll thumb · 72px shutter · note.
          post-capture: slide-up note + send. */}
      {preview ? (
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            background: 'var(--m-card)',
            borderTop: '1px solid var(--m-line)',
            padding: '14px 16px 18px',
            animation: 'mSlideUp 0.22s ease-out',
          }}
        >
          <div className="m-topbar-eyebrow" style={{ marginBottom: 8 }}>
            Add a note (optional)
          </div>
          <MTextarea
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            placeholder="Add a note — optional"
            autoFocus
            style={{ width: '100%', minHeight: 64 }}
          />
          {error ? <div style={{ marginTop: 10, color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <MButton variant="primary" onClick={handleSend} disabled={busy || !projectId}>
                {busy ? 'Sending…' : 'Send to daily log'}
              </MButton>
            </div>
            <ViewfinderIconButton label="Retake" onClick={retake} solid>
              <MI.Camera size={18} />
            </ViewfinderIconButton>
          </div>
        </div>
      ) : (
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 28px 28px',
          }}
        >
          {/* Roll thumbnail — last shot, or an empty frame. */}
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(255,255,255,0.06)',
            }}
            aria-hidden
          />
          {/* 72px capture button — white ring, accent inner fill. */}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            aria-label="Capture photo"
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              border: '4px solid #fff',
              background: 'var(--m-accent)',
              padding: 0,
              cursor: 'pointer',
              boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
            }}
          />
          {/* Note shortcut — opens the camera then the note flow. */}
          <ViewfinderIconButton label="Add a note" onClick={() => inputRef.current?.click()}>
            <MI.FileText size={20} />
          </ViewfinderIconButton>
        </div>
      )}

      <style>{`@keyframes mSlideUp { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
    </div>
  )
}

/** Round icon button used in the viewfinder overlay. `solid` gives a
 *  filled background (the retake control); default is a translucent
 *  glassy circle that reads on top of the photo. */
function ViewfinderIconButton({
  children,
  label,
  onClick,
  disabled,
  solid,
}: {
  children: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  solid?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 44,
        height: 44,
        flexShrink: 0,
        borderRadius: '50%',
        border: 'none',
        background: solid ? 'var(--m-card-soft)' : 'rgba(0,0,0,0.45)',
        backdropFilter: solid ? undefined : 'blur(8px)',
        color: '#fff',
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
        borderRadius: 999,
        border: '1px solid var(--m-line-2)',
        background: active ? 'var(--m-accent-1, #d9904a)' : 'var(--m-surf-2, transparent)',
        color: active ? '#fff' : 'var(--m-ink-2)',
        fontSize: 12,
        fontWeight: 600,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}
