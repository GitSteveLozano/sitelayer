import { useMemo, useRef, useState } from 'react'
import { CheckCircle, Mic, Square, X } from 'lucide-react'
import { resolveCaptureCapabilities } from '@/lib/capture-capabilities'
import { buildPortalFeedbackConsentScope } from '@/lib/capture-policy'
import { captureErrorMessage } from '@/lib/capture-error-copy'
import { clearLocalCaptureSession, currentCaptureRoutePath, startLocalCaptureSession } from '@/lib/capture-session'
import { uploadRegisteredCaptureStateSnapshots } from '@/lib/capture-state-providers'
import { createRrwebCaptureReplayRecorder } from '@/lib/capture-replay-recorder'
import {
  FeedbackCaptureController,
  FeedbackCaptureQueuedError,
  type FeedbackCaptureBackend,
} from '@/lib/feedback-capture-controller'
import {
  appendPortalEstimateCaptureEvents,
  appendPortalRentalCaptureEvents,
  discardPortalEstimateCaptureSession,
  discardPortalRentalCaptureSession,
  finalizePortalEstimateCaptureSession,
  finalizePortalRentalCaptureSession,
  startPortalEstimateCaptureSession,
  startPortalRentalCaptureSession,
  uploadPortalEstimateCaptureArtifact,
  uploadPortalRentalCaptureArtifact,
} from './api'

type PortalFeedbackSurface = 'estimate_portal' | 'rental_portal'
type CaptureState = 'idle' | 'recording' | 'stopping' | 'sent' | 'queued' | 'error'

type PortalFeedbackRecorderProps = {
  surface: PortalFeedbackSurface
  shareToken: string
}

const CONSENT_VERSION = 'portal-feedback-v1'

function env(name: string): string {
  try {
    return String((import.meta as { env?: Record<string, string> }).env?.[name] || '').trim()
  } catch {
    return ''
  }
}

function inviteToken(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('capture_invite')
    return (fromUrl || env('VITE_CAPTURE_INVITE') || '').trim()
  } catch {
    return env('VITE_CAPTURE_INVITE')
  }
}

function captureReplayEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('capture_replay') ?? params.get('captureReplay')
    if (fromUrl !== null) return isTruthyFlag(fromUrl)
  } catch {
    // Fall through to env flag.
  }
  return isTruthyFlag(env('VITE_CAPTURE_REPLAY'))
}

function isTruthyFlag(value: string | null | undefined): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function portalBackend(surface: PortalFeedbackSurface, shareToken: string): FeedbackCaptureBackend {
  if (surface === 'estimate_portal') {
    return {
      startSession: (payload) => startPortalEstimateCaptureSession(shareToken, payload),
      uploadArtifact: (captureSessionId, input) =>
        uploadPortalEstimateCaptureArtifact(shareToken, captureSessionId, input),
      finalizeSession: (captureSessionId, input) =>
        finalizePortalEstimateCaptureSession(shareToken, captureSessionId, input),
      discardSession: async (captureSessionId, input) => {
        if (captureSessionId) await discardPortalEstimateCaptureSession(shareToken, captureSessionId, input)
        clearLocalCaptureSession()
      },
    }
  }
  return {
    startSession: (payload) => startPortalRentalCaptureSession(shareToken, payload),
    uploadArtifact: (captureSessionId, input) => uploadPortalRentalCaptureArtifact(shareToken, captureSessionId, input),
    finalizeSession: (captureSessionId, input) =>
      finalizePortalRentalCaptureSession(shareToken, captureSessionId, input),
    discardSession: async (captureSessionId, input) => {
      if (captureSessionId) await discardPortalRentalCaptureSession(shareToken, captureSessionId, input)
      clearLocalCaptureSession()
    },
  }
}

function uploadPortalStateProviderArtifact(
  surface: PortalFeedbackSurface,
  shareToken: string,
): FeedbackCaptureBackend['uploadArtifact'] {
  if (surface === 'estimate_portal') {
    return (captureSessionId, input) => uploadPortalEstimateCaptureArtifact(shareToken, captureSessionId, input)
  }
  return (captureSessionId, input) => uploadPortalRentalCaptureArtifact(shareToken, captureSessionId, input)
}

async function appendPortalFeedbackEvent(
  surface: PortalFeedbackSurface,
  shareToken: string,
  captureSessionId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const event = {
    client_event_id: `${eventType}:${Date.now()}`,
    event_type: eventType,
    event_class: 'portal_feedback',
    route_path: currentCaptureRoutePath(),
    occurred_at: new Date().toISOString(),
    payload,
  }
  const append = surface === 'estimate_portal' ? appendPortalEstimateCaptureEvents : appendPortalRentalCaptureEvents
  await append(shareToken, captureSessionId, [event])
}

export function IssueReporter({ surface, shareToken }: PortalFeedbackRecorderProps) {
  const invite = inviteToken()
  const enabled = Boolean(invite) && Boolean(shareToken)
  const audioSupported = resolveCaptureCapabilities().audio
  const replayEnabled = captureReplayEnabled()
  const backend = useMemo(() => portalBackend(surface, shareToken), [surface, shareToken])
  const controllerRef = useRef<FeedbackCaptureController | null>(null)
  const [state, setState] = useState<CaptureState>('idle')
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!enabled) return null

  async function startRecording() {
    setError(null)
    const local = startLocalCaptureSession({
      mode: 'feedback',
      consent_version: CONSENT_VERSION,
    })
    const controller = new FeedbackCaptureController({
      backend,
      offlineQueue: { target: { type: 'portal', portal_surface: surface, share_token: shareToken } },
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
          portal_surface: surface,
          capture_invite_present: true,
        },
        consent_scope: buildPortalFeedbackConsentScope({ surface, domReplay: replayEnabled }),
      })
      await appendPortalFeedbackEvent(surface, shareToken, local.id, 'portal.feedback.recording_started').catch(
        () => undefined,
      )
      setState('recording')
      setOpen(true)
    } catch (err) {
      clearLocalCaptureSession()
      setState('error')
      setError(captureErrorMessage(err, 'Recording could not start.'))
    }
  }

  async function stopRecording() {
    const controller = controllerRef.current
    const captureSessionId = controller?.activeCaptureSessionId
    if (!controller || !captureSessionId) return
    setState('stopping')
    setError(null)
    await appendPortalFeedbackEvent(surface, shareToken, captureSessionId, 'portal.feedback.recording_stopped', {
      note_length: note.trim().length,
    }).catch(() => undefined)
    try {
      const trimmedNote = note.trim()
      await controller.stop({
        ...(trimmedNote ? { title: 'Portal feedback recording' } : {}),
        summary: trimmedNote || 'Portal visitor recorded feedback.',
        severity: 'normal',
        route_path: currentCaptureRoutePath(),
        artifact_metadata: {
          portal_surface: surface,
          dom_replay: replayEnabled,
        },
        additional_artifact_uploads: [
          (id, metadata) =>
            uploadRegisteredCaptureStateSnapshots(id, {
              reason: 'recording_stopped',
              metadata: {
                ...metadata,
                trigger: 'portal_feedback_stop',
              },
              upload: uploadPortalStateProviderArtifact(surface, shareToken),
            }),
        ],
      })
      clearLocalCaptureSession()
      controllerRef.current = null
      setNote('')
      setOpen(false)
      setState('sent')
      setTimeout(() => setState('idle'), 4000)
    } catch (err) {
      if (err instanceof FeedbackCaptureQueuedError) {
        clearLocalCaptureSession()
        controllerRef.current = null
        setNote('')
        setOpen(false)
        setState('queued')
        setTimeout(() => setState('idle'), 4000)
        return
      }
      setState('error')
      setError(captureErrorMessage(err, 'Feedback could not be sent.'))
    }
  }

  async function discardRecording() {
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
      setError(captureErrorMessage(err, 'Feedback could not be discarded.'))
    }
  }

  const pill: React.CSSProperties = {
    position: 'fixed',
    left: 16,
    bottom: 16,
    zIndex: 9999,
    padding: '10px 14px',
    borderRadius: 999,
    border: '1px solid var(--m-line, var(--p-line))',
    background: 'var(--m-card, var(--p-paper))',
    color: 'var(--m-ink, var(--p-ink))',
    fontSize: 13,
    cursor: 'pointer',
    boxShadow: 'var(--p-pill-shadow)',
  }

  if (state === 'sent') {
    return (
      <div style={{ ...pill, display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--m-green)' }}>
        <CheckCircle size={16} aria-hidden />
        Feedback sent
      </div>
    )
  }

  if (state === 'queued') {
    return (
      <div style={{ ...pill, display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--m-amber, #b7791f)' }}>
        <CheckCircle size={16} aria-hidden />
        Feedback queued
      </div>
    )
  }

  if (!open && state !== 'recording' && state !== 'stopping') {
    return (
      <div style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 9999, display: 'grid', gap: 8 }}>
        {error ? (
          <div style={{ ...pill, position: 'static', maxWidth: 280, color: 'var(--m-red)' }}>{error}</div>
        ) : null}
        <button
          type="button"
          style={{ ...pill, position: 'static', display: 'inline-flex', alignItems: 'center', gap: 8 }}
          onClick={() => setOpen(true)}
        >
          <Mic size={16} aria-hidden />
          Record feedback
        </button>
      </div>
    )
  }

  return (
    <div
      style={{ ...pill, width: 300, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, cursor: 'default' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          {state === 'recording' ? 'Recording feedback' : state === 'stopping' ? 'Sending feedback' : 'Record feedback'}
        </div>
        <button
          type="button"
          aria-label="Close"
          disabled={state === 'stopping'}
          style={iconButton}
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
            placeholder="What should we look at?"
            rows={3}
            style={{
              width: '100%',
              fontSize: 13,
              padding: 8,
              borderRadius: 8,
              border: '1px solid var(--m-line, var(--p-line))',
              resize: 'vertical',
            }}
          />
          {error ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{error}</div> : null}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" style={secondaryButton} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" style={primaryButton} onClick={startRecording} disabled={!audioSupported}>
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
            style={{
              width: '100%',
              fontSize: 13,
              padding: 8,
              borderRadius: 8,
              border: '1px solid var(--m-line, var(--p-line))',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" style={secondaryButton} onClick={discardRecording}>
              <X size={14} aria-hidden />
              Discard
            </button>
            <button type="button" style={primaryButton} onClick={stopRecording}>
              <Square size={14} aria-hidden />
              Stop
            </button>
          </div>
        </>
      ) : null}

      {state === 'stopping' ? <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>Uploading…</div> : null}
    </div>
  )
}

const iconButton: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  border: '1px solid var(--m-line, var(--p-line))',
  background: 'transparent',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
}

const secondaryButton: React.CSSProperties = {
  borderRadius: 8,
  border: '1px solid var(--m-line, var(--p-line))',
  padding: '7px 10px',
  background: 'transparent',
  color: 'var(--m-ink, var(--p-ink))',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
}

const primaryButton: React.CSSProperties = {
  ...secondaryButton,
  background: 'var(--m-accent, var(--p-ink))',
  color: 'var(--p-paper)',
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
