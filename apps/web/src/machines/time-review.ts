import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import { fetchTimeReviewRun, type TimeReviewHumanEvent, type TimeReviewSnapshot } from '../lib/api/time-review'
import { request } from '../lib/api/client'

/**
 * Headless time-review state machine.
 *
 * Mirrors apps/web/src/machines/billing-review.ts (and labor-payroll.ts)
 * exactly. This machine owns ONLY UI state (idle / loading / submitting /
 * showingError / outOfSync). It NEVER mirrors business state — the
 * time-review run's `state` ('pending', 'approved', 'rejected'),
 * `state_version`, and `next_events` come from the server snapshot and
 * are stored on context as-is.
 *
 * See docs/DETERMINISTIC_WORKFLOWS.md → Headless UI Process Model.
 *
 * One thing that's intentionally different from the rental-billing /
 * labor-payroll pattern: time-review's REJECT and REOPEN events carry a
 * `reason` string. The DISPATCH event therefore takes the full payload
 * shape ({ event, reason? }) rather than just the event type.
 *
 * Events:
 *   LOAD            — fetch the run snapshot (initial load + manual refresh)
 *   DISPATCH        — submit a workflow event to the API (with optional reason)
 *   DISMISS_ERROR   — clear a transient error banner
 */

export type TimeReviewDispatchPayload = {
  event: TimeReviewHumanEvent
  /** Required for REJECT and REOPEN; ignored for APPROVE. */
  reason?: string
}

type Context = {
  runId: string
  companySlug: string
  snapshot: TimeReviewSnapshot | null
  error: string | null
  /** True when the last DISPATCH returned 409 — UI should call out the
   * stale-state condition explicitly so the user knows their click was
   * ignored against a newer server state. */
  outOfSync: boolean
}

type Event = { type: 'LOAD' } | { type: 'DISPATCH'; payload: TimeReviewDispatchPayload } | { type: 'DISMISS_ERROR' }

type LoadInput = { runId: string; companySlug: string }
type DispatchInput = {
  runId: string
  companySlug: string
  payload: TimeReviewDispatchPayload
  stateVersion: number
}

type DispatchOutput =
  | { kind: 'ok'; snapshot: TimeReviewSnapshot }
  | { kind: 'conflict'; snapshot: TimeReviewSnapshot | null; message: string }

async function dispatchTimeReviewEventRequest(
  runId: string,
  payload: TimeReviewDispatchPayload,
  stateVersion: number,
): Promise<TimeReviewSnapshot> {
  return request<TimeReviewSnapshot>(`/api/time-review-runs/${encodeURIComponent(runId)}/events`, {
    method: 'POST',
    json: { event: payload.event, state_version: stateVersion, ...(payload.reason ? { reason: payload.reason } : {}) },
  })
}

export const timeReviewMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { runId: string; companySlug: string },
    events: {} as Event,
  },
  actors: {
    loadSnapshot: fromPromise<TimeReviewSnapshot, LoadInput>(async ({ input }) => {
      return fetchTimeReviewRun(input.runId)
    }),
    submitEvent: fromPromise<DispatchOutput, DispatchInput>(async ({ input }) => {
      try {
        const next = await dispatchTimeReviewEventRequest(input.runId, input.payload, input.stateVersion)
        return { kind: 'ok', snapshot: next }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'unknown error'
        // 409 from the API surfaces as Error('… 409 …'). Detect it so the
        // machine can fetch the fresh snapshot rather than showing an opaque
        // banner.
        if (/\b409\b|state_version|not allowed|illegal/i.test(message)) {
          try {
            const fresh = await fetchTimeReviewRun(input.runId)
            return { kind: 'conflict', snapshot: fresh, message }
          } catch {
            return { kind: 'conflict', snapshot: null, message }
          }
        }
        throw caught
      }
    }),
  },
}).createMachine({
  id: 'timeReview',
  initial: 'loading',
  context: ({ input }) => ({
    runId: input.runId,
    companySlug: input.companySlug,
    snapshot: null,
    error: null,
    outOfSync: false,
  }),
  states: {
    idle: {
      on: {
        LOAD: 'loading',
        DISPATCH: {
          target: 'submitting',
          guard: ({ context }) => context.snapshot !== null,
        },
        DISMISS_ERROR: {
          actions: assign({ error: () => null, outOfSync: () => false }),
        },
      },
    },
    loading: {
      invoke: {
        src: 'loadSnapshot',
        input: ({ context }) => ({ runId: context.runId, companySlug: context.companySlug }),
        onDone: {
          target: 'idle',
          actions: assign({
            snapshot: ({ event }) => event.output,
            error: () => null,
            outOfSync: () => false,
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to load'),
          }),
        },
      },
    },
    submitting: {
      invoke: {
        src: 'submitEvent',
        input: ({ context, event }) => {
          // Narrow: the guard in idle ensures `snapshot` is non-null at this
          // point. The DISPATCH event carries the workflow event payload.
          if (event.type !== 'DISPATCH') throw new Error('submitting entered without DISPATCH event')
          return {
            runId: context.runId,
            companySlug: context.companySlug,
            payload: event.payload,
            stateVersion: context.snapshot!.state_version,
          }
        },
        onDone: {
          target: 'idle',
          actions: assign(({ event }) => {
            if (event.output.kind === 'ok') {
              return {
                snapshot: event.output.snapshot,
                error: null,
                outOfSync: false,
              }
            }
            return {
              snapshot: event.output.snapshot,
              error: event.output.message,
              outOfSync: true,
            }
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to submit'),
          }),
        },
      },
    },
  },
})

export type TimeReviewMachineSnapshot = {
  snapshot: TimeReviewSnapshot | null
  error: string | null
  outOfSync: boolean
  isLoading: boolean
  isSubmitting: boolean
  refresh: () => void
  dispatch: (payload: TimeReviewDispatchPayload) => void
  dismissError: () => void
}

export function useTimeReview(runId: string, companySlug: string): TimeReviewMachineSnapshot {
  const [state, send] = useMachine(timeReviewMachine, { input: { runId, companySlug } })

  // Re-load when the caller switches to a different run id.
  useEffect(() => {
    send({ type: 'LOAD' })
  }, [runId, companySlug, send])

  const refresh = useCallback(() => send({ type: 'LOAD' }), [send])
  const dispatch = useCallback((payload: TimeReviewDispatchPayload) => send({ type: 'DISPATCH', payload }), [send])
  const dismissError = useCallback(() => send({ type: 'DISMISS_ERROR' }), [send])

  return {
    snapshot: state.context.snapshot,
    error: state.context.error,
    outOfSync: state.context.outOfSync,
    isLoading: state.matches('loading'),
    isSubmitting: state.matches('submitting'),
    refresh,
    dispatch,
    dismissError,
  }
}
