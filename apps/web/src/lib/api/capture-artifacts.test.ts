import { describe, expect, it } from 'vitest'
import { readCaptureArtifactsFromServerContext } from './capture-sessions'

describe('readCaptureArtifactsFromServerContext', () => {
  it('returns [] for non-object / missing capture_session / missing artifacts', () => {
    expect(readCaptureArtifactsFromServerContext(null)).toEqual([])
    expect(readCaptureArtifactsFromServerContext('nope')).toEqual([])
    expect(readCaptureArtifactsFromServerContext({})).toEqual([])
    expect(readCaptureArtifactsFromServerContext({ capture_session: {} })).toEqual([])
    expect(readCaptureArtifactsFromServerContext({ capture_session: { artifacts: 'x' } })).toEqual([])
  })

  it('reads well-formed artifacts and drops malformed rows (no id)', () => {
    const out = readCaptureArtifactsFromServerContext({
      capture_session: {
        artifacts: [
          {
            id: 'a1',
            kind: 'video',
            content_type: 'video/webm',
            byte_size: '12345',
            duration_ms: 4200,
            pii_level: 'internal',
            access_policy: 'operator_only',
            created_at: '2026-06-05T14:00:00Z',
          },
          { kind: 'audio' }, // no id -> dropped
          'garbage',
        ],
      },
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'a1', kind: 'video', content_type: 'video/webm', byte_size: '12345' })
  })

  it('defaults missing optional fields without throwing', () => {
    const out = readCaptureArtifactsFromServerContext({
      capture_session: { artifacts: [{ id: 'b2' }] },
    })
    expect(out[0]).toEqual({
      id: 'b2',
      kind: 'unknown',
      content_type: null,
      byte_size: null,
      duration_ms: null,
      pii_level: null,
      access_policy: null,
      created_at: null,
    })
  })
})
