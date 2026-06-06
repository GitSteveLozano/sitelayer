import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import { workflowEventRef } from '@sitelayer/workflows'
import { compactTraceEventType, compactWorkflowSnapshot, emitControlPlaneTrace } from '@/lib/control-plane-trace'

/**
 * Generic factory for the headless workflow UI machines that wrap
 * deterministic backend reducers (rental-billing, estimate-push, and
 * any future workflow). The machine owns ONLY UI state — idle /
 * loading / submitting / showingError / outOfSync — and stores the
 * server-authoritative snapshot on context verbatim. The business
 * state (`state`, `state_version`, `next_events`) is never mirrored.
 *
 * See docs/DETERMINISTIC_WORKFLOWS.md → Headless UI Process Model.
 *
 * Use it like:
 *
 *   const { useHook } = createHeadlessWorkflowMachine<
 *     EstimatePushSnapshot,
 *     EstimatePushHumanEvent
 *   >({
 *     id: 'estimatePush',
 *     load: (id, slug) => getEstimatePushSnapshot(id, slug),
 *     submit: (id, event, version, slug) =>
 *       dispatchEstimatePushEvent(id, event, version, slug),
 *   })
 *
 *   export const useEstimatePush = useHook
 *
 * Before this lived as two copy-pasted machines (estimate-push.ts and
 * billing-review.ts). The third workflow would have made the
 * duplication a maintenance trap; lifting it to a factory keeps the
 * machine shape canonical.
 */

export type WorkflowSnapshotLike = { state_version: number }

type Context<TSnapshot> = {
  entityId: string
  companySlug: string
  snapshot: TSnapshot | null
  error: string | null
  /** True when the last DISPATCH returned 409 — UI should call out the
   * stale-state condition explicitly so the user knows their click was
   * ignored against a newer server state. */
  outOfSync: boolean
}

type Event<TEvent> = { type: 'LOAD' } | { type: 'DISPATCH'; event: TEvent } | { type: 'DISMISS_ERROR' }

type LoadInput = { entityId: string; companySlug: string }
type SubmitInput<TEvent> = {
  entityId: string
  companySlug: string
  event: TEvent
  stateVersion: number
}

type SubmitOutput<TSnapshot> =
  | { kind: 'ok'; snapshot: TSnapshot }
  | { kind: 'conflict'; snapshot: TSnapshot | null; message: string }

export type HeadlessWorkflowHookResult<TSnapshot, TEvent> = {
  snapshot: TSnapshot | null
  error: string | null
  outOfSync: boolean
  isLoading: boolean
  isSubmitting: boolean
  refresh: () => void
  dispatch: (event: TEvent) => void
  dismissError: () => void
}

export type HeadlessWorkflowConfig<TSnapshot extends WorkflowSnapshotLike, TEvent> = {
  /** xstate machine id — useful in devtools/Inspector traces. */
  id: string
  /**
   * Canonical backend workflow_name (e.g. `rental_billing_run`) used to compute
   * the transition-anchor `event_ref`. It MUST match the DB `workflow_name` so
   * the client trace and the server `workflow_event_log` row name the same
   * transition. Defaults to `id` for back-compat, but supply the DB name on
   * any workflow whose UI machine id differs from it (most do).
   */
  workflowName?: string
  /** Fetch the current server snapshot for the entity. */
  load: (entityId: string, companySlug: string) => Promise<TSnapshot>
  /**
   * Submit a human event. Implementations should throw on non-2xx; the
   * factory detects 409s heuristically (status text or message) and
   * reloads the snapshot rather than surfacing an opaque error.
   */
  submit: (entityId: string, event: TEvent, stateVersion: number, companySlug: string) => Promise<TSnapshot>
}

const CONFLICT_RE = /\b409\b|state_version|not allowed|illegal/i

export function createHeadlessWorkflowMachine<TSnapshot extends WorkflowSnapshotLike, TEvent>(
  config: HeadlessWorkflowConfig<TSnapshot, TEvent>,
) {
  const machine = setup({
    types: {
      context: {} as Context<TSnapshot>,
      input: {} as { entityId: string; companySlug: string },
      events: {} as Event<TEvent>,
    },
    actors: {
      loadSnapshot: fromPromise<TSnapshot, LoadInput>(async ({ input }) => {
        return config.load(input.entityId, input.companySlug)
      }),
      submitEvent: fromPromise<SubmitOutput<TSnapshot>, SubmitInput<TEvent>>(async ({ input }) => {
        try {
          const next = await config.submit(input.entityId, input.event, input.stateVersion, input.companySlug)
          return { kind: 'ok', snapshot: next }
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : 'unknown error'
          if (CONFLICT_RE.test(message)) {
            try {
              const fresh = await config.load(input.entityId, input.companySlug)
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
    id: config.id,
    initial: 'loading',
    context: ({ input }) => ({
      entityId: input.entityId,
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
          input: ({ context }) => ({ entityId: context.entityId, companySlug: context.companySlug }),
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
              entityId: context.entityId,
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

  // Canonical backend workflow_name for the transition-anchor; falls back to
  // the UI machine id when a consumer hasn't pinned the DB name.
  const workflowName = config.workflowName ?? config.id

  /**
   * The keystone: compute the SAME `workflow_event:<name>:<sha16>:<version>`
   * anchor the server forwarder stamps, so a load/dispatch trace and the
   * backend `workflow_event_log` row correlate at mesh ingest. Returns null
   * before the first snapshot arrives (no state_version to anchor on yet).
   */
  function computeEventRef(entityId: string, stateVersion: number | null | undefined): string | null {
    if (entityId === '' || typeof stateVersion !== 'number') return null
    return workflowEventRef({ workflow_name: workflowName, entity_id: entityId, state_version: stateVersion })
  }

  function useHook(entityId: string, companySlug: string): HeadlessWorkflowHookResult<TSnapshot, TEvent> {
    const [state, send] = useMachine(machine, { input: { entityId, companySlug } })

    useEffect(() => {
      send({ type: 'LOAD' })
    }, [entityId, companySlug, send])

    useEffect(() => {
      const snapshot = state.context.snapshot
      if (!snapshot) return
      emitControlPlaneTrace('sitelayer.workflow.state', {
        workflow_id: config.id,
        entity_id: state.context.entityId,
        company_slug: state.context.companySlug,
        event_ref: computeEventRef(state.context.entityId, snapshot.state_version),
        snapshot: compactWorkflowSnapshot(snapshot),
        out_of_sync: state.context.outOfSync,
        has_error: Boolean(state.context.error),
      })
    }, [
      state.context.companySlug,
      state.context.entityId,
      state.context.error,
      state.context.outOfSync,
      state.context.snapshot,
    ])

    const refresh = useCallback(() => send({ type: 'LOAD' }), [send])
    const dispatch = useCallback(
      (event: TEvent) => {
        emitControlPlaneTrace('sitelayer.workflow.event', {
          workflow_id: config.id,
          entity_id: state.context.entityId,
          company_slug: state.context.companySlug,
          event_type: compactTraceEventType(event),
          state_version: state.context.snapshot?.state_version ?? null,
          event_ref: computeEventRef(state.context.entityId, state.context.snapshot?.state_version),
        })
        send({ type: 'DISPATCH', event })
      },
      [send, state.context.companySlug, state.context.entityId, state.context.snapshot?.state_version],
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

  return { machine, useHook }
}
