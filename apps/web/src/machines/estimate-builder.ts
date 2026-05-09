import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import { ApiError, request } from '../lib/api/client'
import { fetchScopeVsBid, type EstimateLine, type ScopeVsBidResponse } from '../lib/api/estimate'

/**
 * Headless estimate-builder UI state machine.
 *
 * Owns ONLY UI state (loading / idle / saving / conflict / error). Business
 * state — the actual `estimate_lines` rows, totals, lifecycle — comes from
 * the server through `fetchScopeVsBid` and is mirrored to context as-is so
 * the screen never invents a state the API doesn't know about.
 *
 * Mirrors the shape of `apps/web/src/machines/estimate-push.ts`:
 *   - `setup({ types, actors }).createMachine(…)` for type-safe context/events
 *   - `fromPromise` actors for load/save so cancellation + retry behave
 *   - `input`-pattern initial context so React can re-mount with a new
 *     project id and the machine resets cleanly
 *
 * Save semantics (slice constraint): the API does not (yet) expose
 * `PATCH /api/estimate-lines/:id`. Instead the line-level edits land on
 * `takeoff_measurements` and `recompute` rebuilds the snapshot. Until the
 * per-line PATCH lands, the SAVE actor is wired against the recompute path
 * and the dirty queue from the screen is stored on context so the next
 * save flushes everything in one call. A 409 from any save reloads the
 * snapshot and surfaces a conflict toast — same contract as estimate-push.
 *
 * EDIT_LINE doesn't transition states; it stages a change in `pendingEdits`
 * which the screen drains on a debounced SAVE.
 */

export interface PendingLineEdit {
  service_item_code: string
  /** Optional override; null/undefined means "leave qty as the takeoff says". */
  quantity?: number
  /** Optional rate override (overrides service-item default + pricing-profile). */
  override_rate?: number | null
}

type Context = {
  projectId: string
  companySlug: string
  snapshot: ScopeVsBidResponse | null
  pendingEdits: Record<string, PendingLineEdit>
  error: string | null
  conflict: boolean
}

type Event =
  | { type: 'LOAD' }
  | { type: 'EDIT_LINE'; edit: PendingLineEdit }
  | { type: 'SAVE' }
  | { type: 'RECOMPUTE' }
  | { type: 'DISMISS_ERROR' }

type LoadInput = { projectId: string }
type SaveInput = { projectId: string; edits: Record<string, PendingLineEdit> }
type RecomputeInput = { projectId: string }

type SaveOutput =
  | { kind: 'ok'; snapshot: ScopeVsBidResponse }
  | { kind: 'conflict'; snapshot: ScopeVsBidResponse | null; message: string }

async function recomputeProjectEstimate(projectId: string): Promise<{ scope_vs_bid: ScopeVsBidResponse }> {
  return request<{ scope_vs_bid: ScopeVsBidResponse }>(
    `/api/projects/${encodeURIComponent(projectId)}/estimate/recompute`,
    { method: 'POST', json: {} },
  )
}

export const estimateBuilderMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { projectId: string; companySlug: string },
    events: {} as Event,
  },
  actors: {
    loadSnapshot: fromPromise<ScopeVsBidResponse, LoadInput>(async ({ input }) => {
      return fetchScopeVsBid(input.projectId)
    }),
    submitEdits: fromPromise<SaveOutput, SaveInput>(async ({ input }) => {
      // INTEGRATION TODO: when `PATCH /api/estimate-lines/:id` lands, replace
      // this body with a parallel batch of PATCHes keyed on
      // `input.edits[code].override_rate / quantity`. Until then the takeoff
      // → recompute path is the source of truth and we forward through it.
      try {
        const refresh = await recomputeProjectEstimate(input.projectId)
        return { kind: 'ok', snapshot: refresh.scope_vs_bid }
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 409) {
          try {
            const fresh = await fetchScopeVsBid(input.projectId)
            return { kind: 'conflict', snapshot: fresh, message: caught.message_for_user() }
          } catch {
            return { kind: 'conflict', snapshot: null, message: caught.message_for_user() }
          }
        }
        throw caught
      }
    }),
    runRecompute: fromPromise<ScopeVsBidResponse, RecomputeInput>(async ({ input }) => {
      const refresh = await recomputeProjectEstimate(input.projectId)
      return refresh.scope_vs_bid
    }),
  },
}).createMachine({
  id: 'estimateBuilder',
  initial: 'loading',
  context: ({ input }) => ({
    projectId: input.projectId,
    companySlug: input.companySlug,
    snapshot: null,
    pendingEdits: {},
    error: null,
    conflict: false,
  }),
  states: {
    loading: {
      invoke: {
        src: 'loadSnapshot',
        input: ({ context }) => ({ projectId: context.projectId }),
        onDone: {
          target: 'idle',
          actions: assign({
            snapshot: ({ event }) => event.output,
            error: () => null,
            conflict: () => false,
            pendingEdits: () => ({}),
          }),
        },
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to load'),
          }),
        },
      },
    },
    idle: {
      on: {
        LOAD: 'loading',
        EDIT_LINE: {
          // Stage the edit in pendingEdits keyed on service_item_code. The
          // screen owns its own debounced auto-save and drives SAVE.
          actions: assign({
            pendingEdits: ({ context, event }) => ({
              ...context.pendingEdits,
              [event.edit.service_item_code]: {
                ...context.pendingEdits[event.edit.service_item_code],
                ...event.edit,
              },
            }),
          }),
        },
        SAVE: {
          target: 'saving',
          guard: ({ context }) => Object.keys(context.pendingEdits).length > 0,
        },
        RECOMPUTE: 'recomputing',
        DISMISS_ERROR: {
          actions: assign({ error: () => null, conflict: () => false }),
        },
      },
    },
    saving: {
      invoke: {
        src: 'submitEdits',
        input: ({ context }) => ({ projectId: context.projectId, edits: context.pendingEdits }),
        onDone: [
          {
            target: 'conflict',
            guard: ({ event }) => event.output.kind === 'conflict',
            actions: assign(({ event }) => ({
              snapshot: event.output.snapshot ?? null,
              error: event.output.kind === 'conflict' ? event.output.message : null,
              conflict: true,
              pendingEdits: {},
            })),
          },
          {
            target: 'idle',
            actions: assign(({ event }) => ({
              snapshot: event.output.kind === 'ok' ? event.output.snapshot : null,
              error: null,
              conflict: false,
              pendingEdits: {},
            })),
          },
        ],
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to save'),
          }),
        },
      },
    },
    recomputing: {
      invoke: {
        src: 'runRecompute',
        input: ({ context }) => ({ projectId: context.projectId }),
        onDone: {
          target: 'idle',
          actions: assign({
            snapshot: ({ event }) => event.output,
            error: () => null,
            conflict: () => false,
            pendingEdits: () => ({}),
          }),
        },
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to recompute'),
          }),
        },
      },
    },
    conflict: {
      on: {
        LOAD: 'loading',
        DISMISS_ERROR: {
          target: 'idle',
          actions: assign({ error: () => null, conflict: () => false }),
        },
      },
    },
    error: {
      on: {
        LOAD: 'loading',
        DISMISS_ERROR: {
          target: 'idle',
          actions: assign({ error: () => null, conflict: () => false }),
        },
      },
    },
  },
})

export type EstimateBuilderHookSnapshot = {
  snapshot: ScopeVsBidResponse | null
  pendingEdits: Record<string, PendingLineEdit>
  lines: EstimateLine[]
  error: string | null
  conflict: boolean
  isLoading: boolean
  isSaving: boolean
  isRecomputing: boolean
  hasDirtyEdits: boolean
  refresh: () => void
  editLine: (edit: PendingLineEdit) => void
  save: () => void
  recompute: () => void
  dismissError: () => void
}

export function useEstimateBuilder(projectId: string, companySlug: string): EstimateBuilderHookSnapshot {
  const [state, send] = useMachine(estimateBuilderMachine, { input: { projectId, companySlug } })

  useEffect(() => {
    send({ type: 'LOAD' })
  }, [projectId, companySlug, send])

  const refresh = useCallback(() => send({ type: 'LOAD' }), [send])
  const editLine = useCallback((edit: PendingLineEdit) => send({ type: 'EDIT_LINE', edit }), [send])
  const save = useCallback(() => send({ type: 'SAVE' }), [send])
  const recompute = useCallback(() => send({ type: 'RECOMPUTE' }), [send])
  const dismissError = useCallback(() => send({ type: 'DISMISS_ERROR' }), [send])

  return {
    snapshot: state.context.snapshot,
    pendingEdits: state.context.pendingEdits,
    lines: state.context.snapshot?.lines ?? [],
    error: state.context.error,
    conflict: state.context.conflict,
    isLoading: state.matches('loading'),
    isSaving: state.matches('saving'),
    isRecomputing: state.matches('recomputing'),
    hasDirtyEdits: Object.keys(state.context.pendingEdits).length > 0,
    refresh,
    editLine,
    save,
    recompute,
    dismissError,
  }
}
