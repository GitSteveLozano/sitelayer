import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import {
  dispatchCrewScheduleEvent,
  fetchCrewScheduleSnapshot,
  type CrewScheduleHumanEvent,
  type CrewScheduleSnapshot,
} from '@/lib/api'

/**
 * Headless crew-schedule state machine.
 *
 * Mirrors `billingReviewMachine` (apps/web/src/machines/billing-review.ts).
 * Owns ONLY UI state (idle / loading / submitting / showingError /
 * outOfSync). Never mirrors business state — `state`, `state_version`,
 * and `next_events` come from the server snapshot and are stored on
 * context as-is.
 *
 * See docs/DETERMINISTIC_WORKFLOWS.md → Headless UI Process Model.
 *
 * Events:
 *   LOAD            — fetch the schedule snapshot (initial load + manual refresh)
 *   DISPATCH        — submit a workflow event (CONFIRM) to the API
 *   DISMISS_ERROR   — clear a transient error banner
 */

type Context = {
  scheduleId: string
  companySlug: string
  snapshot: CrewScheduleSnapshot | null
  error: string | null
  /** True when the last DISPATCH returned 409 — UI should call out the
   * stale-state condition explicitly so the user knows their click was
   * ignored against a newer server state. */
  outOfSync: boolean
}

type Event = { type: 'LOAD' } | { type: 'DISPATCH'; event: CrewScheduleHumanEvent } | { type: 'DISMISS_ERROR' }

type LoadInput = { scheduleId: string; companySlug: string }
type DispatchInput = {
  scheduleId: string
  companySlug: string
  event: CrewScheduleHumanEvent
  stateVersion: number
}

type DispatchOutput =
  | { kind: 'ok'; snapshot: CrewScheduleSnapshot }
  | { kind: 'conflict'; snapshot: CrewScheduleSnapshot | null; message: string }

export const crewScheduleMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { scheduleId: string; companySlug: string },
    events: {} as Event,
  },
  actors: {
    loadSnapshot: fromPromise<CrewScheduleSnapshot, LoadInput>(async ({ input }) => {
      return fetchCrewScheduleSnapshot(input.scheduleId)
    }),
    submitEvent: fromPromise<DispatchOutput, DispatchInput>(async ({ input }) => {
      try {
        const next = await dispatchCrewScheduleEvent(input.scheduleId, {
          event: input.event,
          state_version: input.stateVersion,
        })
        return { kind: 'ok', snapshot: next }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'unknown error'
        // 409 from the API surfaces as Error('… 409 …'). Detect it so
        // the machine can fetch the fresh snapshot rather than showing
        // an opaque banner. The server also returns the snapshot
        // inline on the 409 body, but re-fetching keeps this code
        // path identical to billing-review so the patterns match.
        if (/\b409\b|state_version|not allowed|illegal/i.test(message)) {
          try {
            const fresh = await fetchCrewScheduleSnapshot(input.scheduleId)
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
  id: 'crewSchedule',
  initial: 'loading',
  context: ({ input }) => ({
    scheduleId: input.scheduleId,
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
        input: ({ context }) => ({ scheduleId: context.scheduleId, companySlug: context.companySlug }),
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
            scheduleId: context.scheduleId,
            companySlug: context.companySlug,
            event: event.event,
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

export type CrewScheduleHookResult = {
  snapshot: CrewScheduleSnapshot | null
  error: string | null
  outOfSync: boolean
  isLoading: boolean
  isSubmitting: boolean
  refresh: () => void
  dispatch: (event: CrewScheduleHumanEvent) => void
  dismissError: () => void
}

export function useCrewSchedule(scheduleId: string, companySlug: string): CrewScheduleHookResult {
  const [state, send] = useMachine(crewScheduleMachine, { input: { scheduleId, companySlug } })

  // Re-load when the caller switches to a different schedule id.
  useEffect(() => {
    send({ type: 'LOAD' })
  }, [scheduleId, companySlug, send])

  const refresh = useCallback(() => send({ type: 'LOAD' }), [send])
  const dispatch = useCallback((event: CrewScheduleHumanEvent) => send({ type: 'DISPATCH', event }), [send])
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
