import type { CaptureRecordingResult } from './capture-recorder'

export type VideoClipManifestInput = {
  captureSessionId: string
  recording: CaptureRecordingResult
  reason: string
  routePath: string
  videoArtifactId?: string | null
  metadata?: Record<string, unknown>
}

export function buildVideoClipManifestBlob(input: VideoClipManifestInput): Blob | null {
  const chunks = input.recording.chunks ?? []
  if (chunks.length === 0) return null
  const now = new Date().toISOString()
  const manifest = {
    kind: 'video_clip_manifest',
    schema_version: 1,
    capture_session_id: input.captureSessionId,
    clip_id: newClipId(input.captureSessionId),
    reason: input.reason,
    route_path: input.routePath,
    created_at: now,
    window_ms: {
      start: 0,
      end: input.recording.duration_ms,
      relative_to: 'recording_started',
    },
    source_artifacts: input.videoArtifactId ? [input.videoArtifactId] : [],
    chunks: chunks.map((chunk) => ({
      seq: chunk.seq,
      start_ms: chunk.start_ms,
      end_ms: chunk.end_ms,
      byte_size: chunk.byte_size,
      content_type: chunk.content_type,
    })),
    metadata: input.metadata ?? {},
  }
  return new Blob([JSON.stringify(manifest)], { type: 'application/json' })
}

function newClipId(captureSessionId: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // Fall through to deterministic-enough browser fallback.
  }
  return `${captureSessionId}:clip:${Date.now()}`
}
