import { useCallback } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import {
  createLaborPayrollRun,
  previewLaborPayrollCoverage,
  type LaborPayrollPreviewResponse,
  type LaborPayrollSnapshot,
} from '../lib/api/labor-payroll-runs'
import { ApiError } from '../lib/api/client'

/**
 * Labor-payroll create + coverage-preview entry machine.
 *
 * This is a SHORT-LIVED UI orchestration machine for the multi-step
 * "pick a period → preview coverage → create run" flow. It is NOT the
 * post-creation review machine (`laborPayroll`, keyed to a single
 * existing run id); the entry flow has no run id until the final step.
 *
 * It owns ONLY UI orchestration:
 *   - the deterministic editing → previewing → previewed → creating →
 *     created order, so the UI cannot create a run without first seeing
 *     coverage;
 *   - the preview-loading / create-submitting flags;
 *   - the 400 ("no eligible labor entries") and 409 ("run already exists
 *     for this period", carrying `existing_run_id`) error surfaces from
 *     the create route.
 *
 * It NEVER mirrors business state. Once `created`, the new run's
 * lifecycle is owned by the `laborPayroll` machine on the detail screen.
 *
 * See docs/DETERMINISTIC_WORKFLOWS.md → Headless UI Process Model.
 */

type Period = { periodStart: string; periodEnd: string }

type Context = {
  companySlug: string
  periodStart: string
  periodEnd: string
  timeReviewRunId: string | null
  preview: LaborPayrollPreviewResponse | null
  createdRunId: string | null
  /** When a 409 says a run already exists, this carries that run's id so
   * the UI can offer "go to existing run". */
  existingRunId: string | null
  error: string | null
}

export type LaborPayrollEntryEvent =
  | { type: 'SET_PERIOD'; period_start: string; period_end: string; time_review_run_id?: string | null }
  | { type: 'PREVIEW' }
  | { type: 'CREATE' }
  | { type: 'RESET' }
  | { type: 'DISMISS_ERROR' }

type PreviewInput = Period
type CreateInput = Period & { timeReviewRunId: string | null }

type CreateOutput =
  | { kind: 'ok'; snapshot: LaborPayrollSnapshot }
  | { kind: 'conflict'; message: string; existingRunId: string | null }
  | { kind: 'no_entries'; message: string }

function extractExistingRunId(body: unknown): string | null {
  if (body && typeof body === 'object' && 'existing_run_id' in body) {
    const value = (body as { existing_run_id?: unknown }).existing_run_id
    if (typeof value === 'string' && value) return value
  }
  return null
}

export const laborPayrollEntryMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { companySlug: string },
    events: {} as LaborPayrollEntryEvent,
  },
  actors: {
    previewCoverage: fromPromise<LaborPayrollPreviewResponse, PreviewInput>(async ({ input }) => {
      return previewLaborPayrollCoverage(input.periodStart, input.periodEnd)
    }),
    createRun: fromPromise<CreateOutput, CreateInput>(async ({ input }) => {
      try {
        const snapshot = await createLaborPayrollRun({
          period_start: input.periodStart,
          period_end: input.periodEnd,
          time_review_run_id: input.timeReviewRunId,
        })
        return { kind: 'ok', snapshot }
      } catch (caught) {
        if (caught instanceof ApiError) {
          if (caught.status === 409) {
            return {
              kind: 'conflict',
              message: caught.message_for_user(),
              existingRunId: extractExistingRunId(caught.body),
            }
          }
          if (caught.status === 400) {
            return { kind: 'no_entries', message: caught.message_for_user() }
          }
        }
        throw caught
      }
    }),
  },
  actions: {
    resetEntry: assign({
      periodStart: () => '',
      periodEnd: () => '',
      timeReviewRunId: () => null,
      preview: () => null,
      createdRunId: () => null,
      existingRunId: () => null,
      error: () => null,
    }),
  },
}).createMachine({
  id: 'laborPayrollEntry',
  initial: 'editing',
  context: ({ input }) => ({
    companySlug: input.companySlug,
    periodStart: '',
    periodEnd: '',
    timeReviewRunId: null,
    preview: null,
    createdRunId: null,
    existingRunId: null,
    error: null,
  }),
  states: {
    editing: {
      on: {
        SET_PERIOD: {
          actions: assign({
            periodStart: ({ event }) => event.period_start,
            periodEnd: ({ event }) => event.period_end,
            timeReviewRunId: ({ context, event }) =>
              event.time_review_run_id !== undefined ? event.time_review_run_id : context.timeReviewRunId,
            // A period change invalidates any previous preview.
            preview: () => null,
            error: () => null,
            existingRunId: () => null,
          }),
        },
        PREVIEW: {
          target: 'previewing',
          guard: ({ context }) => context.periodStart !== '' && context.periodEnd !== '',
        },
        RESET: { actions: 'resetEntry' },
        DISMISS_ERROR: { actions: assign({ error: () => null, existingRunId: () => null }) },
      },
    },
    previewing: {
      invoke: {
        src: 'previewCoverage',
        input: ({ context }) => ({ periodStart: context.periodStart, periodEnd: context.periodEnd }),
        onDone: {
          target: 'previewed',
          actions: assign({ preview: ({ event }) => event.output, error: () => null }),
        },
        onError: {
          target: 'editing',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to preview coverage'),
          }),
        },
      },
    },
    previewed: {
      on: {
        // Re-editing the period drops back to editing and clears the stale
        // preview so CREATE always acts on coverage the user has seen.
        SET_PERIOD: {
          target: 'editing',
          actions: assign({
            periodStart: ({ event }) => event.period_start,
            periodEnd: ({ event }) => event.period_end,
            timeReviewRunId: ({ context, event }) =>
              event.time_review_run_id !== undefined ? event.time_review_run_id : context.timeReviewRunId,
            preview: () => null,
            error: () => null,
            existingRunId: () => null,
          }),
        },
        PREVIEW: 'previewing',
        CREATE: 'creating',
        RESET: { target: 'editing', actions: 'resetEntry' },
        DISMISS_ERROR: { actions: assign({ error: () => null, existingRunId: () => null }) },
      },
    },
    creating: {
      invoke: {
        src: 'createRun',
        input: ({ context }) => ({
          periodStart: context.periodStart,
          periodEnd: context.periodEnd,
          timeReviewRunId: context.timeReviewRunId,
        }),
        onDone: [
          {
            target: 'created',
            guard: ({ event }) => event.output.kind === 'ok',
            actions: assign({
              createdRunId: ({ event }) =>
                event.output.kind === 'ok' ? event.output.snapshot.context.id : null,
              error: () => null,
            }),
          },
          {
            // 409 — a run already exists for this period. Surface the
            // existing id so the UI can link to it; stay out of `created`.
            target: 'previewed',
            guard: ({ event }) => event.output.kind === 'conflict',
            actions: assign({
              error: ({ event }) => (event.output.kind === 'conflict' ? event.output.message : null),
              existingRunId: ({ event }) => (event.output.kind === 'conflict' ? event.output.existingRunId : null),
            }),
          },
          {
            // 400 — no eligible entries. Return to editing with the message.
            target: 'editing',
            actions: assign({
              error: ({ event }) => (event.output.kind === 'no_entries' ? event.output.message : null),
              preview: () => null,
            }),
          },
        ],
        onError: {
          target: 'previewed',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to create run'),
          }),
        },
      },
    },
    created: {
      type: 'final',
    },
  },
})

export type LaborPayrollEntryState = 'editing' | 'previewing' | 'previewed' | 'creating' | 'created'

export interface LaborPayrollEntryHookResult {
  state: LaborPayrollEntryState
  preview: LaborPayrollPreviewResponse | null
  error: string | null
  existingRunId: string | null
  createdRunId: string | null
  isPreviewing: boolean
  isCreating: boolean
  canCreate: boolean
  setPeriod: (periodStart: string, periodEnd: string, timeReviewRunId?: string | null) => void
  runPreview: () => void
  create: () => void
  reset: () => void
  dismissError: () => void
}

export function useLaborPayrollEntry(companySlug: string): LaborPayrollEntryHookResult {
  const [state, send] = useMachine(laborPayrollEntryMachine, { input: { companySlug } })
  const stateValue = state.value as LaborPayrollEntryState

  const setPeriod = useCallback(
    (periodStart: string, periodEnd: string, timeReviewRunId?: string | null) =>
      send({
        type: 'SET_PERIOD',
        period_start: periodStart,
        period_end: periodEnd,
        ...(timeReviewRunId !== undefined ? { time_review_run_id: timeReviewRunId } : {}),
      }),
    [send],
  )
  const runPreview = useCallback(() => send({ type: 'PREVIEW' }), [send])
  const create = useCallback(() => send({ type: 'CREATE' }), [send])
  const reset = useCallback(() => send({ type: 'RESET' }), [send])
  const dismissError = useCallback(() => send({ type: 'DISMISS_ERROR' }), [send])

  return {
    state: stateValue,
    preview: state.context.preview,
    error: state.context.error,
    existingRunId: state.context.existingRunId,
    createdRunId: state.context.createdRunId,
    isPreviewing: stateValue === 'previewing',
    isCreating: stateValue === 'creating',
    canCreate: stateValue === 'previewed',
    setPeriod,
    runPreview,
    create,
    reset,
    dismissError,
  }
}
