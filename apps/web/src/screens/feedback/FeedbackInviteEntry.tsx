import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertCircle, CheckCircle, Loader2, Mic, ScreenShare, Send, ShieldCheck, Square } from 'lucide-react'
import { currentCaptureRoutePath } from '@/lib/capture-session'
import { resolveCaptureCapabilities } from '@/lib/capture-capabilities'
import { ScreenCaptureRecorder } from '@/lib/capture-recorder'
import { FeedbackCaptureController, type FeedbackCaptureBackend } from '@/lib/feedback-capture-controller'
import {
  uploadRegisteredCaptureStateSnapshots,
  type CaptureStateSnapshotReason,
} from '@/lib/capture-state-providers'
import {
  appendFeedbackInviteCaptureEvents,
  discardFeedbackInviteCaptureSession,
  finalizeFeedbackInviteCaptureSession,
  PortalApiError,
  resolveFeedbackInvite,
  startFeedbackInviteCaptureSession,
  uploadFeedbackInviteCaptureArtifact,
  type FeedbackInviteView,
} from '@/portal/api'

type LoadState =
  | { status: 'loading'; token: string }
  | { status: 'ready'; token: string; invite: FeedbackInviteView }
  | { status: 'missing' }
  | { status: 'error'; message: string }

type SubmitState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'recording'; captureSessionId: string; kind: 'audio' | 'screen' }
  | { status: 'stopping' }
  | { status: 'sent'; workItemId: string; supportPacketId: string }
  | { status: 'error'; message: string }

const CONSENT_VERSION = 'feedback-invite-v1'

function readAndStripToken(): string | null {
  const url = new URL(window.location.href)
  const token = url.searchParams.get('token')?.trim() || null
  if (token) {
    url.searchParams.delete('token')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }
  return token
}

function errorMessage(error: unknown): string {
  if (error instanceof PortalApiError) return error.message_for_user()
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function routeForInvite(invite: FeedbackInviteView): string {
  if (invite.target_route?.startsWith('/')) return invite.target_route
  return currentCaptureRoutePath()
}

function newCaptureSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const suffix = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(12, '0').slice(0, 12)
  return `00000000-0000-4000-8000-${suffix}`
}

function selectedCaptureModes(
  includeState: boolean,
  allowedModes: Set<string>,
  includeAudio = false,
  includeScreen = false,
): string[] {
  return [
    'text',
    ...(includeAudio && allowedModes.has('audio') ? ['audio'] : []),
    ...(includeScreen && allowedModes.has('screen') ? ['screen'] : []),
    ...(includeState && allowedModes.has('state') ? ['state'] : []),
  ]
}

function feedbackInviteConsentScope(invite: FeedbackInviteView, modes: string[]): Record<string, unknown> {
  const includeAudio = modes.includes('audio')
  const includeScreen = modes.includes('screen')
  const includeState = modes.includes('state')
  return {
    surface: 'feedback_invite',
    allowed_capture_modes: invite.allowed_capture_modes,
    selected_capture_modes: modes,
    streams: [
      'text_note',
      ...(includeAudio ? ['audio'] : []),
      ...(includeScreen ? ['screen_video'] : []),
      ...(includeState ? ['registered_artifacts'] : []),
    ],
    artifacts: {
      audio: includeAudio,
      transcript: includeAudio,
      text_note: true,
      video: includeScreen,
      video_clip_manifest: includeScreen,
      state_snapshot: includeState,
      screen_context: includeState,
    },
    event_classes: ['feedback_invite'],
    audio: includeAudio,
    screen_video: includeScreen,
    text_note: true,
    registered_artifacts: includeState,
  }
}

function feedbackInviteStateBlob(args: {
  invite: FeedbackInviteView
  routePath: string
  noteLength: number
  captureSessionId: string
}): Blob {
  return new Blob(
    [
      JSON.stringify(
        {
          schema_version: 1,
          artifact_type: 'capture.state_snapshot',
          captured_at: new Date().toISOString(),
          source: 'feedback_invite_page',
          capture_session_id: args.captureSessionId,
          route_path: args.routePath,
          invite: {
            id: args.invite.id,
            company_slug: args.invite.company_slug,
            reviewer_ref: args.invite.reviewer_ref,
            source: args.invite.source,
            target_route: args.invite.target_route,
            allowed_capture_modes: args.invite.allowed_capture_modes,
          },
          browser: {
            user_agent: navigator.userAgent,
            language: navigator.language,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            screen: { width: window.screen.width, height: window.screen.height },
            device_pixel_ratio: window.devicePixelRatio,
          },
          form: {
            note_length: args.noteLength,
          },
        },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  )
}

function feedbackInviteBackend(token: string): FeedbackCaptureBackend {
  return {
    startSession: (payload) => startFeedbackInviteCaptureSession(token, payload),
    uploadArtifact: (captureSessionId, input) => uploadFeedbackInviteCaptureArtifact(token, captureSessionId, input),
    finalizeSession: (captureSessionId, input) =>
      finalizeFeedbackInviteCaptureSession(token, captureSessionId, input ?? {}),
    discardSession: (captureSessionId) => discardFeedbackInviteCaptureSession(token, captureSessionId),
  }
}

function uploadFeedbackInviteStateArtifact(args: {
  token: string
  captureSessionId: string
  invite: FeedbackInviteView
  routePath: string
  noteLength: number
  trigger: string
}): Promise<unknown> {
  return uploadFeedbackInviteCaptureArtifact(args.token, args.captureSessionId, {
    kind: 'state_snapshot',
    file: feedbackInviteStateBlob(args),
    fileName: 'feedback-invite-state.json',
    pii_level: 'internal',
    access_policy: 'support_only',
    metadata: {
      source: 'feedback_invite_page',
      artifact_type: 'capture.state_snapshot',
      trigger: args.trigger,
      route_path: args.routePath,
      feedback_invite_id: args.invite.id,
    },
  })
}

async function uploadFeedbackInviteStateArtifacts(args: {
  token: string
  captureSessionId: string
  invite: FeedbackInviteView
  routePath: string
  noteLength: number
  reason: CaptureStateSnapshotReason
  trigger: string
}): Promise<unknown[]> {
  const pageSnapshot = await uploadFeedbackInviteStateArtifact(args)
  const providerSnapshots = await uploadRegisteredCaptureStateSnapshots(args.captureSessionId, {
    reason: args.reason,
    metadata: {
      source: 'feedback_invite_page',
      surface: 'feedback_invite',
      trigger: args.trigger,
      route_path: args.routePath,
      feedback_invite_id: args.invite.id,
      reviewer_ref: args.invite.reviewer_ref,
      target_route: args.invite.target_route,
    },
    upload: (captureSessionId, input) => uploadFeedbackInviteCaptureArtifact(args.token, captureSessionId, input),
  })
  return [pageSnapshot, ...providerSnapshots]
}

export function FeedbackInviteEntry() {
  const controllerRef = useRef<FeedbackCaptureController | null>(null)
  const screenRecorderRef = useRef<ScreenCaptureRecorder | null>(null)
  const screenCaptureSessionIdRef = useRef<string | null>(null)
  const [load, setLoad] = useState<LoadState>(() => {
    const token = readAndStripToken()
    return token ? { status: 'loading', token } : { status: 'missing' }
  })
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' })
  const [note, setNote] = useState('')
  const [includeState, setIncludeState] = useState(true)
  const capabilities = useMemo(() => resolveCaptureCapabilities(), [])

  useEffect(() => {
    return () => {
      const controller = controllerRef.current
      controllerRef.current = null
      void controller?.discard().catch(() => undefined)
      const screenRecorder = screenRecorderRef.current
      const screenCaptureSessionId = screenCaptureSessionIdRef.current
      screenRecorderRef.current = null
      screenCaptureSessionIdRef.current = null
      screenRecorder?.cancel()
      if (screenCaptureSessionId && load.status === 'ready') {
        void discardFeedbackInviteCaptureSession(load.token, screenCaptureSessionId).catch(() => undefined)
      }
    }
  }, [load])

  useEffect(() => {
    if (load.status !== 'loading') return
    let cancelled = false
    resolveFeedbackInvite(load.token)
      .then(({ invite }) => {
        if (!cancelled) {
          setLoad({ status: 'ready', token: load.token, invite })
          setIncludeState(invite.allowed_capture_modes.includes('state'))
        }
      })
      .catch((error) => {
        if (!cancelled) setLoad({ status: 'error', message: errorMessage(error) })
      })
    return () => {
      cancelled = true
    }
  }, [load])

  const allowedModes = useMemo(
    () => (load.status === 'ready' ? new Set(load.invite.allowed_capture_modes) : new Set<string>()),
    [load],
  )
  const audioAvailable = allowedModes.has('audio') && capabilities.audio
  const screenAvailable = allowedModes.has('screen') && capabilities.video

  async function submitIssue() {
    if (load.status !== 'ready') return
    const trimmed = note.trim()
    if (!trimmed) {
      setSubmit({ status: 'error', message: 'Write the issue first.' })
      return
    }
    const captureSessionId = newCaptureSessionId()
    const routePath = routeForInvite(load.invite)
    const modes = selectedCaptureModes(includeState, allowedModes)
    setSubmit({ status: 'sending' })
    try {
      await startFeedbackInviteCaptureSession(load.token, {
        capture_session_id: captureSessionId,
        mode: 'feedback',
        consent_version: CONSENT_VERSION,
        route_path: routePath,
        device_kind: 'web',
        platform: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        metadata: {
          source: 'feedback_invite_page',
          reviewer_ref: load.invite.reviewer_ref,
          target_route: load.invite.target_route,
        },
        consent_scope: {
          ...feedbackInviteConsentScope(load.invite, modes),
          text_issue: true,
        },
      })
      await appendFeedbackInviteCaptureEvents(load.token, captureSessionId, [
        {
          client_event_id: `feedback_invite.issue_submitted:${captureSessionId}`,
          event_type: 'feedback_invite.issue_submitted',
          event_class: 'feedback_invite',
          route_path: routePath,
          occurred_at: new Date().toISOString(),
          payload: {
            note_length: trimmed.length,
            state_context_requested: includeState && allowedModes.has('state'),
          },
        },
      ]).catch(() => undefined)
      if (modes.includes('state')) {
        await uploadFeedbackInviteStateArtifacts({
          token: load.token,
          captureSessionId,
          invite: load.invite,
          routePath,
          noteLength: trimmed.length,
          reason: 'issue_submitted',
          trigger: 'text_issue_submit',
        })
      }
      const result = await finalizeFeedbackInviteCaptureSession(load.token, captureSessionId, {
        title: trimmed.slice(0, 120),
        summary: trimmed,
        severity: 'normal',
        route_path: routePath,
        category: 'feedback_invite',
        client_request_id: `feedback_invite:${load.invite.id}:${captureSessionId}`,
      })
      setNote('')
      setSubmit({
        status: 'sent',
        workItemId: result.work_item.id,
        supportPacketId: result.support_packet.id,
      })
    } catch (error) {
      setSubmit({ status: 'error', message: errorMessage(error) })
    }
  }

  async function startAudioRecording() {
    if (load.status !== 'ready' || !audioAvailable) return
    const captureSessionId = newCaptureSessionId()
    const routePath = routeForInvite(load.invite)
    const modes = selectedCaptureModes(includeState, allowedModes, true)
    const controller = new FeedbackCaptureController({
      backend: feedbackInviteBackend(load.token),
      replayRecorder: null,
    })
    controllerRef.current = controller
    setSubmit({ status: 'sending' })
    try {
      await controller.start({
        capture_session_id: captureSessionId,
        mode: 'feedback',
        consent_version: CONSENT_VERSION,
        route_path: routePath,
        device_kind: 'web',
        platform: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        metadata: {
          source: 'feedback_invite_page',
          capture_profile: 'audio',
          reviewer_ref: load.invite.reviewer_ref,
          target_route: load.invite.target_route,
        },
        consent_scope: feedbackInviteConsentScope(load.invite, modes),
      })
      await appendFeedbackInviteCaptureEvents(load.token, captureSessionId, [
        {
          client_event_id: `feedback_invite.audio_started:${captureSessionId}`,
          event_type: 'feedback_invite.audio_started',
          event_class: 'feedback_invite',
          route_path: routePath,
          occurred_at: new Date().toISOString(),
          payload: {
            state_context_requested: modes.includes('state'),
          },
        },
      ]).catch(() => undefined)
      setSubmit({ status: 'recording', captureSessionId, kind: 'audio' })
    } catch (error) {
      controllerRef.current = null
      setSubmit({ status: 'error', message: errorMessage(error) })
    }
  }

  async function startScreenRecording() {
    if (load.status !== 'ready' || !screenAvailable) return
    const captureSessionId = newCaptureSessionId()
    const routePath = routeForInvite(load.invite)
    const modes = selectedCaptureModes(includeState, allowedModes, false, true)
    const recorder = new ScreenCaptureRecorder()
    setSubmit({ status: 'sending' })
    try {
      await recorder.start()
    } catch (error) {
      setSubmit({ status: 'error', message: errorMessage(error) })
      return
    }

    try {
      await startFeedbackInviteCaptureSession(load.token, {
        capture_session_id: captureSessionId,
        mode: 'feedback',
        consent_version: CONSENT_VERSION,
        route_path: routePath,
        device_kind: 'web',
        platform: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        metadata: {
          source: 'feedback_invite_page',
          capture_profile: 'screen_recording',
          reviewer_ref: load.invite.reviewer_ref,
          target_route: load.invite.target_route,
        },
        consent_scope: feedbackInviteConsentScope(load.invite, modes),
      })
      screenRecorderRef.current = recorder
      screenCaptureSessionIdRef.current = captureSessionId
      await appendFeedbackInviteCaptureEvents(load.token, captureSessionId, [
        {
          client_event_id: `feedback_invite.screen_started:${captureSessionId}`,
          event_type: 'feedback_invite.screen_started',
          event_class: 'feedback_invite',
          route_path: routePath,
          occurred_at: new Date().toISOString(),
          payload: {
            state_context_requested: modes.includes('state'),
          },
        },
      ]).catch(() => undefined)
      setSubmit({ status: 'recording', captureSessionId, kind: 'screen' })
    } catch (error) {
      recorder.cancel()
      screenRecorderRef.current = null
      screenCaptureSessionIdRef.current = null
      await discardFeedbackInviteCaptureSession(load.token, captureSessionId).catch(() => undefined)
      setSubmit({ status: 'error', message: errorMessage(error) })
    }
  }

  async function stopScreenRecording() {
    if (load.status !== 'ready') return
    const recorder = screenRecorderRef.current
    const captureSessionId = screenCaptureSessionIdRef.current
    if (!recorder || !captureSessionId) return
    const routePath = routeForInvite(load.invite)
    const trimmed = note.trim()
    const modes = selectedCaptureModes(includeState, allowedModes, false, true)
    setSubmit({ status: 'stopping' })
    try {
      await appendFeedbackInviteCaptureEvents(load.token, captureSessionId, [
        {
          client_event_id: `feedback_invite.screen_stopped:${captureSessionId}`,
          event_type: 'feedback_invite.screen_stopped',
          event_class: 'feedback_invite',
          route_path: routePath,
          occurred_at: new Date().toISOString(),
          payload: {
            note_length: trimmed.length,
            state_context_requested: modes.includes('state'),
          },
        },
      ]).catch(() => undefined)
      const recording = await recorder.stop()
      screenRecorderRef.current = null
      await uploadFeedbackInviteCaptureArtifact(load.token, captureSessionId, {
        kind: 'video',
        file: recording.blob,
        fileName: 'screen-video.webm',
        duration_ms: recording.duration_ms,
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {
          source: 'feedback_invite_page',
          capture_profile: 'screen_recording',
          artifact_type: 'capture.screen_video',
          route_path: routePath,
          feedback_invite_id: load.invite.id,
          mime_type: recording.mime_type,
        },
      })
      if (modes.includes('state')) {
        await uploadFeedbackInviteStateArtifacts({
          token: load.token,
          captureSessionId,
          invite: load.invite,
          routePath,
          noteLength: trimmed.length,
          reason: 'screen_recording_stopped',
          trigger: 'screen_recording_stop',
        })
      }
      const result = await finalizeFeedbackInviteCaptureSession(load.token, captureSessionId, {
        title: trimmed ? trimmed.slice(0, 120) : 'Screen recording feedback',
        summary: trimmed || 'Reviewer submitted screen recording feedback.',
        severity: 'normal',
        route_path: routePath,
        category: 'feedback_invite',
        client_request_id: `feedback_invite:${load.invite.id}:${captureSessionId}`,
      })
      screenCaptureSessionIdRef.current = null
      setNote('')
      setSubmit({
        status: 'sent',
        workItemId: result.work_item.id,
        supportPacketId: result.support_packet.id,
      })
    } catch (error) {
      screenRecorderRef.current = null
      screenCaptureSessionIdRef.current = null
      setSubmit({ status: 'error', message: errorMessage(error) })
    }
  }

  async function stopAudioRecording() {
    if (load.status !== 'ready') return
    const controller = controllerRef.current
    const captureSessionId = controller?.activeCaptureSessionId
    if (!controller || !captureSessionId) return
    const routePath = routeForInvite(load.invite)
    const trimmed = note.trim()
    const modes = selectedCaptureModes(includeState, allowedModes, true)
    setSubmit({ status: 'stopping' })
    try {
      await appendFeedbackInviteCaptureEvents(load.token, captureSessionId, [
        {
          client_event_id: `feedback_invite.audio_stopped:${captureSessionId}`,
          event_type: 'feedback_invite.audio_stopped',
          event_class: 'feedback_invite',
          route_path: routePath,
          occurred_at: new Date().toISOString(),
          payload: {
            note_length: trimmed.length,
            state_context_requested: modes.includes('state'),
          },
        },
      ]).catch(() => undefined)
      const result = await controller.stop({
        title: trimmed ? trimmed.slice(0, 120) : 'Audio feedback',
        summary: trimmed || 'Reviewer submitted audio feedback.',
        severity: 'normal',
        route_path: routePath,
        category: 'feedback_invite',
        client_request_id: `feedback_invite:${load.invite.id}:${captureSessionId}`,
        artifact_metadata: {
          source: 'feedback_invite_page',
          capture_profile: 'audio',
          route_path: routePath,
          feedback_invite_id: load.invite.id,
        },
        additional_artifact_uploads: modes.includes('state')
          ? [
              (id) =>
                uploadFeedbackInviteStateArtifacts({
                  token: load.token,
                  captureSessionId: id,
                  invite: load.invite,
                  routePath,
                  noteLength: trimmed.length,
                  reason: 'recording_stopped',
                  trigger: 'record_feedback_stop',
                }),
            ]
          : [],
      })
      controllerRef.current = null
      setNote('')
      setSubmit({
        status: 'sent',
        workItemId: result.finalize.work_item.id,
        supportPacketId: result.finalize.support_packet.id,
      })
    } catch (error) {
      setSubmit({ status: 'error', message: errorMessage(error) })
    }
  }

  return (
    <main style={styles.shell}>
      <section style={styles.panel}>
        {load.status === 'loading' ? (
          <StatusPanel icon={<Loader2 size={18} style={styles.spin} />} title="Opening feedback link" />
        ) : null}
        {load.status === 'missing' ? (
          <StatusPanel icon={<AlertCircle size={18} />} title="Feedback link is missing." tone="bad" />
        ) : null}
        {load.status === 'error' ? (
          <StatusPanel icon={<AlertCircle size={18} />} title={load.message} tone="bad" />
        ) : null}
        {load.status === 'ready' ? (
          <>
            <div style={styles.header}>
              <ShieldCheck size={22} aria-hidden />
              <div>
                <div style={styles.eyebrow}>{load.invite.company_name}</div>
                <h1 style={styles.title}>Submit feedback</h1>
              </div>
            </div>

            <div style={styles.modeRow}>
              {load.invite.allowed_capture_modes.map((mode) => (
                <span key={mode} style={styles.chip}>
                  {mode}
                </span>
              ))}
            </div>

            <textarea
              value={note}
              onChange={(event) => {
                setNote(event.target.value)
                if (submit.status === 'error') setSubmit({ status: 'idle' })
              }}
              placeholder="What should we fix?"
              rows={8}
              style={styles.textarea}
            />

            {allowedModes.has('state') ? (
              <label style={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={includeState}
                  onChange={(event) => setIncludeState(event.target.checked)}
                />
                Include page state
              </label>
            ) : null}

            <button
              type="button"
              style={{ ...styles.button, opacity: submit.status === 'sending' ? 0.7 : 1 }}
              disabled={submit.status === 'sending' || submit.status === 'recording' || submit.status === 'stopping'}
              onClick={() => void submitIssue()}
            >
              {submit.status === 'sending' ? <Loader2 size={16} style={styles.spin} /> : <Send size={16} />}
              {submit.status === 'sending' ? 'Sending' : 'Submit issue'}
            </button>

            {allowedModes.has('audio') ? (
              <button
                type="button"
                style={{
                  ...styles.secondaryButton,
                  opacity: submit.status === 'sending' || submit.status === 'stopping' ? 0.7 : 1,
                }}
                disabled={
                  !audioAvailable ||
                  submit.status === 'sending' ||
                  submit.status === 'stopping' ||
                  (submit.status === 'recording' && submit.kind !== 'audio')
                }
                onClick={() =>
                  submit.status === 'recording' && submit.kind === 'audio'
                    ? void stopAudioRecording()
                    : void startAudioRecording()
                }
              >
                {submit.status === 'stopping' ? (
                  <Loader2 size={16} style={styles.spin} />
                ) : submit.status === 'recording' && submit.kind === 'audio' ? (
                  <Square size={16} />
                ) : (
                  <Mic size={16} />
                )}
                {submit.status === 'stopping'
                  ? 'Submitting audio'
                  : submit.status === 'recording' && submit.kind === 'audio'
                    ? 'Stop and submit audio'
                    : audioAvailable
                      ? 'Record audio'
                      : 'Audio unavailable'}
              </button>
            ) : null}

            {allowedModes.has('screen') ? (
              <button
                type="button"
                style={{
                  ...styles.secondaryButton,
                  opacity: submit.status === 'sending' || submit.status === 'stopping' ? 0.7 : 1,
                }}
                disabled={
                  !screenAvailable ||
                  submit.status === 'sending' ||
                  submit.status === 'stopping' ||
                  (submit.status === 'recording' && submit.kind !== 'screen')
                }
                onClick={() =>
                  submit.status === 'recording' && submit.kind === 'screen'
                    ? void stopScreenRecording()
                    : void startScreenRecording()
                }
              >
                {submit.status === 'stopping' ? (
                  <Loader2 size={16} style={styles.spin} />
                ) : submit.status === 'recording' && submit.kind === 'screen' ? (
                  <Square size={16} />
                ) : (
                  <ScreenShare size={16} />
                )}
                {submit.status === 'stopping'
                  ? 'Submitting screen'
                  : submit.status === 'recording' && submit.kind === 'screen'
                    ? 'Stop and submit screen'
                    : screenAvailable
                      ? 'Record screen'
                      : 'Screen unavailable'}
              </button>
            ) : null}

            {submit.status === 'error' ? <div style={styles.error}>{submit.message}</div> : null}
            {submit.status === 'sent' ? (
              <div style={styles.success}>
                <CheckCircle size={16} aria-hidden />
                <span>
                  Sent <span style={styles.code}>{submit.workItemId.slice(0, 8)}</span>
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  )
}

function StatusPanel({ icon, title, tone = 'neutral' }: { icon: ReactNode; title: string; tone?: 'neutral' | 'bad' }) {
  return (
    <div style={{ ...styles.status, color: tone === 'bad' ? '#b91c1c' : '#263126' }}>
      {icon}
      <span>{title}</span>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  shell: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    padding: 20,
    background: '#f4f7f1',
    color: '#172015',
  },
  panel: {
    width: 'min(520px, 100%)',
    border: '1px solid #ccd8c7',
    borderRadius: 8,
    background: '#fffefa',
    padding: 18,
    boxShadow: '0 18px 45px rgba(23, 32, 21, 0.12)',
  },
  header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 },
  eyebrow: { fontSize: 12, color: '#66735e', marginBottom: 2 },
  title: { margin: 0, fontSize: 22, lineHeight: 1.15 },
  modeRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    border: '1px solid #d6e0d2',
    borderRadius: 999,
    padding: '3px 8px',
    fontSize: 12,
    color: '#405139',
    background: '#f7faf4',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid #cbd5c5',
    borderRadius: 8,
    padding: 10,
    font: 'inherit',
    fontSize: 14,
    lineHeight: 1.45,
    resize: 'vertical',
    outline: 'none',
    background: '#ffffff',
  },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13, color: '#405139' },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    marginTop: 14,
    border: 0,
    borderRadius: 8,
    padding: '10px 12px',
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
    color: '#fffefa',
    background: '#2f6b3a',
  },
  secondaryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    marginTop: 8,
    border: '1px solid #cbd5c5',
    borderRadius: 8,
    padding: '10px 12px',
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
    color: '#263126',
    background: '#ffffff',
  },
  error: {
    marginTop: 10,
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: 10,
    color: '#b91c1c',
    background: '#fef2f2',
    fontSize: 13,
  },
  success: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    border: '1px solid #bbf7d0',
    borderRadius: 8,
    padding: 10,
    color: '#166534',
    background: '#f0fdf4',
    fontSize: 13,
  },
  status: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  spin: { animation: 'feedback-spin 900ms linear infinite' },
}
