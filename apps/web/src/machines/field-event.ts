import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import { apiGet, apiPatch } from '../api-v1-compat'

/**
 * Headless field-event state machine — sister of billing-review.
 *
 * Field-event escalation moves a worker_issues row through
 *   open → resolved | escalated | dismissed
 * and lets a foreman REOPEN any non-open state. The reducer is
 * authoritative on the server (packages/workflows/src/field-event.ts);
 * this machine only owns UI state (loading / submitting / error /
 * outOfSync), never the business state itself.
 *
 * Patterned on apps/web/src/machines/billing-review.ts. The transport
 * shape is the only difference: workflow events for worker_issues
 * land on PATCH /api/worker-issues/:id (one path) rather than POST
 * /api/<entity>-runs/:id/events (path-per-event).
 *
 * Events:
 *   LOAD          fetch the snapshot (initial mount + manual refresh)
 *   DISPATCH      submit a workflow event to the API
 *   DISMISS_ERROR clear the transient error banner
 */

// Wire types kept local rather than re-exported from
// @sitelayer/workflows because the web bundle doesn't depend on the
// workflows package directly — see api-v1-compat for the convention.
export type FieldEventState = 'open' | 'resolved' | 'escalated' | 'dismissed'

export type FieldEventResolutionAction = 'order_more' | 'bring_from_site' | 'use_what_we_have' | 'park' | 'change_order'

export type FieldEventHumanEvent =
  | { event: 'RESOLVE'; action: FieldEventResolutionAction; message_to_worker: string }
  | { event: 'ESCALATE'; reason: string }
  | { event: 'DISMISS' }
  | { event: 'REOPEN' }

export interface FieldEventNextEvent {
  type: 'RESOLVE' | 'ESCALATE' | 'DISMISS' | 'REOPEN'
  label: string
}

export interface FieldEventSnapshotContext {
  id: string
  company_id: string
  project_id: string | null
  worker_id: string | null
  reporter_clerk_user_id: string
  kind: string
  message: string
  severity: 'question' | 'slowing' | 'stopped'
  state_version: number
  resolved_at: string | null
  resolved_by_clerk_user_id: string | null
  resolved_action: string | null
  resolution_message: string | null
  escalated_to_estimator_at: string | null
  escalation_reason: string | null
  created_at: string
}

export interface FieldEventSnapshotResponse {
  state: FieldEventState
  state_version: number
  context: FieldEventSnapshotContext
  next_events: FieldEventNextEvent[]
}

interface MachineContext {
  issueId: string
  companySlug: string
  snapshot: FieldEventSnapshotResponse | null
  error: string | null
  /** True when the last DISPATCH returned 409 — UI should call out the
   *  stale-state condition explicitly so the foreman knows their click
   *  was ignored against a newer server state. */
  outOfSync: boolean
}

type MachineEvent = { type: 'LOAD' } | { type: 'DISPATCH'; event: FieldEventHumanEvent } | { type: 'DISMISS_ERROR' }

type LoadInput = { issueId: string; companySlug: string }
type DispatchInput = {
  issueId: string
  companySlug: string
  event: FieldEventHumanEvent
  stateVersion: number
}

type DispatchOutput =
  | { kind: 'ok'; snapshot: FieldEventSnapshotResponse }
  | { kind: 'conflict'; snapshot: FieldEventSnapshotResponse | null; message: string }

async function fetchFieldEventSnapshot(issueId: string, companySlug: string): Promise<FieldEventSnapshotResponse> {
  return apiGet<FieldEventSnapshotResponse>(`/api/worker-issues/${encodeURIComponent(issueId)}`, companySlug)
}

async function dispatchFieldEventEvent(
  issueId: string,
  event: FieldEventHumanEvent,
  stateVersion: number,
  companySlug: string,
): Promise<FieldEventSnapshotResponse> {
  return apiPatch<FieldEventSnapshotResponse>(
    `/api/worker-issues/${encodeURIComponent(issueId)}`,
    { ...event, state_version: stateVersion },
    companySlug,
  )
}

export const fieldEventMachine = setup({
  types: {
    context: {} as MachineContext,
    input: {} as { issueId: string; companySlug: string },
    events: {} as MachineEvent,
  },
  actors: {
    loadSnapshot: fromPromise<FieldEventSnapshotResponse, LoadInput>(async ({ input }) => {
      return fetchFieldEventSnapshot(input.issueId, input.companySlug)
    }),
    submitEvent: fromPromise<DispatchOutput, DispatchInput>(async ({ input }) => {
      try {
        const next = await dispatchFieldEventEvent(input.issueId, input.event, input.stateVersion, input.companySlug)
        return { kind: 'ok', snapshot: next }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'unknown error'
        // 409 from the API surfaces as Error('… 409 …'). Detect it so
        // the machine can fetch the fresh snapshot rather than showing
        // an opaque banner. Same heuristic as billing-review.
        if (/\b409\b|state_version|not allowed|illegal/i.test(message)) {
          try {
            const fresh = await fetchFieldEventSnapshot(input.issueId, input.companySlug)
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
  id: 'fieldEvent',
  initial: 'loading',
  context: ({ input }) => ({
    issueId: input.issueId,
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
        input: ({ context }) => ({ issueId: context.issueId, companySlug: context.companySlug }),
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
          // The guard in `idle` ensures `snapshot` is non-null at this
          // point; the DISPATCH event carries the workflow event.
          if (event.type !== 'DISPATCH') throw new Error('submitting entered without DISPATCH event')
          return {
            issueId: context.issueId,
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

export type FieldEventHookValue = {
  snapshot: FieldEventSnapshotResponse | null
  error: string | null
  outOfSync: boolean
  isLoading: boolean
  isSubmitting: boolean
  refresh: () => void
  dispatch: (event: FieldEventHumanEvent) => void
  dismissError: () => void
}

export function useFieldEvent(issueId: string, companySlug: string): FieldEventHookValue {
  const [state, send] = useMachine(fieldEventMachine, { input: { issueId, companySlug } })

  // Re-load when the caller switches to a different issue id.
  useEffect(() => {
    send({ type: 'LOAD' })
  }, [issueId, companySlug, send])

  const refresh = useCallback(() => send({ type: 'LOAD' }), [send])
  const dispatch = useCallback((event: FieldEventHumanEvent) => send({ type: 'DISPATCH', event }), [send])
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
