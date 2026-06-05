export type CaptureStream =
  | 'audio'
  | 'dom_replay'
  | 'live_webrtc'
  | 'native_video'
  | 'product_events'
  | 'registered_artifacts'
  | 'request_ids'
  | 'screen_audio'
  | 'screen_video'
  | 'state_snapshots'
  | 'text_note'

export type CaptureArtifactKind =
  | 'audio'
  | 'canvas_geometry'
  | 'repro_bracket'
  | 'rrweb'
  | 'screen_context'
  | 'state_snapshot'
  | 'text_note'
  | 'transcript'
  | 'video'
  | 'video_clip_manifest'

export type CaptureConsentScope = Record<string, unknown> & {
  streams: CaptureStream[]
  artifacts: Partial<Record<CaptureArtifactKind, boolean>>
  event_classes: string[]
  audio: boolean
  dom_replay: boolean
  registered_artifacts: boolean
  screen_video: boolean
  text_note: boolean
}

type AuthenticatedFeedbackConsentArgs = {
  audio: boolean
  domReplay: boolean
  registeredArtifacts?: boolean
}

type PortalFeedbackConsentArgs = {
  surface: 'estimate_portal' | 'rental_portal'
  domReplay: boolean
}

const REGISTERED_ARTIFACTS: Partial<Record<CaptureArtifactKind, boolean>> = {
  canvas_geometry: true,
  screen_context: true,
  state_snapshot: true,
}

function withModeBooleans(args: {
  surface?: string
  portal_surface?: string
  streams: CaptureStream[]
  artifacts: Partial<Record<CaptureArtifactKind, boolean>>
  event_classes: string[]
}): CaptureConsentScope {
  const streams = Array.from(new Set(args.streams))
  return {
    ...(args.surface ? { surface: args.surface } : {}),
    ...(args.portal_surface ? { portal_surface: args.portal_surface } : {}),
    streams,
    artifacts: args.artifacts,
    event_classes: Array.from(new Set(args.event_classes)),
    audio: streams.includes('audio') || streams.includes('screen_audio'),
    dom_replay: streams.includes('dom_replay'),
    registered_artifacts: streams.includes('registered_artifacts'),
    screen_video: streams.includes('screen_video'),
    text_note: streams.includes('text_note'),
  }
}

export function buildAuthenticatedFeedbackConsentScope({
  audio,
  domReplay,
  registeredArtifacts = true,
}: AuthenticatedFeedbackConsentArgs): CaptureConsentScope {
  const streams: CaptureStream[] = [
    ...(audio ? (['audio'] as const) : []),
    ...(domReplay ? (['dom_replay'] as const) : []),
    ...(registeredArtifacts ? (['registered_artifacts'] as const) : []),
    'text_note',
  ]
  return withModeBooleans({
    surface: 'authenticated_app',
    streams,
    artifacts: {
      ...(audio ? { audio: true, transcript: true } : {}),
      ...(domReplay ? { rrweb: true } : {}),
      ...(registeredArtifacts ? REGISTERED_ARTIFACTS : {}),
      text_note: true,
    },
    event_classes: ['authenticated_feedback'],
  })
}

export function buildAuthenticatedTextIssueConsentScope(): CaptureConsentScope {
  return withModeBooleans({
    surface: 'authenticated_app',
    streams: ['text_note', 'registered_artifacts'],
    artifacts: {
      ...REGISTERED_ARTIFACTS,
      text_note: true,
    },
    event_classes: ['authenticated_feedback'],
  })
}

export function buildAuthenticatedScreenRecordingConsentScope(): CaptureConsentScope {
  return withModeBooleans({
    surface: 'authenticated_app',
    streams: ['screen_video', 'text_note', 'registered_artifacts'],
    artifacts: {
      ...REGISTERED_ARTIFACTS,
      text_note: true,
      video: true,
      video_clip_manifest: true,
    },
    event_classes: ['authenticated_feedback'],
  })
}

/**
 * Reproduction-bracket consent scope. A reproduction is a user-bracketed
 * "start condition → steps → end condition" recording (see
 * `repro-bracket.ts`). It always allows the typed note, registered state
 * snapshots (the before/after conditions), and the `repro_bracket` summary
 * artifact; DOM replay is layered in only when the chosen capture level
 * includes it. Audio/screen-video stay on their own explicit controls and are
 * NOT implied by a reproduction bracket.
 */
export function buildReproBracketConsentScope({ domReplay }: { domReplay: boolean }): CaptureConsentScope {
  const streams: CaptureStream[] = [
    ...(domReplay ? (['dom_replay'] as const) : []),
    'registered_artifacts',
    'text_note',
  ]
  return withModeBooleans({
    surface: 'authenticated_app',
    streams,
    artifacts: {
      ...(domReplay ? { rrweb: true } : {}),
      ...REGISTERED_ARTIFACTS,
      text_note: true,
      repro_bracket: true,
    },
    event_classes: ['repro', 'authenticated_feedback'],
  })
}

export function buildPortalFeedbackConsentScope({
  surface,
  domReplay,
}: PortalFeedbackConsentArgs): CaptureConsentScope {
  return withModeBooleans({
    portal_surface: surface,
    streams: ['audio', ...(domReplay ? (['dom_replay'] as const) : []), 'registered_artifacts'],
    artifacts: {
      audio: true,
      transcript: true,
      ...(domReplay ? { rrweb: true } : {}),
      ...REGISTERED_ARTIFACTS,
    },
    event_classes: ['portal_feedback'],
  })
}
