import { useMemo, useRef, useState } from 'react'
import { CheckCircle, Mic, Square, X } from 'lucide-react'
import { isAudioCaptureSupported } from '@/lib/capture-recorder'
import {
  clearLocalCaptureSession,
  currentCaptureRoutePath,
  getActiveCaptureSession,
  startLocalCaptureSession,
} from '@/lib/capture-session'
import { uploadRegisteredCaptureArtifacts } from '@/lib/capture-artifact-providers'
import { createRrwebCaptureReplayRecorder } from '@/lib/capture-replay-recorder'
import {
  FeedbackCaptureController,
  FeedbackCaptureQueuedError,
  type FeedbackCaptureBackend,
} from '@/lib/feedback-capture-controller'
import {
  appendCaptureSessionEvents,
  createCaptureSession,
  discardCaptureSession,
  finalizeCaptureSession,
  uploadCaptureArtifact,
} from '@/lib/api/capture-sessions'

type CaptureState = 'idle' | 'recording' | 'stopping' | 'sent' | 'queued' | 'error'

type AuthenticatedFeedbackDockProps = {
  companySlug: string
}

const CONSENT_VERSION = 'authenticated-feedback-v1'
const ENABLE_STORAGE_KEY = 'sitelayer.auth-feedback-enabled'

function env(name: string): string {
  try {
    return String((import.meta as { env?: Record<string, string> }).env?.[name] || '').trim()
  } catch {
    return ''
  }
}

function flagFromUrl(...names: string[]): string | null {
  try {
    const params = new URLSearchParams(window.location.search)
    for (const name of names) {
      const value = params.get(name)
      if (value !== null) return value
    }
  } catch {
    // Fall through to env/localStorage.
  }
  return null
}

function isTruthyFlag(value: string | null | undefined): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function authenticatedFeedbackEnabled(): boolean {
  const fromUrl = flagFromUrl('capture_feedback', 'captureFeedback', 'record_feedback')
  if (fromUrl !== null) return isTruthyFlag(fromUrl)
  if (isTruthyFlag(env('VITE_AUTH_CAPTURE_FEEDBACK')) || isTruthyFlag(env('VITE_CAPTURE_FEEDBACK'))) return true
  try {
    return isTruthyFlag(window.localStorage.getItem(ENABLE_STORAGE_KEY))
  } catch {
    return false
  }
}

function captureReplayEnabled(): boolean {
  const fromUrl = flagFromUrl('capture_replay', 'captureReplay')
  if (fromUrl !== null) return isTruthyFlag(fromUrl)
  return isTruthyFlag(env('VITE_AUTH_CAPTURE_REPLAY'))
}

function authenticatedBackend(): FeedbackCaptureBackend {
  return {
    startSession: (payload) => createCaptureSession(payload),
    uploadArtifact: uploadCaptureArtifact,
    finalizeSession: finalizeCaptureSession,
    discardSession: async (captureSessionId) => {
      await discardCaptureSession(captureSessionId)
      clearLocalCaptureSession()
    },
  }
}

async function appendFeedbackEvent(
  captureSessionId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await appendCaptureSessionEvents(captureSessionId, [
    {
      client_event_id: `${eventType}:${Date.now()}`,
      event_type: eventType,
      event_class: 'authenticated_feedback',
      route_path: currentCaptureRoutePath(),
      occurred_at: new Date().toISOString(),
      payload,
    },
  ])
}

export function AuthenticatedFeedbackDock({ companySlug }: AuthenticatedFeedbackDockProps) {
  const enabled = authenticatedFeedbackEnabled()
  const replayEnabled = captureReplayEnabled()
  const audioSupported = isAudioCaptureSupported()
  const backend = useMemo(() => authenticatedBackend(), [])
  const controllerRef = useRef<FeedbackCaptureController | null>(null)
  const [state, setState] = useState<CaptureState>('idle')
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!enabled || !companySlug) return null

  async function startRecording() {
    setError(null)
    const active = getActiveCaptureSession()
    if (active?.mode === 'feedback') {
      setState('error')
      setError('Recording is already active.')
      return
    }
    const local = startLocalCaptureSession({
      mode: 'feedback',
      consent_version: CONSENT_VERSION,
    })
    const controller = new FeedbackCaptureController({
      backend,
      offlineQueue: { target: { type: 'authenticated' } },
      replayRecorder: replayEnabled
        ? createRrwebCaptureReplayRecorder({
            upload: backend.uploadArtifact,
          })
        : null,
    })
    controllerRef.current = controller
    try {
      await controller.start({
        capture_session_id: local.id,
        mode: 'feedback',
        consent_version: CONSENT_VERSION,
        route_path: currentCaptureRoutePath(),
        device_kind: inferDeviceKind(),
        platform: inferPlatform(),
        viewport: inferViewport(),
        metadata: {
          surface: 'authenticated_app',
          company_slug: companySlug,
        },
        consent_scope: {
          surface: 'authenticated_app',
          streams: replayEnabled ? ['audio', 'dom_replay'] : ['audio'],
          dom_replay: replayEnabled,
        },
      })
      await appendFeedbackEvent(local.id, 'authenticated.feedback.recording_started').catch(() => undefined)
      setState('recording')
      setOpen(true)
    } catch (err) {
      clearLocalCaptureSession()
      setState('error')
      setError(err instanceof Error ? err.message : 'Recording could not start.')
    }
  }

  async function stopRecording() {
    const controller = controllerRef.current
    const captureSessionId = controller?.activeCaptureSessionId
    if (!controller || !captureSessionId) return
    setState('stopping')
    setError(null)
    const trimmedNote = note.trim()
    await appendFeedbackEvent(captureSessionId, 'authenticated.feedback.recording_stopped', {
      note_length: trimmedNote.length,
    }).catch(() => undefined)
    try {
      await controller.stop({
        title: 'In-app feedback recording',
        summary: trimmedNote || 'Authenticated user recorded feedback.',
        severity: 'normal',
        lane: 'triage',
        route_path: currentCaptureRoutePath(),
        artifact_metadata: {
          surface: 'authenticated_app',
          company_slug: companySlug,
          dom_replay: replayEnabled,
        },
        additional_artifact_uploads: [
          (id, metadata) =>
            uploadRegisteredCaptureArtifacts(id, {
              ...metadata,
              trigger: 'record_feedback_stop',
            }),
        ],
      })
      clearLocalCaptureSession()
      controllerRef.current = null
      setNote('')
      setOpen(false)
      setState('sent')
      window.setTimeout(() => setState('idle'), 4000)
    } catch (err) {
      if (err instanceof FeedbackCaptureQueuedError) {
        clearLocalCaptureSession()
        controllerRef.current = null
        setNote('')
        setOpen(false)
        setState('queued')
        window.setTimeout(() => setState('idle'), 4000)
        return
      }
      setState('error')
      setError(err instanceof Error ? err.message : 'Feedback could not be sent.')
    }
  }

  async function discardRecording() {
    const captureSessionId = controllerRef.current?.activeCaptureSessionId
    if (captureSessionId) {
      await appendFeedbackEvent(captureSessionId, 'authenticated.feedback.recording_discarded').catch(() => undefined)
    }
    try {
      await controllerRef.current?.discard()
      controllerRef.current = null
      clearLocalCaptureSession()
      setNote('')
      setOpen(false)
      setError(null)
      setState('idle')
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'Feedback could not be discarded.')
    }
  }

  if (state === 'sent') {
    return (
      <div style={{ ...dockPositionStyle, ...pillStyle, color: 'var(--m-green)', cursor: 'default' }}>
        <CheckCircle size={16} aria-hidden />
        Feedback sent
      </div>
    )
  }

  if (state === 'queued') {
    return (
      <div style={{ ...dockPositionStyle, ...pillStyle, color: 'var(--m-amber, #b7791f)', cursor: 'default' }}>
        <CheckCircle size={16} aria-hidden />
        Feedback queued
      </div>
    )
  }

  if (!open && state !== 'recording' && state !== 'stopping') {
    return (
      <div style={dockStackStyle}>
        {error ? <div style={errorPillStyle}>{error}</div> : null}
        <button type="button" style={pillStyle} onClick={() => setOpen(true)}>
          <Mic size={16} aria-hidden />
          Record feedback
        </button>
      </div>
    )
  }

  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}>
        <div style={panelTitleStyle}>
          {state === 'recording' ? 'Recording feedback' : state === 'stopping' ? 'Sending feedback' : 'Record feedback'}
        </div>
        <button
          type="button"
          aria-label="Close feedback recorder"
          disabled={state === 'stopping'}
          style={iconButtonStyle}
          onClick={() => (state === 'recording' ? void discardRecording() : setOpen(false))}
        >
          <X size={15} aria-hidden />
        </button>
      </div>

      {state === 'idle' || state === 'error' ? (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened?"
            rows={3}
            style={textareaStyle}
          />
          {error ? <div style={inlineErrorStyle}>{error}</div> : null}
          <div style={actionsStyle}>
            <button type="button" style={secondaryButtonStyle} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" style={primaryButtonStyle} onClick={startRecording} disabled={!audioSupported}>
              <Mic size={14} aria-hidden />
              Start
            </button>
          </div>
        </>
      ) : null}

      {state === 'recording' ? (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Short context"
            rows={2}
            style={textareaStyle}
          />
          <div style={actionsStyle}>
            <button type="button" style={secondaryButtonStyle} onClick={discardRecording}>
              <X size={14} aria-hidden />
              Discard
            </button>
            <button type="button" style={primaryButtonStyle} onClick={stopRecording}>
              <Square size={14} aria-hidden />
              Stop
            </button>
          </div>
        </>
      ) : null}

      {state === 'stopping' ? <div style={mutedStyle}>Uploading...</div> : null}
    </div>
  )
}

const dockPositionStyle: React.CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)',
  zIndex: 9999,
}

const dockStackStyle: React.CSSProperties = {
  ...dockPositionStyle,
  display: 'grid',
  justifyItems: 'end',
  gap: 8,
}

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  borderRadius: 999,
  border: '1px solid var(--m-line, var(--p-line))',
  background: 'var(--m-card, var(--p-paper, #fff))',
  color: 'var(--m-ink, var(--p-ink, #111827))',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  boxShadow: 'var(--p-pill-shadow, 0 8px 24px rgba(15, 23, 42, 0.16))',
}

const errorPillStyle: React.CSSProperties = {
  ...pillStyle,
  maxWidth: 280,
  color: 'var(--m-red, #b42318)',
  cursor: 'default',
}

const panelStyle: React.CSSProperties = {
  ...dockPositionStyle,
  width: 'min(320px, calc(100vw - 32px))',
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  borderRadius: 8,
  border: '1px solid var(--m-line, var(--p-line))',
  background: 'var(--m-card, var(--p-paper, #fff))',
  color: 'var(--m-ink, var(--p-ink, #111827))',
  boxShadow: 'var(--p-pill-shadow, 0 12px 32px rgba(15, 23, 42, 0.2))',
}

const panelHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const panelTitleStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
}

const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  border: '1px solid var(--m-line, var(--p-line))',
  background: 'transparent',
  color: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 13,
  padding: 8,
  borderRadius: 8,
  border: '1px solid var(--m-line, var(--p-line))',
  resize: 'vertical',
}

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
}

const secondaryButtonStyle: React.CSSProperties = {
  borderRadius: 8,
  border: '1px solid var(--m-line, var(--p-line))',
  padding: '7px 10px',
  background: 'transparent',
  color: 'var(--m-ink, var(--p-ink, #111827))',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
}

const primaryButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  background: 'var(--m-accent, var(--p-ink, #111827))',
  color: 'var(--p-paper, #fff)',
}

const inlineErrorStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--m-red, #b42318)',
}

const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--m-ink-3, #667085)',
}

function inferDeviceKind(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  return /ipad|iphone|android|mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
}

function inferPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  return navigator.userAgent.slice(0, 120)
}

function inferViewport(): string {
  if (typeof window === 'undefined') return 'unknown'
  return `${window.innerWidth}x${window.innerHeight}`
}
