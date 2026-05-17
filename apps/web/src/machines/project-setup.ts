import { useCallback, useEffect, useRef } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import { useQueryClient } from '@tanstack/react-query'
import { request } from '@/lib/api/client'
import { projectQueryKeys, useProject, type ProjectDetail } from '@/lib/api/projects'

/**
 * Project setup form UI machine.
 *
 * Modelled after `headless-workflow.ts` but for forms (not workflow
 * snapshots). Owns ONLY UI state — the loaded project, the form draft,
 * a dirty flag, submission status, and a 409-out-of-sync breadcrumb.
 *
 * Data fetching stays in TanStack Query. The component runs
 * `useProject(id)` and feeds the loaded row into the machine via the
 * `LOAD` event. The machine's `submit` actor wraps the PATCH call and
 * detects 409s with the same regex as `headless-workflow.ts`, then asks
 * the caller to reload the project (the `LOAD` event is re-sent with
 * fresh data once the TanStack invalidation lands).
 *
 * State graph:
 *
 *   loading ─LOAD(project)─▶ hydrating (assign form from project)
 *                              ─done(implicit)─▶ clean
 *   clean ─EDIT(field, value)─▶ dirty
 *         ─LOAD(project)─▶ hydrating
 *   dirty ─EDIT─▶ dirty
 *         ─SUBMIT─▶ submitting
 *         ─LOAD(project)─▶ hydrating (server-side change wins)
 *   submitting ─onDone(ok)─▶ clean (TanStack invalidates and re-LOADs)
 *              ─onDone(conflict)─▶ outOfSync (server snapshot updated)
 *              ─onError─▶ error
 *   outOfSync ─LOAD(project)─▶ hydrating
 *             ─DISMISS_ERROR─▶ dirty (user keeps editing the stale form)
 *   error ─DISMISS_ERROR─▶ dirty
 *         ─SUBMIT─▶ submitting (retry)
 */

export interface ProjectSetupForm {
  name: string
  siteLat: string
  siteLng: string
  siteRadius: number
  autoEnabled: boolean
  graceSec: number
  correctionSec: number
  budgetDollars: string
}

export type ProjectSetupField = keyof ProjectSetupForm

export type ProjectSetupFieldValue = string | number | boolean

type Context = {
  projectId: string
  project: ProjectDetail | null
  form: ProjectSetupForm
  error: string | null
  /** True when the last SUBMIT returned 409 — the form was rejected
   * against a newer server state. The UI surfaces this so the user
   * knows their click was ignored. */
  outOfSync: boolean
}

export type ProjectSetupEvent =
  | { type: 'LOAD'; project: ProjectDetail }
  | { type: 'EDIT'; field: ProjectSetupField; value: ProjectSetupFieldValue }
  | { type: 'SUBMIT' }
  | { type: 'DISMISS_ERROR' }

type SubmitInput = {
  projectId: string
  form: ProjectSetupForm
  expectedVersion: number
}

type SubmitOutput = { kind: 'ok' } | { kind: 'conflict'; message: string } | { kind: 'validation'; message: string }

const CONFLICT_RE = /\b409\b|state_version|expected_version|not allowed|illegal|version/i

const EMPTY_FORM: ProjectSetupForm = {
  name: '',
  siteLat: '',
  siteLng: '',
  siteRadius: 100,
  autoEnabled: true,
  graceSec: 300,
  correctionSec: 120,
  budgetDollars: '',
}

function formFromProject(project: ProjectDetail): ProjectSetupForm {
  return {
    name: project.name,
    siteLat: project.site_lat ?? '',
    siteLng: project.site_lng ?? '',
    siteRadius: project.site_radius_m ?? 100,
    autoEnabled: project.auto_clock_in_enabled,
    graceSec: project.auto_clock_out_grace_seconds,
    correctionSec: project.auto_clock_correction_window_seconds,
    budgetDollars: ((project.daily_budget_cents ?? 0) / 100).toString(),
  }
}

function validateForm(form: ProjectSetupForm): { ok: true } | { ok: false; message: string } {
  if (!form.name.trim()) return { ok: false, message: 'Name is required' }
  const lat = form.siteLat ? Number(form.siteLat) : null
  const lng = form.siteLng ? Number(form.siteLng) : null
  if (
    (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) ||
    (lng !== null && (!Number.isFinite(lng) || Math.abs(lng) > 180))
  ) {
    return { ok: false, message: 'Lat / lng out of range' }
  }
  const budget = Number(form.budgetDollars)
  if (!Number.isFinite(budget) || budget < 0) {
    return { ok: false, message: 'Daily budget must be a non-negative number' }
  }
  return { ok: true }
}

async function patchProject(input: SubmitInput): Promise<void> {
  const lat = input.form.siteLat ? Number(input.form.siteLat) : null
  const lng = input.form.siteLng ? Number(input.form.siteLng) : null
  const budget = Number(input.form.budgetDollars)
  await request(`/api/projects/${encodeURIComponent(input.projectId)}`, {
    method: 'PATCH',
    json: {
      expected_version: input.expectedVersion,
      name: input.form.name.trim(),
      site_lat: lat,
      site_lng: lng,
      site_radius_m: input.form.siteRadius,
      auto_clock_in_enabled: input.form.autoEnabled,
      auto_clock_out_grace_seconds: input.form.graceSec,
      auto_clock_correction_window_seconds: input.form.correctionSec,
      daily_budget_cents: Math.round(budget * 100),
    },
  })
}

export const projectSetupMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { projectId: string },
    events: {} as ProjectSetupEvent,
  },
  actors: {
    submitProject: fromPromise<SubmitOutput, SubmitInput>(async ({ input }) => {
      const validation = validateForm(input.form)
      if (!validation.ok) {
        return { kind: 'validation', message: validation.message }
      }
      try {
        await patchProject(input)
        return { kind: 'ok' }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Save failed'
        if (CONFLICT_RE.test(message)) {
          return { kind: 'conflict', message }
        }
        throw caught
      }
    }),
  },
  actions: {
    applyProject: assign({
      project: ({ context, event }) => {
        if (event.type !== 'LOAD') return context.project
        return event.project
      },
      form: ({ context, event }) => {
        if (event.type !== 'LOAD') return context.form
        return formFromProject(event.project)
      },
      error: () => null,
      outOfSync: () => false,
    }),
    setField: assign({
      form: ({ context, event }) => {
        if (event.type !== 'EDIT') return context.form
        return { ...context.form, [event.field]: event.value } as ProjectSetupForm
      },
      error: () => null,
    }),
    clearError: assign({ error: () => null, outOfSync: () => false }),
  },
}).createMachine({
  id: 'projectSetup',
  initial: 'loading',
  context: ({ input }) => ({
    projectId: input.projectId,
    project: null,
    form: { ...EMPTY_FORM },
    error: null,
    outOfSync: false,
  }),
  states: {
    loading: {
      on: {
        LOAD: { target: 'hydrating', actions: 'applyProject' },
      },
    },
    hydrating: {
      always: 'clean',
    },
    clean: {
      on: {
        LOAD: { target: 'hydrating', actions: 'applyProject' },
        EDIT: { target: 'dirty', actions: 'setField' },
      },
    },
    dirty: {
      on: {
        LOAD: { target: 'hydrating', actions: 'applyProject' },
        EDIT: { actions: 'setField' },
        SUBMIT: {
          target: 'submitting',
          guard: ({ context }) => context.project !== null,
        },
        DISMISS_ERROR: { actions: 'clearError' },
      },
    },
    submitting: {
      invoke: {
        src: 'submitProject',
        input: ({ context }) => ({
          projectId: context.projectId,
          form: context.form,
          expectedVersion: context.project!.version,
        }),
        onDone: [
          {
            target: 'clean',
            guard: ({ event }) => event.output.kind === 'ok',
          },
          {
            target: 'outOfSync',
            guard: ({ event }) => event.output.kind === 'conflict',
            actions: assign({
              error: ({ event }) => (event.output.kind === 'conflict' ? event.output.message : null),
              outOfSync: () => true,
            }),
          },
          {
            // Validation failure — stay in dirty with the message surfaced.
            target: 'dirty',
            actions: assign({
              error: ({ event }) => (event.output.kind === 'validation' ? event.output.message : null),
            }),
          },
        ],
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'Save failed'),
          }),
        },
      },
    },
    outOfSync: {
      on: {
        LOAD: { target: 'hydrating', actions: 'applyProject' },
        EDIT: { target: 'dirty', actions: 'setField' },
        DISMISS_ERROR: { target: 'dirty', actions: 'clearError' },
      },
    },
    error: {
      on: {
        LOAD: { target: 'hydrating', actions: 'applyProject' },
        EDIT: { target: 'dirty', actions: 'setField' },
        SUBMIT: {
          target: 'submitting',
          guard: ({ context }) => context.project !== null,
        },
        DISMISS_ERROR: { target: 'dirty', actions: 'clearError' },
      },
    },
  },
})

export type ProjectSetupState = 'loading' | 'hydrating' | 'clean' | 'dirty' | 'submitting' | 'outOfSync' | 'error'

export interface ProjectSetupHookResult {
  state: ProjectSetupState
  project: ProjectDetail | null
  form: ProjectSetupForm
  error: string | null
  outOfSync: boolean
  isLoading: boolean
  isClean: boolean
  isDirty: boolean
  isSubmitting: boolean
  isError: boolean
  /** True when no project ever resolved (component should render the
   * "Project not found" empty state). */
  isMissing: boolean
  edit: (field: ProjectSetupField, value: ProjectSetupFieldValue) => void
  submit: () => void
  dismissError: () => void
}

/**
 * Hook that wires the project-setup machine to TanStack Query.
 *
 * TanStack owns the actual GET — every successful fetch (initial load
 * and post-submit invalidation) feeds the project row back into the
 * machine via a `LOAD` event. The machine owns dirty / outOfSync /
 * submitting orchestration.
 */
export function useProjectSetup(projectId: string | null): ProjectSetupHookResult {
  const query = useProject(projectId)
  const project = query.data?.project ?? null
  const qc = useQueryClient()
  const [state, send] = useMachine(projectSetupMachine, { input: { projectId: projectId ?? '' } })

  // Track the version we last hydrated from so we only re-LOAD when the
  // server returns a strictly newer row. Keeps user edits intact across
  // TanStack refetches that return the same version.
  const lastHydratedVersionRef = useRef<number | null>(null)
  const stateValue = state.value as ProjectSetupState

  // Feed every NEW project snapshot from TanStack into the machine.
  useEffect(() => {
    if (!project) return
    if (stateValue === 'submitting') return
    if (lastHydratedVersionRef.current === project.version) return
    lastHydratedVersionRef.current = project.version
    send({ type: 'LOAD', project })
  }, [project, send, stateValue])

  // After a successful save or a 409 conflict, invalidate the cached
  // project. TanStack re-fetches; the version bump triggers the LOAD
  // effect above which re-hydrates the form from the new server row.
  const prevStateRef = useRef<ProjectSetupState>(stateValue)
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = stateValue
    if (prev === 'submitting' && (stateValue === 'clean' || stateValue === 'outOfSync')) {
      void qc.invalidateQueries({ queryKey: projectQueryKeys.all() })
    }
  }, [stateValue, qc])

  const edit = useCallback(
    (field: ProjectSetupField, value: ProjectSetupFieldValue) => send({ type: 'EDIT', field, value }),
    [send],
  )
  const submit = useCallback(() => send({ type: 'SUBMIT' }), [send])
  const dismissError = useCallback(() => send({ type: 'DISMISS_ERROR' }), [send])

  return {
    state: stateValue,
    project: state.context.project ?? project,
    form: state.context.form,
    error: state.context.error,
    outOfSync: state.context.outOfSync,
    isLoading: query.isPending && !state.context.project,
    isClean: stateValue === 'clean',
    isDirty: stateValue === 'dirty',
    isSubmitting: stateValue === 'submitting',
    isError: stateValue === 'error',
    isMissing: !query.isPending && !project && !state.context.project,
    edit,
    submit,
    dismissError,
  }
}
