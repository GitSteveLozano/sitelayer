import { useCallback } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import type { CaptureKind, CaptureResponse, TakeoffDraft } from '@/lib/api'

/**
 * Pure-UI machine that models the blueprint-capture pipeline lifecycle
 * (vision / roomplan / photogrammetry / drone) running through
 * `POST /api/projects/:id/takeoff-drafts/capture`.
 *
 * The original screen (`takeoff-canvas.tsx`) called
 * `useCaptureTakeoffDraft()` directly and tracked `isPending` via the
 * mutation. That worked for a single in-flight request but didn't model:
 *   - upload progress vs server-side vision processing as distinct
 *     phases (operators want to know "uploading" vs "thinking")
 *   - explicit review-required vs auto-promote states post-capture
 *   - retry path after a transient failure
 *
 * This machine leans on `headless-workflow.ts`-style `fromPromise`
 * actors so the upload + processing can be unit-tested without
 * standing up MSW. The actual mutation lives outside; the machine takes
 * a `submit` callback in `input` that returns a Promise of the same
 * `CaptureResponse` shape the existing TanStack mutation returns.
 *
 * State graph:
 *
 *   idle ──UPLOAD──▶ uploading ──UPLOAD_DONE──▶ processing
 *                              ──UPLOAD_PROGRESS──▶ uploading (with pct)
 *                              ──CANCEL──▶ idle
 *   processing ──PROCESSING_DONE──▶ awaiting_review
 *              ──onError──▶ failed
 *              ──CANCEL──▶ idle  (best-effort; server may already be processing)
 *   awaiting_review ──COMMIT──▶ committed
 *                   ──CANCEL──▶ idle  (discards local draft id)
 *   committed (terminal-ish)  ── RESET ──▶ idle
 *   failed ──RETRY──▶ uploading
 *          ──CANCEL──▶ idle
 *
 * The machine emits a `submit` actor invocation when entering
 * `uploading`. That actor resolves to the server snapshot and the
 * machine transitions to `awaiting_review` directly — the
 * upload→processing split is informational (the `UPLOAD_PROGRESS` and
 * `UPLOAD_DONE` events let a multipart implementation announce phases).
 */

export type BlueprintCaptureFile = {
  /** Display name for the UI. */
  name: string
  /** Pipeline this capture targets. */
  kind: CaptureKind
  /** Optional raw payload — kept opaque on the machine; the parent
   * forwards it through to the API in its submit callback. */
  payload: Record<string, unknown>
  /** Optional File reference for genuine multipart uploads. */
  file?: File
}

type Context = {
  file: BlueprintCaptureFile | null
  uploadPct: number
  draftId: string | null
  visionResult: CaptureResponse | null
  reviewRequired: boolean
  error: string | null
}

export type BlueprintCaptureEvent =
  | { type: 'UPLOAD'; file: BlueprintCaptureFile }
  | { type: 'UPLOAD_PROGRESS'; pct: number }
  | { type: 'UPLOAD_DONE' }
  | { type: 'PROCESSING_DONE'; response: CaptureResponse }
  | { type: 'REVIEW' }
  | { type: 'COMMIT' }
  | { type: 'RETRY' }
  | { type: 'CANCEL' }
  | { type: 'RESET' }

type SubmitInput = { file: BlueprintCaptureFile }

export interface BlueprintCaptureConfig {
  /** Submit the capture to the server. Resolves with the same shape the
   * existing `useCaptureTakeoffDraft` returns. */
  submit: (input: BlueprintCaptureFile) => Promise<CaptureResponse>
}

export function createBlueprintCaptureMachine(config: BlueprintCaptureConfig) {
  return setup({
    types: {
      context: {} as Context,
      events: {} as BlueprintCaptureEvent,
    },
    actors: {
      submitCapture: fromPromise<CaptureResponse, SubmitInput>(async ({ input }) => config.submit(input.file)),
    },
    actions: {
      assignFile: assign({
        file: ({ context, event }) => (event.type === 'UPLOAD' ? event.file : context.file),
        uploadPct: () => 0,
        error: () => null,
        visionResult: () => null,
        draftId: () => null,
        reviewRequired: () => false,
      }),
      assignProgress: assign({
        uploadPct: ({ context, event }) => (event.type === 'UPLOAD_PROGRESS' ? clampPct(event.pct) : context.uploadPct),
      }),
      assignUploadDone: assign({
        uploadPct: () => 100,
      }),
      assignResponse: assign({
        visionResult: ({ context, event }) =>
          event.type === 'PROCESSING_DONE' ? event.response : context.visionResult,
        draftId: ({ context, event }) => (event.type === 'PROCESSING_DONE' ? event.response.draft.id : context.draftId),
        reviewRequired: ({ context, event }) =>
          event.type === 'PROCESSING_DONE' ? event.response.result_summary.review_required : context.reviewRequired,
      }),
      assignActorResponse: assign({
        visionResult: ({ context, event }) => {
          // onDone payload for fromPromise actors lives on `event.output`.
          const output = (event as unknown as { output?: CaptureResponse }).output
          return output ?? context.visionResult
        },
        draftId: ({ context, event }) => {
          const output = (event as unknown as { output?: CaptureResponse }).output
          return output?.draft.id ?? context.draftId
        },
        reviewRequired: ({ context, event }) => {
          const output = (event as unknown as { output?: CaptureResponse }).output
          return output?.result_summary.review_required ?? context.reviewRequired
        },
        uploadPct: () => 100,
      }),
      assignError: assign({
        error: ({ context, event }) => {
          const err = (event as unknown as { error?: unknown }).error
          if (err instanceof Error) return err.message
          if (typeof err === 'string') return err
          return context.error ?? 'capture failed'
        },
      }),
      reset: assign({
        file: () => null,
        uploadPct: () => 0,
        draftId: () => null,
        visionResult: () => null,
        reviewRequired: () => false,
        error: () => null,
      }),
    },
  }).createMachine({
    id: 'blueprintCapture',
    initial: 'idle',
    context: {
      file: null,
      uploadPct: 0,
      draftId: null,
      visionResult: null,
      reviewRequired: false,
      error: null,
    },
    states: {
      idle: {
        on: {
          UPLOAD: {
            target: 'uploading',
            actions: 'assignFile',
          },
        },
      },
      uploading: {
        invoke: {
          src: 'submitCapture',
          input: ({ context }) => {
            if (!context.file) throw new Error('uploading entered without file')
            return { file: context.file }
          },
          onDone: {
            target: 'awaiting_review',
            actions: 'assignActorResponse',
          },
          onError: {
            target: 'failed',
            actions: 'assignError',
          },
        },
        on: {
          UPLOAD_PROGRESS: { actions: 'assignProgress' },
          UPLOAD_DONE: {
            target: 'processing',
            actions: 'assignUploadDone',
          },
          CANCEL: {
            target: 'idle',
            actions: 'reset',
          },
        },
      },
      processing: {
        on: {
          PROCESSING_DONE: {
            target: 'awaiting_review',
            actions: 'assignResponse',
          },
          CANCEL: {
            target: 'idle',
            actions: 'reset',
          },
        },
      },
      awaiting_review: {
        on: {
          COMMIT: 'committed',
          REVIEW: 'awaiting_review', // no-op; surface for ergonomics
          CANCEL: {
            target: 'idle',
            actions: 'reset',
          },
        },
      },
      committed: {
        on: {
          RESET: {
            target: 'idle',
            actions: 'reset',
          },
        },
      },
      failed: {
        on: {
          RETRY: {
            target: 'uploading',
          },
          CANCEL: {
            target: 'idle',
            actions: 'reset',
          },
        },
      },
    },
  })
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  return n
}

export type BlueprintCaptureState = 'idle' | 'uploading' | 'processing' | 'awaiting_review' | 'committed' | 'failed'

export interface BlueprintCaptureHookResult {
  state: BlueprintCaptureState
  file: BlueprintCaptureFile | null
  uploadPct: number
  draftId: string | null
  visionResult: CaptureResponse | null
  reviewRequired: boolean
  error: string | null
  isIdle: boolean
  isUploading: boolean
  isProcessing: boolean
  isAwaitingReview: boolean
  isCommitted: boolean
  isFailed: boolean
  upload: (file: BlueprintCaptureFile) => void
  reportProgress: (pct: number) => void
  markUploadDone: () => void
  markProcessingDone: (response: CaptureResponse) => void
  review: () => void
  commit: () => void
  retry: () => void
  cancel: () => void
  reset: () => void
}

/**
 * Convenience hook. The submitter is provided by the caller (typically
 * `useCaptureTakeoffDraft(projectId).mutateAsync`) so the machine never
 * pulls TanStack Query into the bundle when imported by unit tests.
 *
 * Note: this hook intentionally creates a new machine instance per
 * mount. Capture pipelines are session-scoped (one upload at a time per
 * canvas mount), so the lifetime matches the screen.
 */
export function useBlueprintCapture(
  submit: (file: BlueprintCaptureFile) => Promise<CaptureResponse>,
): BlueprintCaptureHookResult {
  const machine = createBlueprintCaptureMachine({ submit })
  const [state, send] = useMachine(machine)

  const upload = useCallback((file: BlueprintCaptureFile) => send({ type: 'UPLOAD', file }), [send])
  const reportProgress = useCallback((pct: number) => send({ type: 'UPLOAD_PROGRESS', pct }), [send])
  const markUploadDone = useCallback(() => send({ type: 'UPLOAD_DONE' }), [send])
  const markProcessingDone = useCallback(
    (response: CaptureResponse) => send({ type: 'PROCESSING_DONE', response }),
    [send],
  )
  const review = useCallback(() => send({ type: 'REVIEW' }), [send])
  const commit = useCallback(() => send({ type: 'COMMIT' }), [send])
  const retry = useCallback(() => send({ type: 'RETRY' }), [send])
  const cancel = useCallback(() => send({ type: 'CANCEL' }), [send])
  const reset = useCallback(() => send({ type: 'RESET' }), [send])

  const currentState = (state.value as BlueprintCaptureState) ?? 'idle'

  return {
    state: currentState,
    file: state.context.file,
    uploadPct: state.context.uploadPct,
    draftId: state.context.draftId,
    visionResult: state.context.visionResult,
    reviewRequired: state.context.reviewRequired,
    error: state.context.error,
    isIdle: currentState === 'idle',
    isUploading: currentState === 'uploading',
    isProcessing: currentState === 'processing',
    isAwaitingReview: currentState === 'awaiting_review',
    isCommitted: currentState === 'committed',
    isFailed: currentState === 'failed',
    upload,
    reportProgress,
    markUploadDone,
    markProcessingDone,
    review,
    commit,
    retry,
    cancel,
    reset,
  }
}

export type { CaptureKind, CaptureResponse, TakeoffDraft }
