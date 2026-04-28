import { useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import { readOfflineQueue, replayOfflineMutations, type OfflineMutation } from '../api.js'
import { toastError, toastInfo } from '../components/ui/toast.js'

/**
 * Offline replay state machine.
 *
 * Replaces the inline useEffect in App.tsx that fired `replayOfflineMutations`
 * + `readOfflineQueue` on mount, on `online`, on the `sitelayer:offline-queue`
 * custom event, and every 15s. The machine owns:
 *   • current `offlineQueue` (mirrored to UI)
 *   • `previousDepth` for "X synced" toast deltas
 *   • the in-flight replay so a second tick can't overlap a running attempt
 *
 * Side effects (the actual fetch + toast calls) live in the `actors` map / the
 * onDone toast call so the state graph itself stays a pure description of
 * the lifecycle.
 *
 * Events:
 *   REPLAY                — start a replay attempt now (timer / online / mount)
 *   REFRESH_QUEUE_ONLY    — refresh the local queue depth without pushing
 *                           (existing `sitelayer:offline-queue` window event)
 *   COMPANY_SLUG_CHANGED  — caller switched company; reset the loop
 */
type Context = {
  companySlug: string
  offlineQueue: OfflineMutation[]
  previousDepth: number
}

type Event = { type: 'REPLAY' } | { type: 'REFRESH_QUEUE_ONLY' } | { type: 'COMPANY_SLUG_CHANGED'; companySlug: string }

type ReplayResult = { queue: OfflineMutation[]; threw: boolean; errorMessage: string | null }

export const offlineReplayMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { companySlug: string },
    events: {} as Event,
  },
  actors: {
    replayAndRead: fromPromise<ReplayResult, { companySlug: string }>(async ({ input }) => {
      let threw = false
      let errorMessage: string | null = null
      try {
        await replayOfflineMutations(input.companySlug)
      } catch (caught) {
        threw = true
        errorMessage = caught instanceof Error ? caught.message : String(caught)
      }
      const queue = await readOfflineQueue()
      return { queue, threw, errorMessage }
    }),
    readQueueOnly: fromPromise<OfflineMutation[]>(async () => readOfflineQueue()),
  },
}).createMachine({
  id: 'offlineReplay',
  initial: 'idle',
  context: ({ input }) => ({
    companySlug: input.companySlug,
    offlineQueue: [],
    previousDepth: 0,
  }),
  on: {
    COMPANY_SLUG_CHANGED: {
      target: '.idle',
      actions: assign({
        companySlug: ({ event }) => event.companySlug,
        offlineQueue: () => [],
        previousDepth: () => 0,
      }),
    },
  },
  states: {
    idle: {
      on: {
        REPLAY: 'replaying',
        REFRESH_QUEUE_ONLY: 'refreshingQueue',
      },
    },
    replaying: {
      invoke: {
        src: 'replayAndRead',
        input: ({ context }) => ({ companySlug: context.companySlug }),
        onDone: {
          target: 'idle',
          actions: [
            ({ context, event }) => {
              const next = event.output.queue
              const prev = context.previousDepth
              if (event.output.threw) {
                toastError('Offline sync failed', event.output.errorMessage ?? 'Will retry automatically')
                return
              }
              if (prev > 0 && next.length < prev) {
                const synced = prev - next.length
                toastInfo(
                  `${synced} offline change${synced === 1 ? '' : 's'} synced`,
                  next.length > 0 ? `${next.length} pending` : undefined,
                )
              }
            },
            assign({
              offlineQueue: ({ event }) => event.output.queue,
              previousDepth: ({ event }) => event.output.queue.length,
            }),
          ],
        },
        onError: {
          target: 'idle',
          actions: ({ event }) => {
            const message = event.error instanceof Error ? event.error.message : 'unknown error'
            toastError('Offline sync failed', message || 'Will retry automatically')
          },
        },
      },
    },
    refreshingQueue: {
      invoke: {
        src: 'readQueueOnly',
        onDone: {
          target: 'idle',
          actions: assign({
            offlineQueue: ({ event }) => event.output,
            previousDepth: ({ event }) => event.output.length,
          }),
        },
        onError: {
          target: 'idle',
        },
      },
    },
  },
})

const REPLAY_INTERVAL_MS = 15_000

/**
 * Hook mirroring the legacy inline useEffect — fires REPLAY on mount, on
 * `window.online`, on the custom `sitelayer:offline-queue` event, and every
 * 15s. Returns the live queue so the SyncStatusBadge / IntegrationsView can
 * render it.
 */
export function useOfflineReplay(companySlug: string): { offlineQueue: OfflineMutation[]; isReplaying: boolean } {
  const [state, send] = useMachine(offlineReplayMachine, { input: { companySlug } })

  useEffect(() => {
    send({ type: 'COMPANY_SLUG_CHANGED', companySlug })
    send({ type: 'REPLAY' })
  }, [companySlug, send])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOnline = () => send({ type: 'REPLAY' })
    const onLocalQueueChange = () => send({ type: 'REFRESH_QUEUE_ONLY' })
    window.addEventListener('online', onOnline)
    window.addEventListener('sitelayer:offline-queue', onLocalQueueChange as EventListener)
    const timer = window.setInterval(() => send({ type: 'REPLAY' }), REPLAY_INTERVAL_MS)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('sitelayer:offline-queue', onLocalQueueChange as EventListener)
      window.clearInterval(timer)
    }
  }, [send])

  return {
    offlineQueue: state.context.offlineQueue,
    isReplaying: state.matches('replaying'),
  }
}
