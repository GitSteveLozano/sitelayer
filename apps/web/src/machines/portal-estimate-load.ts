import { useCallback, useEffect, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import { fetchPortalEstimate, PortalApiError, type PortalEstimateView } from '@/portal/api'

/**
 * UI machine for one-shot portal estimate snapshot loads
 * (`EstimateAcceptedView`, future portal "receipt" surfaces).
 *
 * Owns ONLY UI state — the loaded view, an error string scoped to the
 * load attempt, and whether a request is in flight. The screen reads
 * `isLoading` / `view` / `error` straight off the hook and renders.
 *
 * State graph:
 *
 *   loading ─onDone▶ idle (view set, error cleared)
 *           ─onError▶ idle (error set, view preserved as null)
 *   idle ─RELOAD▶ loading
 *
 * Note: this machine is intentionally simpler than `headless-workflow`
 * — the accepted view has no DISPATCH path, only a passive read. We
 * surface the `PortalApiError.message_for_user()` translation up at
 * the machine boundary so the screen layer stays a thin renderer.
 */

type Context = {
  shareToken: string
  view: PortalEstimateView | null
  error: string | null
}

type Event = { type: 'RELOAD' }

const machine = setup({
  types: {
    context: {} as Context,
    input: {} as { shareToken: string },
    events: {} as Event,
  },
  actors: {
    load: fromPromise<PortalEstimateView, { shareToken: string }>(async ({ input }) => {
      return fetchPortalEstimate(input.shareToken)
    }),
  },
}).createMachine({
  id: 'portalEstimateLoad',
  initial: 'loading',
  context: ({ input }) => ({
    shareToken: input.shareToken,
    view: null,
    error: null,
  }),
  states: {
    idle: {
      on: {
        RELOAD: 'loading',
      },
    },
    loading: {
      invoke: {
        src: 'load',
        input: ({ context }) => ({ shareToken: context.shareToken }),
        onDone: {
          target: 'idle',
          actions: assign({
            view: ({ event }) => event.output,
            error: () => null,
          }),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => {
              if (event.error instanceof PortalApiError) return event.error.message_for_user()
              if (event.error instanceof Error) return event.error.message
              return 'Could not load this estimate.'
            },
          }),
        },
      },
    },
  },
})

export const portalEstimateLoadMachine = machine

export interface PortalEstimateLoadHookResult {
  view: PortalEstimateView | null
  error: string | null
  isLoading: boolean
  reload: () => void
}

export function usePortalEstimateLoad(shareToken: string): PortalEstimateLoadHookResult {
  // Re-instantiate the actor input when shareToken changes. The hook
  // also fires RELOAD as a belt-and-suspenders trigger on shareToken
  // change.
  const input = useMemo(() => ({ shareToken }), [shareToken])
  const [state, send] = useMachine(portalEstimateLoadMachine, { input })

  useEffect(() => {
    send({ type: 'RELOAD' })
  }, [shareToken, send])

  const reload = useCallback(() => send({ type: 'RELOAD' }), [send])

  return {
    view: state.context.view,
    error: state.context.error,
    isLoading: state.matches('loading'),
    reload,
  }
}
