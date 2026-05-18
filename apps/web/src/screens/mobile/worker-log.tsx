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
import { MBody, MButton, MButtonStack, MI, MInput, MTapCard, MTextarea, MTopBar } from '../../components/m/index.js'
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
    setPreview(URL.createObjectURL(f))
  }

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
    <>
      <MTopBar back title="Log photo" onBack={() => navigate('/today')} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            background: '#1a160f',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--m-ink-3)',
            overflow: 'hidden',
          }}
        >
          {preview ? (
            <img src={preview} alt="Captured" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <MTapCard
              onClick={() => inputRef.current?.click()}
              style={{
                background: 'transparent',
                border: '2px dashed var(--m-line-2)',
                color: 'var(--m-ink-3)',
                borderRadius: 18,
                padding: '40px 28px',
                width: 'auto',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <MI.Camera size={36} />
              <span style={{ fontSize: 14, fontWeight: 500 }}>Tap to capture</span>
            </MTapCard>
          )}
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              right: 12,
              padding: '6px 12px',
              borderRadius: 999,
              background: 'rgba(217,144,74,0.92)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ width: 6, height: 6, background: '#fff', borderRadius: '50%' }} />
            {projectName} · auto-tagged
            {activeStep ? <span style={{ opacity: 0.85 }}>· {activeStep.title}</span> : null}
          </div>
        </div>
        {steps.length > 0 ? (
          <div
            style={{
              padding: '10px 16px 4px',
              display: 'flex',
              gap: 8,
              overflowX: 'auto',
              borderBottom: '1px solid var(--m-line-2)',
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
        <MBody pad>
          <MInput
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0]
              if (f) handleFile(f)
            }}
            style={{ display: 'none' }}
          />
          {preview ? (
            <>
              <MTextarea
                value={note}
                onChange={(e) => setNote(e.currentTarget.value)}
                placeholder="Add a note — optional"
                style={{ width: '100%', minHeight: 80 }}
              />
              {error ? <div style={{ marginTop: 12, color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
              <div style={{ marginTop: 12 }}>
                <MButtonStack>
                  <MButton variant="primary" onClick={handleSend} disabled={busy || !projectId}>
                    {busy ? 'Sending…' : 'Send to daily log'}
                  </MButton>
                  <MButton
                    variant="ghost"
                    onClick={() => {
                      setPreview(null)
                      setNote('')
                      setFile(null)
                    }}
                  >
                    Retake
                  </MButton>
                </MButtonStack>
              </div>
            </>
          ) : null}
        </MBody>
      </div>
    </>
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
