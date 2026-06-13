import { useCallback, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import { apiPost } from '@/lib/api'
import { enqueueOfflineMutation } from '@/lib/offline/queue'
import { API_URL, NetworkError, buildAuthHeaders, nextRequestId } from '../lib/api/client'

/**
 * UI state machine for the worker_issues create-with-attachments flow.
 *
 * The submission has three sequential steps (POST issue → POST voice
 * attachment → POST photo attachment) and a real partial-failure mode
 * we have to surface: if the issue itself creates successfully but one
 * or both attachments 4xx, re-submitting the form would duplicate the
 * worker_issues row. The machine tracks which sub-steps remain and lets
 * the screen retry ONLY the failed attachments.
 *
 *   idle ─SUBMIT▶ creating
 *     └─◀ creationFailed (issueId null)  ─SUBMIT▶ creating
 *
 *   creating ─onDone─▶ processing.next
 *                      └─ queue empty ─▶ doneAll | donePartial
 *                      └─ queue has work ─▶ processing.uploading
 *
 *   processing.uploading ─onDone─▶ processing.next
 *                        └─onError ─▶ record failure, processing.next
 *
 *   donePartial ─RETRY_ATTACHMENTS─▶ re-queue failed parts ─▶ processing.next
 *
 * The machine intentionally does NOT mirror the worker_issues workflow
 * state (open/resolved/etc.) — that's `field-event.ts`'s job. This is
 * purely the submission/upload UI state per CLAUDE.md operating rules.
 */

export type AttachmentKind = 'voice' | 'photo'

export interface PendingAttachment {
  kind: AttachmentKind
  /** Already-named binary payload. */
  payload: Blob | File
  fileName: string
  clientUploadId?: string
}

export interface WorkerIssueCreateBody {
  kind: 'materials_out' | 'crew_short' | 'safety' | 'other'
  message: string
  /** Typed urgency band the auto-escalator keys on (severity='stopped' open
   *  >15min escalates). Carried as a field, NOT smuggled into `message`. */
  severity: 'question' | 'slowing' | 'stopped'
  project_id?: string
  /** Structured material-request fulfillment fields (migration 126). Only
   *  meaningful when `kind === 'materials_out'`; the server ignores them on
   *  other kinds. The foreman blocker detail renders its quantity hero off
   *  these typed values instead of re-parsing `message`. */
  material_label?: string
  material_quantity?: number
  material_unit?: string
  client_request_id?: string
}

export interface WorkerIssueSubmitPayload {
  companySlug: string
  body: WorkerIssueCreateBody
  attachments: PendingAttachment[]
}

interface MachineContext {
  companySlug: string | null
  body: WorkerIssueCreateBody | null
  issueId: string | null
  /** Attachments still to attempt this pass. Shifted as each starts. */
  pending: PendingAttachment[]
  /** Attachments that failed in the current submission round. The
   *  failure label is "voice" / "photo" plus the server message so the
   *  UI can render a concrete banner. */
  failed: Array<{ kind: AttachmentKind; message: string; payload: PendingAttachment }>
  /** Last error string for the issue-create call (separate from
   *  attachment failures, which we keep going through). */
  error: string | null
  clientRequestId: string | null
}

type MachineEvent =
  | { type: 'SUBMIT'; payload: WorkerIssueSubmitPayload }
  | { type: 'RETRY_ATTACHMENTS' }
  | { type: 'DISMISS_ERROR' }

type CreateInput = {
  companySlug: string
  body: WorkerIssueCreateBody
  attachments: PendingAttachment[]
  clientRequestId: string
}
type CreateOutput = { issueId: string } | { queued: true }

type UploadInput = { companySlug: string; issueId: string; attachment: PendingAttachment }

function nextWorkerIssueClientId(): string {
  return nextRequestId().replace(/^web-/, 'worker-issue-')
}

function attachmentClientUploadId(clientRequestId: string, attachment: PendingAttachment, index: number): string {
  return `${clientRequestId}:${index}:${attachment.kind}:${attachment.fileName}`
}

function prepareAttachments(clientRequestId: string, attachments: PendingAttachment[]): PendingAttachment[] {
  return attachments.map((attachment, index) => ({
    ...attachment,
    clientUploadId: attachment.clientUploadId ?? attachmentClientUploadId(clientRequestId, attachment, index),
  }))
}

async function createWorkerIssue(input: CreateInput): Promise<CreateOutput> {
  const body = { ...input.body, client_request_id: input.clientRequestId }
  try {
    const response = await apiPost<{ worker_issue: { id: string } }>('/api/worker-issues', body, input.companySlug)
    const id = response?.worker_issue?.id
    if (!id) {
      throw new Error('worker issue create response missing id')
    }
    return { issueId: id }
  } catch (err) {
    if (err instanceof NetworkError) {
      await enqueueOfflineMutation('worker_issue_submit', {
        companySlug: input.companySlug,
        body,
        attachments: input.attachments,
      })
      return { queued: true }
    }
    throw err
  }
}

async function uploadAttachment(input: UploadInput): Promise<void> {
  const clientUploadId =
    input.attachment.clientUploadId ?? attachmentClientUploadId(`worker-issue-${input.issueId}`, input.attachment, 0)
  const form = new FormData()
  form.append('kind', input.attachment.kind)
  form.append('client_upload_id', clientUploadId)
  // Busboy delivers fields in wire order; `kind` must arrive before the
  // file part so the file handler can read it. Same convention as the
  // original handler in worker-issue.tsx.
  form.append('file', input.attachment.payload, input.attachment.fileName)
  const headers = await buildAuthHeaders({ companySlug: input.companySlug })
  headers.set('Idempotency-Key', clientUploadId)
  const path = `/api/worker-issues/${encodeURIComponent(input.issueId)}/attachments`
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: form })
  } catch (err) {
    await enqueueOfflineMutation('worker_issue_attachment_upload', {
      companySlug: input.companySlug,
      issueId: input.issueId,
      kind: input.attachment.kind,
      file: input.attachment.payload,
      fileName: input.attachment.fileName,
      client_upload_id: clientUploadId,
    })
    return
  }
  if (!response.ok) {
    const ct = response.headers.get('content-type') ?? ''
    let detail = ''
    try {
      if (ct.includes('application/json')) {
        const parsed = (await response.json()) as { error?: string }
        detail = parsed?.error ?? ''
      } else {
        detail = await response.text()
      }
    } catch {
      // body read failed — fall back to the status-line message below.
    }
    throw new Error(detail || `attachment upload failed (${response.status})`)
  }
}

export const workerIssueSubmitMachine = setup({
  types: {
    context: {} as MachineContext,
    events: {} as MachineEvent,
  },
  actors: {
    createIssue: fromPromise<CreateOutput, CreateInput>(({ input }) => createWorkerIssue(input)),
    uploadAttachment: fromPromise<void, UploadInput>(({ input }) => uploadAttachment(input)),
  },
}).createMachine({
  id: 'workerIssueSubmit',
  initial: 'idle',
  context: {
    companySlug: null,
    body: null,
    issueId: null,
    pending: [],
    failed: [],
    error: null,
    clientRequestId: null,
  },
  states: {
    idle: {
      on: {
        SUBMIT: {
          target: 'creating',
          actions: assign(({ event }) => {
            const clientRequestId = event.payload.body.client_request_id ?? nextWorkerIssueClientId()
            return {
              companySlug: event.payload.companySlug,
              body: { ...event.payload.body, client_request_id: clientRequestId },
              issueId: null,
              pending: prepareAttachments(clientRequestId, event.payload.attachments),
              failed: [],
              error: null,
              clientRequestId,
            }
          }),
        },
        DISMISS_ERROR: { actions: assign({ error: () => null }) },
      },
    },
    creating: {
      invoke: {
        src: 'createIssue',
        input: ({ context }) => {
          if (!context.companySlug || !context.body) {
            throw new Error('creating entered without companySlug/body — SUBMIT not assigned')
          }
          if (!context.clientRequestId) {
            throw new Error('creating entered without clientRequestId — SUBMIT not assigned')
          }
          return {
            companySlug: context.companySlug,
            body: context.body,
            attachments: context.pending,
            clientRequestId: context.clientRequestId,
          }
        },
        onDone: [
          {
            guard: ({ event }) => 'queued' in event.output,
            target: 'doneAll',
            actions: assign({ issueId: () => null, pending: () => [], error: () => null }),
          },
          {
            target: 'processing',
            actions: assign({
              issueId: ({ event }) => ('issueId' in event.output ? event.output.issueId : null),
              error: () => null,
            }),
          },
        ],
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'could not send issue'),
          }),
        },
      },
    },
    processing: {
      always: [
        { guard: ({ context }) => context.pending.length === 0 && context.failed.length === 0, target: 'doneAll' },
        { guard: ({ context }) => context.pending.length === 0, target: 'donePartial' },
        { target: 'uploading' },
      ],
    },
    uploading: {
      invoke: {
        src: 'uploadAttachment',
        input: ({ context }) => {
          const next = context.pending[0]
          if (!context.companySlug || !context.issueId || !next) {
            throw new Error('uploading entered without an attachment to send')
          }
          return { companySlug: context.companySlug, issueId: context.issueId, attachment: next }
        },
        onDone: {
          target: 'processing',
          actions: assign({ pending: ({ context }) => context.pending.slice(1) }),
        },
        onError: {
          target: 'processing',
          actions: assign({
            pending: ({ context }) => context.pending.slice(1),
            failed: ({ context, event }) => {
              const next = context.pending[0]
              if (!next) return context.failed
              const message = event.error instanceof Error ? event.error.message : 'upload failed'
              return [...context.failed, { kind: next.kind, message, payload: next }]
            },
          }),
        },
      },
    },
    doneAll: {
      on: {
        SUBMIT: {
          target: 'creating',
          actions: assign(({ event }) => {
            const clientRequestId = event.payload.body.client_request_id ?? nextWorkerIssueClientId()
            return {
              companySlug: event.payload.companySlug,
              body: { ...event.payload.body, client_request_id: clientRequestId },
              issueId: null,
              pending: prepareAttachments(clientRequestId, event.payload.attachments),
              failed: [],
              error: null,
              clientRequestId,
            }
          }),
        },
      },
    },
    donePartial: {
      on: {
        RETRY_ATTACHMENTS: {
          target: 'processing',
          actions: assign({
            pending: ({ context }) => context.failed.map((f) => f.payload),
            failed: () => [],
          }),
        },
        DISMISS_ERROR: { actions: assign({ failed: () => [] }) },
        SUBMIT: {
          // Reset and start a fresh submission (e.g. user dismissed and
          // opened the form again).
          target: 'creating',
          actions: assign(({ event }) => {
            const clientRequestId = event.payload.body.client_request_id ?? nextWorkerIssueClientId()
            return {
              companySlug: event.payload.companySlug,
              body: { ...event.payload.body, client_request_id: clientRequestId },
              issueId: null,
              pending: prepareAttachments(clientRequestId, event.payload.attachments),
              failed: [],
              error: null,
              clientRequestId,
            }
          }),
        },
      },
    },
  },
})

export interface WorkerIssueSubmitHookValue {
  /** Issue + attachments fully succeeded — the screen should navigate. */
  isDone: boolean
  /** Issue saved but one or more attachments failed; can retry. */
  isPartial: boolean
  /** Active network step; disables the submit button. */
  isBusy: boolean
  /** Coarse stage label for the button copy. */
  stage: 'idle' | 'creating' | 'uploading-voice' | 'uploading-photo' | 'done'
  /** Issue-create error (no row landed). */
  error: string | null
  /** Per-attachment failures (issue itself landed). */
  failed: ReadonlyArray<{ kind: AttachmentKind; message: string }>
  /** Set after the issue row exists — useful for deep linking. */
  issueId: string | null
  submit: (payload: WorkerIssueSubmitPayload) => void
  retryAttachments: () => void
  dismissError: () => void
}

export function useWorkerIssueSubmit(): WorkerIssueSubmitHookValue {
  const [state, send] = useMachine(workerIssueSubmitMachine)

  const stage = useMemo<WorkerIssueSubmitHookValue['stage']>(() => {
    if (state.matches('creating')) return 'creating'
    if (state.matches('uploading')) {
      const next = state.context.pending[0]
      return next?.kind === 'voice' ? 'uploading-voice' : 'uploading-photo'
    }
    if (state.matches('doneAll')) return 'done'
    return 'idle'
  }, [state])

  const submit = useCallback((payload: WorkerIssueSubmitPayload) => send({ type: 'SUBMIT', payload }), [send])
  const retryAttachments = useCallback(() => send({ type: 'RETRY_ATTACHMENTS' }), [send])
  const dismissError = useCallback(() => send({ type: 'DISMISS_ERROR' }), [send])

  return {
    isDone: state.matches('doneAll'),
    isPartial: state.matches('donePartial'),
    isBusy: state.matches('creating') || state.matches('uploading') || state.matches('processing'),
    stage,
    error: state.context.error,
    failed: state.context.failed.map(({ kind, message }) => ({ kind, message })),
    issueId: state.context.issueId,
    submit,
    retryAttachments,
    dismissError,
  }
}
