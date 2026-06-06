import { describe, expect, it } from 'vitest'
import { buildVideoClipManifestBlob } from './capture-video-manifest'

describe('capture video manifest', () => {
  it('skips manifest creation when the recording has no chunk metadata', () => {
    const blob = buildVideoClipManifestBlob({
      captureSessionId: '00000000-0000-4000-8000-000000000123',
      recording: {
        blob: new Blob(['video'], { type: 'video/webm' }),
        duration_ms: 1000,
        mime_type: 'video/webm',
      },
      reason: 'manual_feedback',
      routePath: '/desktop/takeoff',
    })

    expect(blob).toBeNull()
  })

  it('builds a JSON clip manifest from recorder chunks', async () => {
    const blob = buildVideoClipManifestBlob({
      captureSessionId: '00000000-0000-4000-8000-000000000123',
      recording: {
        blob: new Blob(['video'], { type: 'video/webm' }),
        duration_ms: 8000,
        mime_type: 'video/webm',
        chunks: [
          {
            seq: 0,
            start_ms: 0,
            end_ms: 5000,
            byte_size: 100,
            content_type: 'video/webm',
          },
          {
            seq: 1,
            start_ms: 5000,
            end_ms: 8000,
            byte_size: 80,
            content_type: 'video/webm',
          },
        ],
      },
      reason: 'manual_feedback',
      routePath: '/desktop/takeoff',
      videoArtifactId: 'artifact-1',
      metadata: { surface: 'authenticated_app' },
    })

    expect(blob?.type).toBe('application/json')
    await expect(blob?.text().then((text) => JSON.parse(text) as Record<string, unknown>)).resolves.toMatchObject({
      kind: 'video_clip_manifest',
      schema_version: 1,
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      clip_id: expect.any(String),
      reason: 'manual_feedback',
      route_path: '/desktop/takeoff',
      window_ms: {
        start: 0,
        end: 8000,
        relative_to: 'recording_started',
      },
      source_artifacts: ['artifact-1'],
      chunks: [
        {
          seq: 0,
          start_ms: 0,
          end_ms: 5000,
          byte_size: 100,
          content_type: 'video/webm',
        },
        {
          seq: 1,
          start_ms: 5000,
          end_ms: 8000,
          byte_size: 80,
          content_type: 'video/webm',
        },
      ],
      metadata: { surface: 'authenticated_app' },
    })
  })
})
