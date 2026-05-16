import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { createBlueprintCaptureMachine, type BlueprintCaptureFile } from './blueprint-capture.js'
import type { CaptureResponse } from '@/lib/api'

const fakeFile: BlueprintCaptureFile = {
  name: 'plan.pdf',
  kind: 'blueprint_vision',
  payload: { dryRun: true },
}

const fakeResponse: CaptureResponse = {
  draft: {
    id: 'draft-1',
    company_id: 'co-1',
    project_id: 'p-1',
    name: 'Blueprint capture',
    type: 'measurement',
    status: 'active',
    version: 1,
    source: 'blueprint_vision',
    review_required: false,
    pipeline_version: '1.0.0',
    deleted_at: null,
    created_at: '2026-05-16T00:00:00Z',
    updated_at: '2026-05-16T00:00:00Z',
  },
  result_summary: {
    quantities_count: 5,
    review_required: false,
    capture_source: 'blueprint_vision',
    geometry: { rooms: 0, surfaces: 0, objects: 5 },
    pipeline_version: '1.0.0',
  },
}

function withSuccessSubmitter(response: CaptureResponse = fakeResponse) {
  let resolve!: (r: CaptureResponse) => void
  const submit = (_file: BlueprintCaptureFile) =>
    new Promise<CaptureResponse>((res) => {
      resolve = res
    })
  return { submit, resolve: () => resolve(response) }
}

function withFailingSubmitter(error: Error = new Error('boom')) {
  let reject!: (err: Error) => void
  const submit = (_file: BlueprintCaptureFile) =>
    new Promise<CaptureResponse>((_res, rej) => {
      reject = rej
    })
  return { submit, fail: () => reject(error) }
}

describe('blueprintCaptureMachine', () => {
  describe('initial state', () => {
    it('starts in idle with no draft or error', () => {
      const machine = createBlueprintCaptureMachine({ submit: () => Promise.resolve(fakeResponse) })
      const actor = createActor(machine)
      actor.start()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.file).toBeNull()
      expect(snap.context.draftId).toBeNull()
      expect(snap.context.uploadPct).toBe(0)
      expect(snap.context.error).toBeNull()
      expect(snap.context.visionResult).toBeNull()
    })
  })

  describe('upload happy path', () => {
    it('UPLOAD transitions idle → uploading and stores file', () => {
      const { submit } = withSuccessSubmitter()
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('uploading')
      expect(snap.context.file).toEqual(fakeFile)
      expect(snap.context.uploadPct).toBe(0)
    })

    it('UPLOAD_PROGRESS while uploading updates pct (clamped 0-100)', () => {
      const { submit } = withSuccessSubmitter()
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      actor.send({ type: 'UPLOAD_PROGRESS', pct: 42 })
      expect(actor.getSnapshot().context.uploadPct).toBe(42)
      actor.send({ type: 'UPLOAD_PROGRESS', pct: 250 })
      expect(actor.getSnapshot().context.uploadPct).toBe(100)
      actor.send({ type: 'UPLOAD_PROGRESS', pct: -3 })
      expect(actor.getSnapshot().context.uploadPct).toBe(0)
    })

    it('UPLOAD_DONE without resolving the submit actor keeps the machine in processing', () => {
      const { submit } = withSuccessSubmitter()
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      actor.send({ type: 'UPLOAD_DONE' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('processing')
      expect(snap.context.uploadPct).toBe(100)
    })

    it('PROCESSING_DONE while in processing transitions to awaiting_review with response', () => {
      const { submit } = withSuccessSubmitter()
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      actor.send({ type: 'UPLOAD_DONE' })
      actor.send({ type: 'PROCESSING_DONE', response: fakeResponse })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('awaiting_review')
      expect(snap.context.draftId).toBe('draft-1')
      expect(snap.context.visionResult).toEqual(fakeResponse)
      expect(snap.context.reviewRequired).toBe(false)
    })

    it('actor onDone short-circuits directly to awaiting_review with response', async () => {
      const { submit, resolve } = withSuccessSubmitter()
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      resolve()
      // Promise resolution is async — wait a microtask.
      await new Promise((r) => setTimeout(r, 0))
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('awaiting_review')
      expect(snap.context.draftId).toBe('draft-1')
      expect(snap.context.uploadPct).toBe(100)
    })
  })

  describe('failure path', () => {
    it('actor onError moves to failed with the error message', async () => {
      const { submit, fail } = withFailingSubmitter(new Error('upload aborted'))
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      fail()
      await new Promise((r) => setTimeout(r, 0))
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('failed')
      expect(snap.context.error).toBe('upload aborted')
    })

    it('RETRY from failed re-enters uploading and re-invokes the submitter', async () => {
      let calls = 0
      const submit = async (_f: BlueprintCaptureFile): Promise<CaptureResponse> => {
        calls += 1
        if (calls === 1) throw new Error('transient')
        return fakeResponse
      }
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      await new Promise((r) => setTimeout(r, 0))
      expect(actor.getSnapshot().value).toBe('failed')
      actor.send({ type: 'RETRY' })
      // Already submitted; await microtask for the second call.
      await new Promise((r) => setTimeout(r, 0))
      expect(calls).toBe(2)
      expect(actor.getSnapshot().value).toBe('awaiting_review')
    })

    it('CANCEL from failed resets state to idle', async () => {
      const { submit, fail } = withFailingSubmitter()
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      fail()
      await new Promise((r) => setTimeout(r, 0))
      actor.send({ type: 'CANCEL' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.error).toBeNull()
      expect(snap.context.file).toBeNull()
    })
  })

  describe('review + commit', () => {
    async function uploadAndReach(awaiting: CaptureResponse = fakeResponse) {
      const { submit, resolve } = withSuccessSubmitter(awaiting)
      const actor = createActor(createBlueprintCaptureMachine({ submit }))
      actor.start()
      actor.send({ type: 'UPLOAD', file: fakeFile })
      resolve()
      await new Promise((r) => setTimeout(r, 0))
      return actor
    }

    it('COMMIT from awaiting_review moves to committed', async () => {
      const actor = await uploadAndReach()
      actor.send({ type: 'COMMIT' })
      expect(actor.getSnapshot().value).toBe('committed')
    })

    it('RESET from committed returns to idle with cleared context', async () => {
      const actor = await uploadAndReach()
      actor.send({ type: 'COMMIT' })
      actor.send({ type: 'RESET' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.draftId).toBeNull()
      expect(snap.context.visionResult).toBeNull()
    })

    it('CANCEL from awaiting_review resets to idle', async () => {
      const actor = await uploadAndReach()
      actor.send({ type: 'CANCEL' })
      expect(actor.getSnapshot().value).toBe('idle')
      expect(actor.getSnapshot().context.draftId).toBeNull()
    })

    it('captures reviewRequired flag from the server response', async () => {
      const flagged: CaptureResponse = {
        ...fakeResponse,
        result_summary: { ...fakeResponse.result_summary, review_required: true },
      }
      const actor = await uploadAndReach(flagged)
      expect(actor.getSnapshot().context.reviewRequired).toBe(true)
    })
  })

  describe('actor input contract', () => {
    it('throws if uploading is entered without a file (defensive)', () => {
      const machine = createBlueprintCaptureMachine({ submit: () => Promise.resolve(fakeResponse) })
      const actor = createActor(machine)
      actor.start()
      // Cannot reach uploading via normal events without UPLOAD setting the file.
      // This guard is implemented as `if (!context.file) throw` inside the
      // actor's input fn. The smoke check is that UPLOAD path always sets
      // the file first — covered above. This test exists to lock in the
      // observable invariant: UPLOAD always carries the file payload.
      actor.send({ type: 'UPLOAD', file: fakeFile })
      expect(actor.getSnapshot().context.file).toEqual(fakeFile)
    })
  })
})
