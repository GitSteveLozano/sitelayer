export type CaptureConsentScope = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function valuesFrom(value: unknown): Set<string> {
  const values = new Set<string>()
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) values.add(item.trim())
    }
    return values
  }
  if (isRecord(value)) {
    for (const [key, enabled] of Object.entries(value)) {
      if (truthy(enabled)) values.add(key)
    }
  }
  return values
}

export function hasExplicitCaptureConsentPolicy(scope: CaptureConsentScope | null | undefined): boolean {
  if (!isRecord(scope)) return false
  return (
    'streams' in scope ||
    'artifacts' in scope ||
    'event_classes' in scope ||
    'audio' in scope ||
    'dom_replay' in scope ||
    'registered_artifacts' in scope ||
    'screen_video' in scope ||
    'screen_audio' in scope ||
    'text_note' in scope
  )
}

export function captureConsentAllowsEventClass(
  scope: CaptureConsentScope | null | undefined,
  eventClass: string,
): boolean {
  if (!isRecord(scope)) return true
  if (!('event_classes' in scope)) return true
  const allowed = valuesFrom(scope.event_classes)
  return allowed.size === 0 || allowed.has(eventClass)
}

export function captureConsentAllowsArtifactKind(scope: CaptureConsentScope | null | undefined, kind: string): boolean {
  if (!isRecord(scope) || !hasExplicitCaptureConsentPolicy(scope)) return true
  const streams = valuesFrom(scope.streams)
  const artifacts = valuesFrom(scope.artifacts)
  if (artifacts.has(kind)) return true

  switch (kind) {
    case 'audio':
      return truthy(scope.audio) || streams.has('audio') || streams.has('screen_audio')
    case 'transcript':
      return artifacts.has('transcript') || truthy(scope.audio) || streams.has('audio') || streams.has('screen_audio')
    case 'rrweb':
      return truthy(scope.dom_replay) || streams.has('dom_replay')
    case 'video':
      return truthy(scope.screen_video) || streams.has('screen_video') || streams.has('native_video')
    case 'video_clip_manifest':
      return (
        artifacts.has('video_clip_manifest') ||
        truthy(scope.screen_video) ||
        streams.has('screen_video') ||
        streams.has('native_video')
      )
    case 'text_note':
      return truthy(scope.text_note) || streams.has('text_note')
    case 'repro_bracket':
      // The reproduction-bracket summary artifact is structured, low-PII JSON
      // (start/end conditions + ordered marks). Allow it when the scope opts
      // into it explicitly or carries the registered-artifacts grant.
      return artifacts.has('repro_bracket') || truthy(scope.registered_artifacts) || streams.has('registered_artifacts')
    case 'canvas_geometry':
    case 'screen_context':
    case 'state_snapshot':
      return truthy(scope.registered_artifacts) || streams.has('registered_artifacts')
    default:
      return truthy(scope.registered_artifacts) || streams.has('registered_artifacts')
  }
}
