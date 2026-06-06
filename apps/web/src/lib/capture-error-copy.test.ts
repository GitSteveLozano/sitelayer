import { describe, expect, it } from 'vitest'
import { ApiError } from './api/client'
import { captureErrorMessage } from './capture-error-copy'

describe('captureErrorMessage', () => {
  it('uses API-provided user-facing messages', () => {
    expect(
      captureErrorMessage(
        new ApiError({
          status: 403,
          path: '/api/capture-sessions/1/artifacts/upload',
          method: 'POST',
          requestId: 'req-1',
          body: { error: 'capture consent does not allow artifact kind "audio"' },
        }),
        'Upload failed.',
      ),
    ).toBe('capture consent does not allow artifact kind "audio"')
  })

  it('maps browser permission errors to retryable capture copy', () => {
    const error = new DOMException('Permission denied', 'NotAllowedError')
    expect(captureErrorMessage(error, 'Recording could not start.')).toBe(
      'Permission was denied. Use the browser permission prompt or send a text issue instead.',
    )
  })

  it('treats screen-picker cancellation as a non-terminal retry path', () => {
    const error = new DOMException('The user aborted a request.', 'AbortError')
    expect(captureErrorMessage(error, 'Screen recording could not start.')).toBe(
      'Capture was cancelled. You can retry or send a text issue.',
    )
  })
})
