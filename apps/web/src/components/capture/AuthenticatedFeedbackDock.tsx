import { useEffect, useMemo, useRef, useState } from 'react'
import { Bug, CheckCircle, ClipboardCopy, ExternalLink, Flag, Mic, ScreenShare, Square, Timer, X } from 'lucide-react'
import { resolveCaptureCapabilities } from '@/lib/capture-capabilities'
import { useAppIssueCapabilities } from '@/lib/api/app-issues'
import { fetchSupportPacket } from '@/lib/api/support-packets'
import {
  clearLocalCaptureSession,
  currentCaptureRoutePath,
  ensureLocalCaptureSession,
  getActiveCaptureSession,
  startLocalCaptureSession,
} from '@/lib/capture-session'
import { uploadRegisteredCaptureArtifacts } from '@/lib/capture-artifact-providers'
import { captureErrorMessage } from '@/lib/capture-error-copy'
import { uploadRegisteredCaptureStateSnapshots } from '@/lib/capture-state-providers'
import { createRrwebCaptureReplayRecorder } from '@/lib/capture-replay-recorder'
import { buildVideoClipManifestBlob } from '@/lib/capture-video-manifest'
import { getProjectSignal } from '@/lib/project-signal'
import {
  FeedbackCaptureController,
  FeedbackCaptureQueuedError,
  type FeedbackCaptureBackend,
  type FeedbackCaptureControllerDeps,
} from '@/lib/feedback-capture-controller'
import {
  appendCaptureSessionEvents,
  createCaptureSession,
  discardCaptureSession,
  finalizeCaptureSession,
  type CaptureFinalizeResponse,
  uploadCaptureArtifact,
} from '@/lib/api/capture-sessions'
import { buildTextIssueCaptureSessionInput } from '@/lib/feedback-text-issue'
import {
  buildAuthenticatedFeedbackConsentScope,
  buildAuthenticatedScreenRecordingConsentScope,
} from '@/lib/capture-policy'
import { ScreenCaptureRecorder } from '@/lib/capture-recorder'
import { ReproBracketController, type ReproMark } from '@/lib/repro-bracket'
import {
  CAPTURE_LEVEL_META,
  availableCaptureLevels,
  captureLevelStreams,
  resolveCaptureLevel,
  writeStoredCaptureLevel,
  type CaptureLevel,
} from '@/lib/capture-level'
import {
  DEFAULT_CAPTURE_HOTKEYS,
  captureHotkeysSupported,
  formatCaptureHotkey,
  registerCaptureHotkeys,
} from '@/lib/capture-hotkeys'
import {
  AUTH_FEEDBACK_AUDIO_STORAGE_KEY,
  AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY,
  AUTH_FEEDBACK_ENABLED_STORAGE_KEY,
  AUTH_FEEDBACK_REPLAY_STORAGE_KEY,
  isSteveCollabMode,
} from '@/lib/steve-collab'

type CaptureState = 'idle' | 'recording' | 'stopping' | 'sent' | 'queued' | 'error'
type RecordingKind = 'feedback' | 'screen' | 'repro'

type FeedbackReceipt = {
  workItemId: string
  supportPacketId: string
  /**
   * The repro-bracket marks surfaced from `ReproBracketController.end()`
   * (STEP5-UI). One entry per "the bug is here" mark the reviewer dropped; the
   * backend emits one work_item per mark/mark-pair, so the receipt shows the
   * reviewer exactly which moments were filed.
   */
  marks?: ReproMark[]
}

type AuthenticatedFeedbackDockProps = {
  companySlug: string
}

const CONSENT_VERSION = 'authenticated-feedback-v1'

/**
 * The single PLATFORM capability that gates this dock. `app_issue.capture` ==
 * "open the capture dock + record" (packages/domain/src/capabilities.ts). This
 * is an app_issue.* (software-bug) capability — NOT a field_request.* one. The
 * dock files software issues only; it never reads or routes field_request.
 */
const APP_ISSUE_CAPTURE_CAPABILITY = 'app_issue.capture'

/**
 * Non-prod build? Use the DIRECT `import.meta.env.MODE` form (not a cast) so
 * Vite statically replaces it at build time and dead-code-eliminates the dev
 * override from the production bundle — the same mechanism `App.tsx` uses to
 * strip the dev RoleSwitcher (`import.meta.env.MODE !== 'production'`). This is
 * what keeps the URL/env/localStorage feedback flags as a DEV-ONLY override: in
 * prod the dock is shown iff the signed-in user holds `app_issue.capture`.
 */
function isNonProdBuild(): boolean {
  return import.meta.env.MODE !== 'production'
}

function env(name: string): string {
  try {
    return String((import.meta as { env?: Record<string, string> }).env?.[name] || '').trim()
  } catch {
    return ''
  }
}

function flagFromStorage(name: string): string | null {
  try {
    return window.localStorage.getItem(name)
  } catch {
    return null
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

/**
 * The legacy URL/env/localStorage flag, kept ONLY as a NON-PROD dev override so
 * `/collab/steve` and local dev can still force the dock on. In prod this
 * always returns false (the `isNonProdBuild()` guard means Vite strips the flag
 * reads from the production bundle), so prod visibility is driven purely by the
 * signed-in user's `app_issue.capture` capability.
 */
function devFeedbackOverrideEnabled(): boolean {
  if (!isNonProdBuild()) return false
  const fromUrl = flagFromUrl('capture_feedback', 'captureFeedback', 'record_feedback')
  if (fromUrl !== null) return isTruthyFlag(fromUrl)
  if (isTruthyFlag(env('VITE_AUTH_CAPTURE_FEEDBACK')) || isTruthyFlag(env('VITE_CAPTURE_FEEDBACK'))) return true
  return isTruthyFlag(flagFromStorage(AUTH_FEEDBACK_ENABLED_STORAGE_KEY))
}

function captureReplayEnabled(): boolean {
  const fromUrl = flagFromUrl('capture_replay', 'captureReplay')
  if (fromUrl !== null) return isTruthyFlag(fromUrl)
  return (
    isTruthyFlag(env('VITE_AUTH_CAPTURE_REPLAY')) || isTruthyFlag(flagFromStorage(AUTH_FEEDBACK_REPLAY_STORAGE_KEY))
  )
}

function captureAudioEnabled(): boolean {
  const fromUrl = flagFromUrl('capture_audio', 'captureAudio')
  if (fromUrl !== null) return isTruthyFlag(fromUrl)
  const fromStorage = flagFromStorage(AUTH_FEEDBACK_AUDIO_STORAGE_KEY)
  if (fromStorage !== null) return isTruthyFlag(fromStorage)
  return true
}

function feedbackAutoOpen(): boolean {
  const fromUrl = flagFromUrl('feedback_open', 'feedbackOpen')
  if (fromUrl !== null) return isTruthyFlag(fromUrl)
  return isTruthyFlag(flagFromStorage(AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY))
}

function authenticatedBackend(): FeedbackCaptureBackend {
  return {
    startSession: (payload) => createCaptureSession(payload),
    uploadArtifact: uploadCaptureArtifact,
    finalizeSession: finalizeCaptureSession,
    discardSession: async (captureSessionId, input) => {
      await discardCaptureSession(captureSessionId, input)
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

// Composable-overlay seam (step 1): ship the captured task through the
// @operator/projectkit contract alongside the existing sitelayer work-item
// (the kanban path). Fire-and-forget + inert-by-default (SIGNAL_SINK_URL unset →
// /api/signal 204s), so ZERO UX change. This is what lets a non-mesh subscriber
// (kanban / linear / agent dispatch) consume sitelayer captures — a config swap
// of the relay's sink, no change here.
function emitCaptureWorkRequest(finalize: CaptureFinalizeResponse): void {
  const wi = finalize.work_item
  void getProjectSignal()
    .requestWork({
      request_ref: wi.id,
      intent: 'capture-followup',
      title: wi.title,
      summary: wi.summary,
      ...(wi.route ? { route_path: wi.route } : {}),
      source_event_ref: wi.capture_session_id ?? wi.id,
      payload: { lane: wi.lane, severity: wi.severity, support_packet_id: finalize.support_packet.id },
    })
    .catch(() => undefined)
}

function receiptFromFinalize(finalize: CaptureFinalizeResponse, marks?: ReproMark[]): FeedbackReceipt {
  emitCaptureWorkRequest(finalize)
  return {
    workItemId: finalize.work_item.id,
    supportPacketId: finalize.support_packet.id,
    ...(marks && marks.length ? { marks } : {}),
  }
}

export function AuthenticatedFeedbackDock({ companySlug }: AuthenticatedFeedbackDockProps) {
  // P0 — IDENTITY-DRIVEN VISIBILITY. The dock is shown iff the signed-in user
  // can actually file a software bug, i.e. holds the PLATFORM capability
  // `app_issue.capture` (off /api/session's app_issue_capabilities). The legacy
  // URL/env/localStorage flag survives ONLY as a non-prod dev override so
  // /collab/steve + local dev still force it on. Net in prod: a designated
  // reviewer (platform_admin_grants / non-prod relaxation) sees the pill; a
  // normal crew user does not — and because the button only shows to users who
  // can finalize, the old "button shows but submit 403s" cliff is gone.
  //
  // VISIBILITY PREDICATE: devFeedbackOverrideEnabled() || holds app_issue.capture
  // (reads app_issue.capture, NEVER any field_request.* capability).
  const devOverride = devFeedbackOverrideEnabled()
  const appIssueCaps = useAppIssueCapabilities()
  const hasAppIssueCapture = (appIssueCaps.data ?? []).includes(APP_ISSUE_CAPTURE_CAPABILITY)
  const enabled = devOverride || hasAppIssueCapture
  const replayEnabled = captureReplayEnabled()
  const audioEnabled = captureAudioEnabled()
  const capabilities = resolveCaptureCapabilities()
  const audioSupported = !audioEnabled || capabilities.audio
  const screenSupported = capabilities.video
  const steveMode = isSteveCollabMode()
  const backend = useMemo(() => authenticatedBackend(), [])
  const controllerRef = useRef<FeedbackCaptureController | null>(null)
  const screenRecorderRef = useRef<ScreenCaptureRecorder | null>(null)
  const reproRef = useRef<ReproBracketController | null>(null)
  const prewarmedTextIssueSessionIdRef = useRef<string | null>(null)
  const [state, setState] = useState<CaptureState>('idle')
  const [recordingKind, setRecordingKind] = useState<RecordingKind | null>(null)
  const [open, setOpen] = useState(() => feedbackAutoOpen())
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null)
  const [reproElapsedMs, setReproElapsedMs] = useState(0)
  const [reproMarkCount, setReproMarkCount] = useState(0)
  const [markLabel, setMarkLabel] = useState('')
  // P1 — TWO-FIELD REPRO NOTES: the START note the user typed before pressing
  // "Reproduce a bug". The textarea is reused for the END-condition note while
  // recording, so we keep the start note here to show it as read-only context
  // above the end field (the user never loses what they typed).
  const [reproStartNote, setReproStartNote] = useState('')
  // P1 — STICKY RECEIPT: "Copy agent bundle" fetch/copy status. idle → copying →
  // copied | error, so the receipt card can show progress without dismissing.
  const [bundleCopyState, setBundleCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  // P2 — PRE-ARM PERMISSION COPY: a one-line hint shown right before the browser
  // mic/screen prompt fires, plus a denial fallback offering text/repro instead.
  const [permissionHint, setPermissionHint] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState<'audio' | 'screen' | null>(null)
  // P1 — DEFAULT CAPTURE LEVEL = 'note'. Seed the floor ('note': typed note +
  // auto state snapshot, ZERO permission prompt) so the 2-tap path (pill → type
  // → Send issue) never implies a recording/permission step. offerableLevels
  // still exposes every rung this device supports, and the user can dial up.
  const seedLevel: CaptureLevel = 'note'
  const [level, setLevelState] = useState<CaptureLevel>(() =>
    resolveCaptureLevel(capabilities, { fallback: seedLevel }),
  )
  const levelStreams = captureLevelStreams(level)
  const offerableLevels = availableCaptureLevels(capabilities)
  const [hotkeysEnabled, setHotkeysEnabled] = useState(() => captureHotkeysSupported())
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 520)
  function setLevel(next: CaptureLevel): void {
    writeStoredCaptureLevel(next)
    setLevelState(next)
  }

  const buttonLabel = steveMode ? 'Report issue' : 'Record feedback'
  const idlePlaceholder = steveMode ? 'What is wrong?' : 'What happened?'
  const recordingTitle =
    recordingKind === 'repro'
      ? 'Reproducing a bug'
      : recordingKind === 'screen'
        ? 'Recording screen'
        : audioEnabled
          ? 'Recording feedback'
          : 'Recording page context'
  const collabMode = steveMode ? 'steve' : null

  useEffect(() => {
    if (!enabled || !companySlug || !steveMode || !open || state !== 'idle') return
    const local = ensureLocalCaptureSession({ mode: 'feedback', consent_version: CONSENT_VERSION })
    if (local.mode !== 'feedback') return
    if (prewarmedTextIssueSessionIdRef.current === local.id) return
    prewarmedTextIssueSessionIdRef.current = local.id
    const routePath = currentCaptureRoutePath()
    const metadata = {
      source: 'text_issue_prewarm',
      surface: 'authenticated_app',
      company_slug: companySlug,
      trigger: 'issue_opened',
      ...(collabMode ? { collab_mode: collabMode } : {}),
    }
    void (async () => {
      try {
        await createCaptureSession(
          buildTextIssueCaptureSessionInput({
            captureSessionId: local.id,
            companySlug,
            captureProfile: 'text_issue_prewarm',
            collabMode,
            routePath,
            deviceKind: inferDeviceKind(),
            platform: inferPlatform(),
            viewport: inferViewport(),
            consentVersion: CONSENT_VERSION,
          }),
        )
        await appendFeedbackEvent(local.id, 'authenticated.feedback.issue_opened', {
          ...(collabMode ? { collab_mode: collabMode } : {}),
        }).catch(() => undefined)
        await uploadRegisteredCaptureStateSnapshots(local.id, {
          reason: 'issue_opened',
          metadata,
        }).catch(() => undefined)
      } catch {
        if (prewarmedTextIssueSessionIdRef.current === local.id) prewarmedTextIssueSessionIdRef.current = null
      }
    })()
  }, [collabMode, companySlug, enabled, open, state, steveMode])

  // Keep a fresh handle to the hotkey actions so the listener (registered once)
  // always invokes the latest closures without re-binding on every keystroke.
  const hotkeyActionsRef = useRef<{ open: () => void; toggle: () => void; mark: () => void }>({
    open: () => undefined,
    toggle: () => undefined,
    mark: () => undefined,
  })
  useEffect(() => {
    hotkeyActionsRef.current = {
      open: () => setOpen(true),
      toggle: () => {
        if (reproRef.current?.status === 'active') void endRepro()
        else void startRepro()
      },
      mark: () => void markRepro(),
    }
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setNarrow(window.innerWidth < 520)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Live elapsed timer while a reproduction is recording.
  useEffect(() => {
    if (state !== 'recording' || recordingKind !== 'repro') return
    const id = window.setInterval(() => {
      const controller = reproRef.current
      if (controller) setReproElapsedMs(controller.elapsedMs())
    }, 500)
    return () => window.clearInterval(id)
  }, [state, recordingKind])

  // Opt-in, desktop-only keyboard shortcuts. Registered once per enable toggle;
  // handlers read the latest actions from the ref above.
  useEffect(() => {
    if (!enabled || !companySlug || !hotkeysEnabled) return
    return registerCaptureHotkeys({
      open_report: () => hotkeyActionsRef.current.open(),
      toggle_repro: () => hotkeyActionsRef.current.toggle(),
      mark: () => hotkeyActionsRef.current.mark(),
    })
  }, [enabled, companySlug, hotkeysEnabled])

  if (!enabled || !companySlug) return null

  // P1 — STICKY RECEIPT actions.
  // The receipt card persists (no auto-dismiss) until the user closes it.
  function dismissReceipt() {
    setReceipt(null)
    setBundleCopyState('idle')
    setState('idle')
  }

  // "Copy agent bundle": fetch the finalized support packet and copy its
  // ready-to-paste `agent_prompt` to the clipboard. Reads from the app_issue
  // support-packet surface only; never touches field_request.
  async function copyAgentBundle(supportPacketId: string) {
    if (!supportPacketId) return
    setBundleCopyState('copying')
    try {
      const detail = await fetchSupportPacket(supportPacketId)
      await navigator.clipboard.writeText(detail.agent_prompt)
      setBundleCopyState('copied')
    } catch {
      setBundleCopyState('error')
    }
  }

  async function sendTextIssue() {
    const trimmedNote = note.trim()
    if (!trimmedNote) {
      setError('Write what is wrong first.')
      setOpen(true)
      return
    }
    setState('stopping')
    setError(null)
    setReceipt(null)
    setPermissionHint(null)
    setPermissionDenied(null)
    const active = getActiveCaptureSession()
    const local =
      active?.mode === 'feedback'
        ? active
        : startLocalCaptureSession({
            mode: 'feedback',
            consent_version: CONSENT_VERSION,
          })
    const routePath = currentCaptureRoutePath()
    const artifactMetadata = {
      source: 'text_issue',
      surface: 'authenticated_app',
      company_slug: companySlug,
      ...(collabMode ? { collab_mode: collabMode } : {}),
    }
    try {
      await createCaptureSession(
        buildTextIssueCaptureSessionInput({
          captureSessionId: local.id,
          companySlug,
          captureProfile: 'text_issue',
          collabMode,
          routePath,
          deviceKind: inferDeviceKind(),
          platform: inferPlatform(),
          viewport: inferViewport(),
          consentVersion: CONSENT_VERSION,
        }),
      )
      await appendFeedbackEvent(local.id, 'authenticated.feedback.issue_submitted', {
        note_length: trimmedNote.length,
        ...(collabMode ? { collab_mode: collabMode } : {}),
      }).catch(() => undefined)
      await uploadRegisteredCaptureStateSnapshots(local.id, {
        reason: 'issue_submitted',
        metadata: {
          ...artifactMetadata,
          trigger: 'text_issue_submit',
        },
      })
      await uploadRegisteredCaptureArtifacts(local.id, {
        ...artifactMetadata,
        trigger: 'text_issue_submit',
      })
      const finalize = await finalizeCaptureSession(local.id, {
        title: 'In-app issue report',
        summary: trimmedNote,
        severity: 'normal',
        lane: 'triage',
        route_path: routePath,
        route: routePath,
        category: 'record_feedback',
      })
      clearLocalCaptureSession()
      if (prewarmedTextIssueSessionIdRef.current === local.id) prewarmedTextIssueSessionIdRef.current = null
      setReceipt(receiptFromFinalize(finalize))
      setBundleCopyState('idle')
      setNote('')
      setRecordingKind(null)
      setOpen(false)
      // P1 — STICKY RECEIPT: no auto-reset timer. The receipt card stays until
      // the user closes it (View issue / Copy agent bundle / Done).
      setState('sent')
    } catch (err) {
      setState('error')
      setError(captureErrorMessage(err, 'Issue could not be sent.'))
    }
  }

  async function startRecording() {
    setError(null)
    setReceipt(null)
    setPermissionDenied(null)
    if (state === 'recording') {
      setState('error')
      setError('Recording is already active.')
      return
    }
    // P2 — PRE-ARM PERMISSION COPY: warn before getUserMedia fires the prompt,
    // but only when audio is actually requested (otherwise no prompt appears).
    setPermissionHint(audioEnabled ? 'Your browser will now ask to share your microphone.' : null)
    const local = startLocalCaptureSession({
      mode: 'feedback',
      consent_version: CONSENT_VERSION,
    })
    const controllerDeps: FeedbackCaptureControllerDeps = {
      backend,
      offlineQueue: { target: { type: 'authenticated' } },
      replayRecorder: replayEnabled
        ? createRrwebCaptureReplayRecorder({
            upload: backend.uploadArtifact,
          })
        : null,
    }
    if (!audioEnabled) controllerDeps.audioRecorder = null
    const controller = new FeedbackCaptureController(controllerDeps)
    controllerRef.current = controller
    setRecordingKind('feedback')
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
          capture_profile: 'recording',
          ...(collabMode ? { collab_mode: collabMode } : {}),
        },
        consent_scope: buildAuthenticatedFeedbackConsentScope({
          audio: audioEnabled,
          domReplay: replayEnabled,
        }),
      })
      await appendFeedbackEvent(local.id, 'authenticated.feedback.recording_started').catch(() => undefined)
      setPermissionHint(null)
      setState('recording')
      setOpen(true)
    } catch (err) {
      clearLocalCaptureSession()
      setRecordingKind(null)
      setPermissionHint(null)
      // P2 — denial fallback: keep the error but offer the no-prompt paths
      // (Send issue / Reproduce a bug) so a declined mic isn't a dead end.
      if (audioEnabled) setPermissionDenied('audio')
      setState('error')
      setError(captureErrorMessage(err, 'Recording could not start.'))
    }
  }

  async function startScreenRecording() {
    setError(null)
    setReceipt(null)
    setPermissionDenied(null)
    if (state === 'recording') {
      setState('error')
      setError('Recording is already active.')
      return
    }

    // P2 — PRE-ARM PERMISSION COPY: warn before getDisplayMedia fires the
    // screen-picker prompt.
    setPermissionHint('Your browser will now ask to share your screen.')
    const recorder = new ScreenCaptureRecorder()
    try {
      await recorder.start()
      setPermissionHint(null)
    } catch (err) {
      setPermissionHint(null)
      setPermissionDenied('screen')
      setState('error')
      setError(captureErrorMessage(err, 'Screen recording could not start.'))
      return
    }

    const local = startLocalCaptureSession({
      mode: 'feedback',
      consent_version: CONSENT_VERSION,
    })
    const routePath = currentCaptureRoutePath()
    screenRecorderRef.current = recorder
    setRecordingKind('screen')
    try {
      await createCaptureSession({
        capture_session_id: local.id,
        mode: 'feedback',
        consent_version: CONSENT_VERSION,
        route_path: routePath,
        device_kind: inferDeviceKind(),
        platform: inferPlatform(),
        viewport: inferViewport(),
        metadata: {
          surface: 'authenticated_app',
          company_slug: companySlug,
          capture_profile: 'screen_recording',
          ...(collabMode ? { collab_mode: collabMode } : {}),
        },
        consent_scope: buildAuthenticatedScreenRecordingConsentScope(),
      })
      await appendFeedbackEvent(local.id, 'authenticated.feedback.screen_recording_started', {
        ...(collabMode ? { collab_mode: collabMode } : {}),
      }).catch(() => undefined)
      setState('recording')
      setOpen(true)
    } catch (err) {
      recorder.cancel()
      screenRecorderRef.current = null
      clearLocalCaptureSession()
      setRecordingKind(null)
      setState('error')
      setError(captureErrorMessage(err, 'Screen recording could not start.'))
    }
  }

  async function startRepro() {
    setError(null)
    setReceipt(null)
    // Reproduction records DOM replay only — no browser permission prompt — so
    // clear any pre-arm/denial hint when the user takes this fallback path.
    setPermissionHint(null)
    setPermissionDenied(null)
    if (state === 'recording') {
      setState('error')
      setError('Recording is already active.')
      return
    }
    const startNote = note.trim()
    const local = startLocalCaptureSession({ mode: 'feedback', consent_version: CONSENT_VERSION })
    const controller = new ReproBracketController({
      replayRecorder: levelStreams.domReplay
        ? createRrwebCaptureReplayRecorder({ upload: backend.uploadArtifact })
        : null,
    })
    reproRef.current = controller
    setRecordingKind('repro')
    setReproMarkCount(0)
    setReproElapsedMs(0)
    setMarkLabel('')
    const buildSha = env('VITE_APP_BUILD_SHA') || env('VITE_BUILD_SHA')
    try {
      await controller.start({
        captureSessionId: local.id,
        companySlug,
        routePath: currentCaptureRoutePath(),
        deviceKind: inferDeviceKind(),
        platform: inferPlatform(),
        viewport: inferViewport(),
        consentVersion: CONSENT_VERSION,
        collabMode,
        domReplay: levelStreams.domReplay,
        ...(startNote ? { startNote } : {}),
        ...(buildSha ? { appBuildSha: buildSha } : {}),
      })
      // Preserve the start condition for the read-only context shown above the
      // end-condition textarea, then clear the live note for the end field.
      setReproStartNote(startNote)
      setNote('')
      setState('recording')
      setOpen(true)
    } catch (err) {
      reproRef.current = null
      clearLocalCaptureSession()
      setRecordingKind(null)
      setState('error')
      setError(captureErrorMessage(err, 'Reproduction could not start.'))
    }
  }

  async function markRepro() {
    const controller = reproRef.current
    if (!controller || controller.status !== 'active') return
    const label = markLabel.trim()
    setMarkLabel('')
    try {
      await controller.mark(label || undefined)
      setReproMarkCount(controller.markCount)
    } catch {
      /* marking is best-effort; the local mark still counts at end */
    }
  }

  async function endRepro() {
    const controller = reproRef.current
    if (!controller || controller.status !== 'active') return
    setState('stopping')
    setError(null)
    const endNote = note.trim()
    try {
      const result = await controller.end({ ...(endNote ? { endNote } : {}) })
      reproRef.current = null
      setReceipt(receiptFromFinalize(result.finalize, result.marks))
      setBundleCopyState('idle')
      clearLocalCaptureSession()
      setNote('')
      setReproStartNote('')
      setRecordingKind(null)
      setOpen(false)
      // P1 — STICKY RECEIPT: no auto-reset timer; user closes the card.
      setState('sent')
    } catch (err) {
      setState('error')
      setError(captureErrorMessage(err, 'Reproduction could not be sent.'))
    }
  }

  async function discardRepro() {
    const controller = reproRef.current
    try {
      await controller?.discard()
    } catch {
      /* discard is best-effort */
    }
    reproRef.current = null
    clearLocalCaptureSession()
    setNote('')
    setReproStartNote('')
    setRecordingKind(null)
    setReproMarkCount(0)
    setReproElapsedMs(0)
    setMarkLabel('')
    setOpen(false)
    setError(null)
    setState('idle')
  }

  async function stopRecording() {
    if (recordingKind === 'repro') {
      await endRepro()
      return
    }
    if (recordingKind === 'screen') {
      await stopScreenRecording()
      return
    }
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
      const result = await controller.stop({
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
            uploadRegisteredCaptureStateSnapshots(id, {
              reason: 'recording_stopped',
              metadata: {
                ...metadata,
                trigger: 'record_feedback_stop',
              },
            }),
          (id, metadata) =>
            uploadRegisteredCaptureArtifacts(id, {
              ...metadata,
              trigger: 'record_feedback_stop',
            }),
        ],
      })
      setReceipt(receiptFromFinalize(result.finalize))
      setBundleCopyState('idle')
      clearLocalCaptureSession()
      controllerRef.current = null
      setNote('')
      setRecordingKind(null)
      setOpen(false)
      // P1 — STICKY RECEIPT: no auto-reset timer; user closes the card.
      setState('sent')
    } catch (err) {
      if (err instanceof FeedbackCaptureQueuedError) {
        clearLocalCaptureSession()
        controllerRef.current = null
        setNote('')
        setRecordingKind(null)
        setOpen(false)
        setState('queued')
        window.setTimeout(() => setState('idle'), 4000)
        return
      }
      setState('error')
      setError(captureErrorMessage(err, 'Feedback could not be sent.'))
    }
  }

  async function stopScreenRecording() {
    const recorder = screenRecorderRef.current
    const captureSessionId = getActiveCaptureSession()?.id
    if (!recorder || !captureSessionId) return
    setState('stopping')
    setError(null)
    const trimmedNote = note.trim()
    await appendFeedbackEvent(captureSessionId, 'authenticated.feedback.screen_recording_stopped', {
      note_length: trimmedNote.length,
      ...(collabMode ? { collab_mode: collabMode } : {}),
    }).catch(() => undefined)
    try {
      const recording = await recorder.stop()
      const routePath = currentCaptureRoutePath()
      const videoUpload = await uploadCaptureArtifact(captureSessionId, {
        kind: 'video',
        file: recording.blob,
        fileName: 'screen-video.webm',
        duration_ms: recording.duration_ms,
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {
          source: 'screen_recording',
          artifact_type: 'capture.screen_video',
          surface: 'authenticated_app',
          company_slug: companySlug,
          mime_type: recording.mime_type,
          route_path: routePath,
          ...(collabMode ? { collab_mode: collabMode } : {}),
        },
      })
      const clipManifest = buildVideoClipManifestBlob({
        captureSessionId,
        recording,
        reason: 'recording_stopped',
        routePath,
        videoArtifactId: videoUpload.artifact.id,
        metadata: {
          source: 'screen_recording',
          surface: 'authenticated_app',
          company_slug: companySlug,
          ...(collabMode ? { collab_mode: collabMode } : {}),
        },
      })
      if (clipManifest) {
        await uploadCaptureArtifact(captureSessionId, {
          kind: 'video_clip_manifest',
          file: clipManifest,
          fileName: 'video-clip-manifest.json',
          pii_level: 'internal',
          access_policy: 'support_only',
          metadata: {
            source: 'screen_recording',
            artifact_type: 'capture.video_clip_manifest',
            surface: 'authenticated_app',
            company_slug: companySlug,
            route_path: routePath,
            ...(collabMode ? { collab_mode: collabMode } : {}),
          },
        })
      }
      await uploadRegisteredCaptureStateSnapshots(captureSessionId, {
        reason: 'screen_recording_stopped',
        metadata: {
          source: 'screen_recording',
          surface: 'authenticated_app',
          company_slug: companySlug,
          trigger: 'screen_recording_stop',
          ...(collabMode ? { collab_mode: collabMode } : {}),
        },
      })
      await uploadRegisteredCaptureArtifacts(captureSessionId, {
        source: 'screen_recording',
        surface: 'authenticated_app',
        company_slug: companySlug,
        trigger: 'screen_recording_stop',
        ...(collabMode ? { collab_mode: collabMode } : {}),
      })
      const finalize = await finalizeCaptureSession(captureSessionId, {
        title: 'In-app screen recording',
        summary: trimmedNote || 'Authenticated user recorded screen feedback.',
        severity: 'normal',
        lane: 'triage',
        route_path: routePath,
        route: routePath,
        category: 'record_feedback',
      })
      setReceipt(receiptFromFinalize(finalize))
      setBundleCopyState('idle')
      clearLocalCaptureSession()
      screenRecorderRef.current = null
      setNote('')
      setRecordingKind(null)
      setOpen(false)
      // P1 — STICKY RECEIPT: no auto-reset timer; user closes the card.
      setState('sent')
    } catch (err) {
      setState('error')
      setError(captureErrorMessage(err, 'Screen recording could not be sent.'))
    }
  }

  async function discardRecording() {
    if (recordingKind === 'repro') {
      await discardRepro()
      return
    }
    if (recordingKind === 'screen') {
      await discardScreenRecording()
      return
    }
    const captureSessionId = controllerRef.current?.activeCaptureSessionId
    if (captureSessionId) {
      await appendFeedbackEvent(captureSessionId, 'authenticated.feedback.recording_discarded').catch(() => undefined)
    }
    try {
      await controllerRef.current?.discard()
      controllerRef.current = null
      clearLocalCaptureSession()
      setNote('')
      setRecordingKind(null)
      setOpen(false)
      setError(null)
      setState('idle')
    } catch (err) {
      setState('error')
      setError(captureErrorMessage(err, 'Feedback could not be discarded.'))
    }
  }

  async function discardScreenRecording() {
    const captureSessionId = getActiveCaptureSession()?.id
    if (captureSessionId) {
      await appendFeedbackEvent(captureSessionId, 'authenticated.feedback.screen_recording_discarded').catch(
        () => undefined,
      )
    }
    screenRecorderRef.current?.cancel()
    try {
      if (captureSessionId) await discardCaptureSession(captureSessionId)
      screenRecorderRef.current = null
      clearLocalCaptureSession()
      setNote('')
      setRecordingKind(null)
      setOpen(false)
      setError(null)
      setState('idle')
    } catch (err) {
      setState('error')
      setError(captureErrorMessage(err, 'Screen recording could not be discarded.'))
    }
  }

  if (state === 'sent') {
    const markCount = receipt?.marks?.length ?? 0
    // P1 — PERSISTENT RECEIPT + actions. The card keeps the support packet +
    // work item ids and does NOT auto-dismiss; the user closes it with "Done".
    // "View issue" opens the internal /issues board entry (app_issue.view) for
    // the minted work item; "Copy agent bundle" fetches the support packet and
    // copies its ready-to-paste agent_prompt.
    return (
      <div style={narrow ? mobilePanelStyle : panelStyle}>
        <div style={panelHeaderStyle}>
          <div
            style={{
              ...panelTitleStyle,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--m-green)',
            }}
          >
            <CheckCircle size={16} aria-hidden />
            Issue sent
          </div>
          <button type="button" aria-label="Dismiss receipt" style={iconButtonStyle} onClick={dismissReceipt}>
            <X size={15} aria-hidden />
          </button>
        </div>
        {receipt ? (
          <div style={mutedStyle}>
            Support packet {receipt.supportPacketId} · work item {receipt.workItemId}
            {markCount ? ` · ${markCount} mark${markCount === 1 ? '' : 's'}` : ''}
          </div>
        ) : (
          <div style={mutedStyle}>Feedback sent.</div>
        )}
        {markCount ? (
          <div style={receiptMarksStyle}>
            {receipt!.marks!.map((mark, index) => (
              <div key={`${mark.at}:${index}`} style={receiptMarkRowStyle}>
                <span style={receiptMarkOffsetStyle}>{formatElapsed(mark.offset_ms)}</span>
                <span style={receiptMarkLabelStyle}>{mark.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        {receipt ? (
          <div style={actionsStyle}>
            <a
              href={`/issues/${encodeURIComponent(receipt.workItemId)}`}
              style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
            >
              <ExternalLink size={14} aria-hidden />
              View issue
            </a>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => void copyAgentBundle(receipt.supportPacketId)}
              disabled={bundleCopyState === 'copying'}
            >
              <ClipboardCopy size={14} aria-hidden />
              {bundleCopyState === 'copying'
                ? 'Copying…'
                : bundleCopyState === 'copied'
                  ? 'Copied'
                  : bundleCopyState === 'error'
                    ? 'Copy failed'
                    : 'Copy agent bundle'}
            </button>
            <button type="button" style={primaryButtonStyle} onClick={dismissReceipt}>
              Done
            </button>
          </div>
        ) : null}
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
          {buttonLabel}
        </button>
      </div>
    )
  }

  return (
    <div style={narrow ? mobilePanelStyle : panelStyle}>
      <div style={panelHeaderStyle}>
        <div style={panelTitleStyle}>
          {state === 'recording' ? recordingTitle : state === 'stopping' ? 'Sending feedback' : buttonLabel}
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
            placeholder={idlePlaceholder}
            rows={3}
            style={textareaStyle}
          />
          {error ? <div style={inlineErrorStyle}>{error}</div> : null}
          {/* P2 — denial fallback: when a mic/screen grant was declined, point
              the user at the no-prompt paths instead of leaving a dead end. */}
          {permissionDenied ? (
            <div style={mutedStyle}>
              No {permissionDenied === 'audio' ? 'microphone' : 'screen'} access — you can still “Send issue” or
              “Reproduce a bug” (no permission needed).
            </div>
          ) : null}
          <div style={actionsStyle}>
            <button type="button" style={secondaryButtonStyle} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={sendTextIssue} disabled={!note.trim()}>
              Send issue
            </button>
            {levelStreams.audio ? (
              <button
                type="button"
                // P2 — when the chosen level opts into audio, highlight Start so
                // the separate click + grant isn't misread as "already recording".
                style={primaryButtonStyle}
                onClick={startRecording}
                disabled={!audioSupported}
              >
                <Mic size={14} aria-hidden />
                {audioEnabled ? 'Start' : 'Record page'}
              </button>
            ) : null}
            {screenSupported && levelStreams.screen ? (
              <button type="button" style={primaryButtonStyle} onClick={startScreenRecording}>
                <ScreenShare size={14} aria-hidden />
                Record screen
              </button>
            ) : null}
            <button
              type="button"
              style={levelStreams.audio || levelStreams.screen ? secondaryButtonStyle : primaryButtonStyle}
              onClick={startRepro}
            >
              <Bug size={14} aria-hidden />
              Reproduce a bug
            </button>
          </div>
          <div style={levelRowStyle}>
            <label style={levelLabelStyle}>
              Capture
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value as CaptureLevel)}
                style={levelSelectStyle}
                aria-label="Recording level"
              >
                {offerableLevels.map((option) => (
                  <option key={option} value={option}>
                    {CAPTURE_LEVEL_META[option].label}
                  </option>
                ))}
              </select>
            </label>
            {captureHotkeysSupported() ? (
              <label style={hotkeyToggleStyle} title={hotkeyHintText()}>
                <input type="checkbox" checked={hotkeysEnabled} onChange={(e) => setHotkeysEnabled(e.target.checked)} />
                Shortcuts
              </label>
            ) : null}
          </div>
          {/* P2 — DISAMBIGUATE LEVEL vs ACTION. Picking a level only OFFERS a
              stream; it never starts a recording. Make the copy conditional so
              audio/screen rungs read as "press Start/Record to begin", and the
              floor ('note') just describes the auto-attached context. */}
          <div style={mutedStyle}>
            {levelStreams.screen
              ? 'If you record, capture: screen video + your actions. Press “Record screen” to begin (your browser will ask first).'
              : levelStreams.audio
                ? 'If you record, capture: your voice + your actions. Press “Start” to begin (your browser will ask first).'
                : CAPTURE_LEVEL_META[level].description}
          </div>
          {/* P2 — PRE-ARM PERMISSION COPY: shown while the browser prompt is up. */}
          {permissionHint ? <div style={mutedStyle}>{permissionHint}</div> : null}
        </>
      ) : null}

      {state === 'recording' && recordingKind === 'repro' ? (
        <>
          <div style={reproStatusStyle}>
            <span style={reproTimerStyle}>
              <Timer size={13} aria-hidden /> {formatElapsed(reproElapsedMs)}
            </span>
            <span style={mutedStyle}>
              {reproMarkCount} mark{reproMarkCount === 1 ? '' : 's'}
              {levelStreams.domReplay ? ' · screen replay on' : ''}
            </span>
          </div>
          {/* P1 — TWO-FIELD REPRO NOTES. The start note the user typed before
              recording is shown read-only here, so the end-condition field below
              is clearly a SECOND note (start + end) and the start text is never
              lost when the same textarea is reused for the end condition. */}
          {reproStartNote ? (
            <div style={reproStartNoteStyle}>
              <span style={reproStartNoteLabelStyle}>Start condition</span>
              <span>{reproStartNote}</span>
            </div>
          ) : null}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={reproStartNote ? 'End condition — what went wrong?' : 'What went wrong? (the end condition)'}
            rows={2}
            style={textareaStyle}
            aria-label="End condition"
          />
          <div style={markRowStyle}>
            <input
              type="text"
              value={markLabel}
              onChange={(e) => setMarkLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void markRepro()
                }
              }}
              placeholder="Label this moment (optional)"
              style={markInputStyle}
            />
            <button type="button" style={markButtonStyle} onClick={markRepro}>
              <Flag size={14} aria-hidden />
              Mark this moment
            </button>
          </div>
          <div style={actionsStyle}>
            <button type="button" style={secondaryButtonStyle} onClick={discardRepro}>
              <X size={14} aria-hidden />
              Discard
            </button>
            <button type="button" style={primaryButtonStyle} onClick={endRepro}>
              <Square size={14} aria-hidden />
              End &amp; report
            </button>
          </div>
        </>
      ) : state === 'recording' ? (
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

// Bottom-sheet variant for phones/narrow tablets: full-width across the bottom
// with a larger touch target and safe-area padding, instead of the floating
// desktop card.
const mobilePanelStyle: React.CSSProperties = {
  ...panelStyle,
  left: 8,
  right: 8,
  width: 'auto',
  maxWidth: 'none',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
  borderRadius: 14,
  padding: 16,
}

const levelRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
}

const levelLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--m-ink-3, #667085)',
}

const levelSelectStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--m-line, var(--p-line))',
  background: 'var(--m-card, var(--p-paper, #fff))',
  color: 'var(--m-ink, var(--p-ink, #111827))',
}

const hotkeyToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--m-ink-3, #667085)',
  cursor: 'pointer',
}

const reproStatusStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

// P1 — read-only START-condition context shown above the end-condition field
// during a reproduction, so both notes (start + end) stay visible.
const reproStartNoteStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  padding: '6px 10px',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--m-ink-2, #333)',
  background: 'var(--m-card-soft, rgba(0,0,0,0.04))',
  border: '1px solid var(--m-line, rgba(0,0,0,0.08))',
}

const reproStartNoteLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--m-ink-3, #667085)',
}

const reproTimerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 700,
  fontSize: 13,
  color: 'var(--m-red, #b42318)',
}

const markRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
}

const markInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  padding: '7px 8px',
  borderRadius: 8,
  border: '1px solid var(--m-line, var(--p-line))',
}

const markButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  justifyContent: 'center',
  whiteSpace: 'nowrap',
}

// STEP5-UI: the per-mark receipt list shown after a multi-mark reproduction
// is filed, so the reviewer sees exactly which moments were surfaced.
const receiptMarksStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  maxWidth: 320,
  padding: '8px 12px',
  borderRadius: 10,
  background: 'var(--m-card-soft, rgba(0,0,0,0.04))',
  border: '1px solid var(--m-line, rgba(0,0,0,0.08))',
}

const receiptMarkRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'baseline',
  fontSize: 12,
}

const receiptMarkOffsetStyle: React.CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 700,
  color: 'var(--m-ink-3, #6b6b6b)',
  flexShrink: 0,
}

const receiptMarkLabelStyle: React.CSSProperties = {
  color: 'var(--m-ink-2, #333)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function hotkeyHintText(): string {
  return DEFAULT_CAPTURE_HOTKEYS.map((binding) => `${formatCaptureHotkey(binding)} — ${binding.label}`).join('\n')
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
