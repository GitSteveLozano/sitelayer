import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import {
  dispatchEstimatePushEvent,
  getEstimatePushSnapshot,
  type EstimatePushHumanEvent,
  type EstimatePushWorkflowSnapshotResponse,
} from '../api.js'

/**
 * Headless estimate-push state machine.
 *
 * Owns ONLY UI state (idle / loading / submitting / showingError /
 * outOfSync). Never mirrors business state — the push's `state` ('drafted',
 * 'reviewed', 'approved', 'posting', 'posted', 'failed', 'voided'),
 * `state_version`, and `next_events` come from the server snapshot and
 * are stored on context as-is.
 *
 * Mirror of apps/web/src/machines/billing-review.ts. Two of these now
 * exist; if a third lands, lift the shared shape into a generic
 * `headlessWorkflowMachine<TSnapshot, TEvent>()` factory.
 */

type Context = {
  pushId: string
  companySlug: string
  snapshot: EstimatePushWorkflowSnapshotResponse | null
  error: string | null
  outOfSync: boolean
}

type Event = { type: 'LOAD' } | { type: 'DISPATCH'; event: EstimatePushHumanEvent } | { type: 'DISMISS_ERROR' }

type LoadInput = { pushId: string; companySlug: string }
type DispatchInput = {
  pushId: string
  companySlug: string
  event: EstimatePushHumanEvent
  stateVersion: number
}

type DispatchOutput =
  | { kind: 'ok'; snapshot: EstimatePushWorkflowSnapshotResponse }
  | { kind: 'conflict'; snapshot: EstimatePushWorkflowSnapshotResponse | null; message: string }

export const estimatePushMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { pushId: string; companySlug: string },
    events: {} as Event,
  },
  actors: {
    loadSnapshot: fromPromise<EstimatePushWorkflowSnapshotResponse, LoadInput>(async ({ input }) => {
      return getEstimatePushSnapshot(input.pushId, input.companySlug)
    }),
    submitEvent: fromPromise<DispatchOutput, DispatchInput>(async ({ input }) => {
      try {
        const next = await dispatchEstimatePushEvent(input.pushId, input.event, input.stateVersion, input.companySlug)
        return { kind: 'ok', snapshot: next }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'unknown error'
        if (/\b409\b|state_version|not allowed|illegal/i.test(message)) {
          try {
            const fresh = await getEstimatePushSnapshot(input.pushId, input.companySlug)
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
  id: 'estimatePush',
  initial: 'loading',
  context: ({ input }) => ({
    pushId: input.pushId,
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
        input: ({ context }) => ({ pushId: context.pushId, companySlug: context.companySlug }),
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
          if (event.type !== 'DISPATCH') throw new Error('submitting entered without DISPATCH event')
          return {
            pushId: context.pushId,
            companySlug: context.companySlug,
            event: event.event,
            stateVersion: context.snapshot!.state_version,
          }
        },
        onDone: {
          target: 'idle',
          actions: assign(({ event }) => {
            if (event.output.kind === 'ok') {
              return { snapshot: event.output.snapshot, error: null, outOfSync: false }
            }
            return { snapshot: event.output.snapshot, error: event.output.message, outOfSync: true }
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

export type EstimatePushHookSnapshot = {
  snapshot: EstimatePushWorkflowSnapshotResponse | null
  error: string | null
  outOfSync: boolean
  isLoading: boolean
  isSubmitting: boolean
  refresh: () => void
  dispatch: (event: EstimatePushHumanEvent) => void
  dismissError: () => void
}

export function useEstimatePush(pushId: string, companySlug: string): EstimatePushHookSnapshot {
  const [state, send] = useMachine(estimatePushMachine, { input: { pushId, companySlug } })

  useEffect(() => {
    send({ type: 'LOAD' })
  }, [pushId, companySlug, send])

  const refresh = useCallback(() => send({ type: 'LOAD' }), [send])
  const dispatch = useCallback((event: EstimatePushHumanEvent) => send({ type: 'DISPATCH', event }), [send])
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
