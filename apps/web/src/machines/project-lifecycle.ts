import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import {
  dispatchProjectLifecycleEvent,
  getProjectLifecycleSnapshot,
  type ProjectLifecycleHumanEvent,
  type ProjectLifecycleSnapshotResponse,
} from '../api-v1-compat'

/**
 * Headless project-lifecycle state machine.
 *
 * Mirrors the billing-review machine exactly — it owns ONLY UI state
 * (idle / loading / submitting / showingError / outOfSync). Business
 * state (lifecycle_state, state_version, next_events) lives on the
 * server snapshot and is stored on context as-is.
 *
 * See docs/DETERMINISTIC_WORKFLOWS.md → Headless UI Process Model.
 *
 * Events:
 *   LOAD            — fetch the project lifecycle snapshot
 *   DISPATCH        — submit a workflow event to the API
 *   DISMISS_ERROR   — clear a transient error banner
 */

type Context = {
  projectId: string
  companySlug: string
  snapshot: ProjectLifecycleSnapshotResponse | null
  error: string | null
  /** True when the last DISPATCH returned 409 — UI should call out the
   * stale-state condition explicitly so the user knows their click was
   * ignored against a newer server state. */
  outOfSync: boolean
}

type Event =
  | { type: 'LOAD' }
  | { type: 'DISPATCH'; event: ProjectLifecycleHumanEvent; reason?: string }
  | { type: 'DISMISS_ERROR' }

type LoadInput = { projectId: string; companySlug: string }
type DispatchInput = {
  projectId: string
  companySlug: string
  event: ProjectLifecycleHumanEvent
  stateVersion: number
  reason?: string
}

type DispatchOutput =
  | { kind: 'ok'; snapshot: ProjectLifecycleSnapshotResponse }
  | { kind: 'conflict'; snapshot: ProjectLifecycleSnapshotResponse | null; message: string }

export const projectLifecycleMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { projectId: string; companySlug: string },
    events: {} as Event,
  },
  actors: {
    loadSnapshot: fromPromise<ProjectLifecycleSnapshotResponse, LoadInput>(async ({ input }) => {
      return getProjectLifecycleSnapshot(input.projectId, input.companySlug)
    }),
    submitEvent: fromPromise<DispatchOutput, DispatchInput>(async ({ input }) => {
      try {
        const next = await dispatchProjectLifecycleEvent(
          input.projectId,
          input.event,
          input.stateVersion,
          input.reason,
          input.companySlug,
        )
        return { kind: 'ok', snapshot: next }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'unknown error'
        // 409 from the API surfaces as Error('… 409 …'). Detect it so the
        // machine can fetch the fresh snapshot rather than showing an
        // opaque banner.
        if (/\b409\b|state_version|not allowed|illegal/i.test(message)) {
          try {
            const fresh = await getProjectLifecycleSnapshot(input.projectId, input.companySlug)
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
  id: 'projectLifecycle',
  initial: 'loading',
  context: ({ input }) => ({
    projectId: input.projectId,
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
        input: ({ context }) => ({ projectId: context.projectId, companySlug: context.companySlug }),
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
          // Narrow: the guard in idle ensures `snapshot` is non-null at
          // this point. The DISPATCH event carries the workflow event
          // type and (optional) reason for DECLINE.
          if (event.type !== 'DISPATCH') throw new Error('submitting entered without DISPATCH event')
          return {
            projectId: context.projectId,
            companySlug: context.companySlug,
            event: event.event,
            stateVersion: context.snapshot!.state_version,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
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

export type ProjectLifecycleViewModel = {
  snapshot: ProjectLifecycleSnapshotResponse | null
  error: string | null
  outOfSync: boolean
  isLoading: boolean
  isSubmitting: boolean
  refresh: () => void
  dispatch: (event: ProjectLifecycleHumanEvent, reason?: string) => void
  dismissError: () => void
}

export function useProjectLifecycle(projectId: string, companySlug: string): ProjectLifecycleViewModel {
  const [state, send] = useMachine(projectLifecycleMachine, { input: { projectId, companySlug } })

  // Re-load when the caller switches to a different project id.
  useEffect(() => {
    send({ type: 'LOAD' })
  }, [projectId, companySlug, send])

  const refresh = useCallback(() => send({ type: 'LOAD' }), [send])
  const dispatch = useCallback(
    (event: ProjectLifecycleHumanEvent, reason?: string) =>
      reason !== undefined ? send({ type: 'DISPATCH', event, reason }) : send({ type: 'DISPATCH', event }),
    [send],
  )
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
