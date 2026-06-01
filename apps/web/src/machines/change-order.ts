import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import type { ChangeOrderHumanEventType } from '@sitelayer/workflows'

import { fetchChangeOrderSnapshot, type ChangeOrderSnapshot } from '../lib/api/change-orders'
import { request } from '../lib/api/client'

/**
 * Headless change-order state machine.
 *
 * Mirrors apps/web/src/machines/time-review.ts (the closest exemplar — it
 * also carries a `reason` on its REJECT-style event). This machine owns
 * ONLY UI state (loading / idle / submitting). It NEVER mirrors business
 * state — the change order's `state` ('draft', 'sent', 'accepted',
 * 'rejected', 'voided'), `state_version`, and `next_events` come from the
 * server snapshot and are stored on context as-is.
 *
 * See docs/DETERMINISTIC_WORKFLOWS.md → Headless UI Process Model.
 *
 * Unlike time-review, a change order is project-scoped at the API by
 * company (not company-slug-parameterized), so the machine input is just
 * `{ coId }`. A CO has no offline/optimistic requirement, so — like
 * time-review — there is no offline-queue state.
 *
 * Events:
 *   LOAD            — fetch the CO snapshot (initial load + manual refresh)
 *   DISPATCH        — submit a workflow event to the API (with optional reason)
 *   DISMISS_ERROR   — clear a transient error banner / outOfSync flag
 */

export type ChangeOrderDispatchPayload = {
  event: ChangeOrderHumanEventType
  /** Optional rejection reason; meaningful only for REJECT. */
  reason?: string
}

type Context = {
  coId: string
  snapshot: ChangeOrderSnapshot | null
  error: string | null
  /** True when the last DISPATCH returned 409 — UI should call out the
   * stale-state condition explicitly so the user knows their click was
   * ignored against a newer server state. */
  outOfSync: boolean
}

type Event = { type: 'LOAD' } | { type: 'DISPATCH'; payload: ChangeOrderDispatchPayload } | { type: 'DISMISS_ERROR' }

type LoadInput = { coId: string }
type DispatchInput = {
  coId: string
  payload: ChangeOrderDispatchPayload
  stateVersion: number
}

type DispatchOutput =
  | { kind: 'ok'; snapshot: ChangeOrderSnapshot }
  | { kind: 'conflict'; snapshot: ChangeOrderSnapshot | null; message: string }

async function dispatchChangeOrderEventRequest(
  coId: string,
  payload: ChangeOrderDispatchPayload,
  stateVersion: number,
): Promise<ChangeOrderSnapshot> {
  return request<ChangeOrderSnapshot>(`/api/change-orders/${encodeURIComponent(coId)}/events`, {
    method: 'POST',
    json: { event: payload.event, state_version: stateVersion, ...(payload.reason ? { reason: payload.reason } : {}) },
  })
}

export const changeOrderMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { coId: string },
    events: {} as Event,
  },
  actors: {
    loadSnapshot: fromPromise<ChangeOrderSnapshot | null, LoadInput>(async ({ input }) => {
      // No CO selected yet — return null rather than fetching an empty id.
      if (!input.coId) return null
      return fetchChangeOrderSnapshot(input.coId)
    }),
    submitEvent: fromPromise<DispatchOutput, DispatchInput>(async ({ input }) => {
      try {
        const next = await dispatchChangeOrderEventRequest(input.coId, input.payload, input.stateVersion)
        return { kind: 'ok', snapshot: next }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'unknown error'
        // 409 from the API surfaces as Error('… 409 …'). Detect it so the
        // machine can fetch the fresh snapshot rather than showing an opaque
        // banner.
        if (/\b409\b|state_version|not allowed|illegal/i.test(message)) {
          try {
            const fresh = await fetchChangeOrderSnapshot(input.coId)
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
  id: 'changeOrder',
  initial: 'loading',
  context: ({ input }) => ({
    coId: input.coId,
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
        input: ({ context }) => ({ coId: context.coId }),
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
            coId: context.coId,
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

export type ChangeOrderMachineSnapshot = {
  snapshot: ChangeOrderSnapshot | null
  error: string | null
  outOfSync: boolean
  isLoading: boolean
  isSubmitting: boolean
  refresh: () => void
  dispatch: (payload: ChangeOrderDispatchPayload) => void
  dismissError: () => void
}

export function useChangeOrder(coId: string): ChangeOrderMachineSnapshot {
  const [state, send] = useMachine(changeOrderMachine, { input: { coId } })

  // Re-load when the caller switches to a different CO id. A falsy id means
  // there is no CO selected yet (e.g. the desktop drawer before its list
  // resolves), so we skip the fetch rather than hitting `/api/change-orders//`.
  useEffect(() => {
    if (coId) send({ type: 'LOAD' })
  }, [coId, send])

  const refresh = useCallback(() => send({ type: 'LOAD' }), [send])
  const dispatch = useCallback((payload: ChangeOrderDispatchPayload) => send({ type: 'DISPATCH', payload }), [send])
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
