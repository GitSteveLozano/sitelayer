import { describe, expect, it } from 'vitest'
import { OfflineQueuePayloadError, enqueueOfflineMutation } from './queue'

/**
 * IndexedDB isn't wired up in jsdom by default; these tests only exercise
 * the synchronous validation that runs *before* any IDB write happens.
 * Once a Blob lands in an illegal slot, `validatePayloadBlobs` throws
 * synchronously and we never reach the IDB call.
 */
describe('enqueueOfflineMutation — Blob safety', () => {
  it('rejects a Blob at a non-allow-listed top-level slot', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    await expect(enqueueOfflineMutation('clock_in', { project_id: 'p1', evidence: blob })).rejects.toBeInstanceOf(
      OfflineQueuePayloadError,
    )
  })

  it('rejects a nested Blob even in a kind that allows top-level Blobs', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    // daily_log_photo_upload allows `file` at the top level. A nested
    // Blob anywhere else is rejected so callers don't silently rely on
    // structured-clone preserving Blobs through every downstream pipe.
    await expect(
      enqueueOfflineMutation('daily_log_photo_upload', {
        id: 'log1',
        file: blob,
        meta: { thumbnail: blob },
      }),
    ).rejects.toBeInstanceOf(OfflineQueuePayloadError)
  })

  it('rejects a Blob in an array', async () => {
    const blob = new Blob(['x'])
    await expect(
      enqueueOfflineMutation('daily_log_patch', {
        id: 'log1',
        input: { attachments: [blob] },
      }),
    ).rejects.toBeInstanceOf(OfflineQueuePayloadError)
  })

  it('allows worker issue attachment Blobs under the attachments slot', async () => {
    const blob = new Blob(['photo'], { type: 'image/jpeg' })
    let error: unknown
    try {
      await enqueueOfflineMutation('worker_issue_submit', {
        companySlug: 'acme',
        body: { kind: 'safety', message: 'Crew stopped', severity: 'stopped' },
        attachments: [{ kind: 'photo', payload: blob, fileName: 'site.jpg' }],
      })
    } catch (err) {
      error = err
    }
    expect(error).not.toBeInstanceOf(OfflineQueuePayloadError)
  })

  it('attaches the offending path to the error', async () => {
    const blob = new Blob(['x'])
    try {
      await enqueueOfflineMutation('clock_in', { evidence: blob })
      throw new Error('expected throw')
    } catch (err) {
      if (!(err instanceof OfflineQueuePayloadError)) throw err
      expect(err.kind).toBe('clock_in')
      expect(err.path).toBe('evidence')
    }
  })

  // We can't easily assert the happy-path enqueue here because IndexedDB
  // isn't available in jsdom. The replay handler (replay.ts:154-171)
  // covers the inverse case — replay throws a 400 if the queued payload
  // somehow lost its Blob.
})
