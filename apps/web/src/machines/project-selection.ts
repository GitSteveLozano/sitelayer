import { useCallback, useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import {
  apiGet,
  type BlueprintRow,
  type MaterialBillRow,
  type MeasurementRow,
  type ProjectSummary,
  type ScheduleRow,
} from '../api.js'

/**
 * Project-selection state machine.
 *
 * Replaces App.tsx's project-selection cluster (Effect 6 in the legacy
 * audit) — the per-project fan-out that fetched summary + blueprints +
 * measurements + material_bills + schedules whenever `selectedProjectId`
 * changed. Owns:
 *   • summary, blueprints, measurements, materialBills, schedules
 *   • selectedBlueprintId (auto-picked on bootstrap; sticky if still valid)
 *   • the in-flight fetch so a quick project switch can't interleave two
 *     responses against each other
 *
 * Events:
 *   PROJECT_CHANGED  — caller switched (or cleared) the active project
 *   REFRESH          — re-run the fan-out (e.g. after a mutation)
 *   COMPANY_CHANGED  — caller switched company; reset everything to empty
 */
type ProjectFetchOutput = {
  summary: ProjectSummary | null
  blueprints: BlueprintRow[]
  measurements: MeasurementRow[]
  materialBills: MaterialBillRow[]
  schedules: ScheduleRow[]
}

type Context = {
  companySlug: string
  projectId: string
  summary: ProjectSummary | null
  blueprints: BlueprintRow[]
  measurements: MeasurementRow[]
  materialBills: MaterialBillRow[]
  schedules: ScheduleRow[]
  selectedBlueprintId: string
  error: string | null
}

type Event =
  | { type: 'PROJECT_CHANGED'; projectId: string }
  | { type: 'REFRESH' }
  | { type: 'COMPANY_CHANGED'; companySlug: string }
  | { type: 'SET_SELECTED_BLUEPRINT'; blueprintId: string }

const EMPTY_CONTEXT: Omit<Context, 'companySlug' | 'projectId' | 'selectedBlueprintId' | 'error'> = {
  summary: null,
  blueprints: [],
  measurements: [],
  materialBills: [],
  schedules: [],
}

export const projectSelectionMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { companySlug: string; projectId: string },
    events: {} as Event,
  },
  actors: {
    fetchProject: fromPromise<ProjectFetchOutput, { companySlug: string; projectId: string }>(async ({ input }) => {
      if (!input.projectId) {
        return {
          summary: null,
          blueprints: [],
          measurements: [],
          materialBills: [],
          schedules: [],
        }
      }
      // Mirror the legacy refreshSummary + refreshTakeoff sequence: project
      // summary, blueprints + measurements + bills in parallel, then
      // schedules (which is a separate API path).
      const [summary, blueprintData, measurementData, billData] = await Promise.all([
        apiGet<ProjectSummary>(`/api/projects/${input.projectId}/summary`, input.companySlug),
        apiGet<{ blueprints: BlueprintRow[] }>(`/api/projects/${input.projectId}/blueprints`, input.companySlug),
        apiGet<{ measurements: MeasurementRow[] }>(
          `/api/projects/${input.projectId}/takeoff/measurements`,
          input.companySlug,
        ),
        apiGet<{ materialBills: MaterialBillRow[] }>(
          `/api/projects/${input.projectId}/material-bills`,
          input.companySlug,
        ),
      ])
      const scheduleData = await apiGet<{ schedules: ScheduleRow[] }>(
        `/api/projects/${input.projectId}/schedules`,
        input.companySlug,
      )
      return {
        summary,
        blueprints: blueprintData.blueprints,
        measurements: measurementData.measurements,
        materialBills: billData.materialBills,
        schedules: scheduleData.schedules,
      }
    }),
  },
}).createMachine({
  id: 'projectSelection',
  initial: 'idle',
  context: ({ input }) => ({
    companySlug: input.companySlug,
    projectId: input.projectId,
    selectedBlueprintId: '',
    error: null,
    ...EMPTY_CONTEXT,
  }),
  on: {
    COMPANY_CHANGED: {
      target: '.idle',
      actions: assign({
        companySlug: ({ event }) => event.companySlug,
        projectId: () => '',
        selectedBlueprintId: () => '',
        error: () => null,
        ...EMPTY_CONTEXT,
      }),
    },
    PROJECT_CHANGED: {
      target: '.fetching',
      actions: assign({
        projectId: ({ event }) => event.projectId,
        // Clear the dependent caches immediately so the UI doesn't render
        // stale rows for the previous project while the new fetch runs.
        ...EMPTY_CONTEXT,
        error: () => null,
      }),
    },
    SET_SELECTED_BLUEPRINT: {
      actions: assign({
        selectedBlueprintId: ({ event }) => event.blueprintId,
      }),
    },
  },
  states: {
    idle: {
      on: {
        REFRESH: 'fetching',
      },
      always: [{ target: 'fetching', guard: ({ context }) => context.projectId !== '' }],
    },
    fetching: {
      invoke: {
        src: 'fetchProject',
        input: ({ context }) => ({ companySlug: context.companySlug, projectId: context.projectId }),
        onDone: {
          target: 'idle',
          actions: assign(({ context, event }) => ({
            summary: event.output.summary,
            blueprints: event.output.blueprints,
            measurements: event.output.measurements,
            materialBills: event.output.materialBills,
            schedules: event.output.schedules,
            // Sticky blueprint selection: keep the prior pick if it's still
            // present in the new blueprint list, otherwise auto-pick first.
            selectedBlueprintId:
              context.selectedBlueprintId &&
              event.output.blueprints.some((blueprint) => blueprint.id === context.selectedBlueprintId)
                ? context.selectedBlueprintId
                : (event.output.blueprints[0]?.id ?? ''),
            error: null,
          })),
        },
        onError: {
          target: 'idle',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'unknown error'),
          }),
        },
      },
    },
  },
})

export type ProjectSelectionSnapshot = {
  summary: ProjectSummary | null
  blueprints: BlueprintRow[]
  measurements: MeasurementRow[]
  materialBills: MaterialBillRow[]
  schedules: ScheduleRow[]
  selectedBlueprintId: string
  error: string | null
  isFetching: boolean
  refresh: () => void
  setSelectedBlueprintId: (blueprintId: string) => void
}

/**
 * Hook mirroring App.tsx's legacy refreshSummary + refreshTakeoff +
 * Effect 6. Caller passes companySlug + the active projectId; the machine
 * auto-fetches when either changes.
 */
export function useProjectSelection(companySlug: string, projectId: string): ProjectSelectionSnapshot {
  const [state, send] = useMachine(projectSelectionMachine, { input: { companySlug, projectId } })

  useEffect(() => {
    send({ type: 'COMPANY_CHANGED', companySlug })
  }, [companySlug, send])

  useEffect(() => {
    send({ type: 'PROJECT_CHANGED', projectId })
  }, [projectId, send])

  const refresh = useCallback(() => send({ type: 'REFRESH' }), [send])
  const setSelectedBlueprintId = useCallback(
    (blueprintId: string) => send({ type: 'SET_SELECTED_BLUEPRINT', blueprintId }),
    [send],
  )

  return {
    summary: state.context.summary,
    blueprints: state.context.blueprints,
    measurements: state.context.measurements,
    materialBills: state.context.materialBills,
    schedules: state.context.schedules,
    selectedBlueprintId: state.context.selectedBlueprintId,
    error: state.context.error,
    isFetching: state.matches('fetching'),
    refresh,
    setSelectedBlueprintId,
  }
}
