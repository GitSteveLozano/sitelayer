import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCaptureStateProvidersForTests,
  registerCaptureStateProvider,
  uploadRegisteredCaptureStateSnapshots,
} from './capture-state-providers'
import type { CaptureArtifactUploadInput, CaptureArtifactUploadResponse } from './api/capture-sessions'

describe('capture state providers', () => {
  afterEach(() => {
    __resetCaptureStateProvidersForTests()
  })

  it('uploads sanitized state snapshots from registered providers', async () => {
    const upload = vi.fn(async (_captureSessionId: string, _input: CaptureArtifactUploadInput) => ({
      artifact: {
        id: 'artifact-1',
        kind: 'state_snapshot',
        storage_key: 'capture/state.json',
        content_type: 'application/json',
        byte_size: 10,
        content_hash: 'sha256:test',
        redaction_version: 'capture-session-v1',
      },
    })) satisfies (
      captureSessionId: string,
      input: CaptureArtifactUploadInput,
    ) => Promise<CaptureArtifactUploadResponse>
    registerCaptureStateProvider('route:test', ({ reason }) => ({
      schema: 'test.route-state.v1',
      payload: {
        route: '/projects/1',
        reason,
        nested: {
          token: 'secret-token',
          visible_state: 'editing',
        },
      },
      metadata: { route_state: true },
    }))

    const results = await uploadRegisteredCaptureStateSnapshots('capture-1', {
      reason: 'issue_submitted',
      metadata: { surface: 'authenticated_app' },
      upload,
    })

    expect(results).toEqual([
      {
        id: 'route:test',
        status: 'uploaded',
        artifact: expect.objectContaining({ artifact: expect.objectContaining({ id: 'artifact-1' }) }),
      },
    ])
    expect(upload).toHaveBeenCalledWith(
      'capture-1',
      expect.objectContaining({
        kind: 'state_snapshot',
        fileName: 'route-test-state_snapshot.json',
        pii_level: 'internal',
        access_policy: 'support_only',
        metadata: expect.objectContaining({
          source: 'capture_state_provider',
          artifact_type: 'capture.state_snapshot',
          provider_id: 'route:test',
          reason: 'issue_submitted',
          schema: 'test.route-state.v1',
          surface: 'authenticated_app',
          route_state: true,
        }),
      }),
    )
    const uploadedInput = upload.mock.calls[0]?.[1] as CaptureArtifactUploadInput | undefined
    const body = JSON.parse(await (uploadedInput?.file as Blob).text()) as Record<string, unknown>
    expect(body).toMatchObject({
      artifact_type: 'capture.state_snapshot',
      provider_id: 'route:test',
      reason: 'issue_submitted',
      schema: 'test.route-state.v1',
      payload: {
        route: '/projects/1',
        reason: 'issue_submitted',
        nested: { visible_state: 'editing' },
      },
    })
    expect(JSON.stringify(body)).not.toContain('secret-token')
  })

  it('reports provider failures without stopping other providers', async () => {
    const upload = vi.fn(async (_captureSessionId: string, _input: CaptureArtifactUploadInput) => ({
      artifact: {
        id: 'artifact-1',
        kind: 'state_snapshot',
        storage_key: 'capture/state.json',
        content_type: 'application/json',
        byte_size: 10,
        content_hash: 'sha256:test',
        redaction_version: 'capture-session-v1',
      },
    })) satisfies (
      captureSessionId: string,
      input: CaptureArtifactUploadInput,
    ) => Promise<CaptureArtifactUploadResponse>
    registerCaptureStateProvider('state:bad', () => {
      throw new Error('provider failed')
    })
    registerCaptureStateProvider('state:empty', () => null)
    registerCaptureStateProvider('state:ok', () => ({ schema: 'ok.v1', payload: { state: 'ready' } }))

    await expect(
      uploadRegisteredCaptureStateSnapshots('capture-1', {
        reason: 'recording_stopped',
        upload,
      }),
    ).resolves.toEqual([
      { id: 'state:bad', status: 'failed', error: 'provider failed' },
      { id: 'state:empty', status: 'skipped' },
      {
        id: 'state:ok',
        status: 'uploaded',
        artifact: expect.objectContaining({ artifact: expect.objectContaining({ id: 'artifact-1' }) }),
      },
    ])
    expect(upload).toHaveBeenCalledTimes(1)
  })
})
