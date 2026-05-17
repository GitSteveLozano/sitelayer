import {
  dispatchProjectLifecycleEvent,
  fetchProjectLifecycle,
  type ProjectLifecycleHumanEventEnvelope,
  type ProjectLifecycleSnapshot,
} from '@/lib/api'
import { createHeadlessWorkflowMachine, type HeadlessWorkflowHookResult } from './headless-workflow'

/**
 * Headless project-lifecycle state machine. The full machine shape
 * lives in headless-workflow.ts; this file only binds the workflow-
 * specific snapshot + event types and the API client calls.
 *
 * The event type is a discriminated envelope rather than a bare string
 * because DECLINE optionally carries a reason. The factory's submit
 * signature is `(entityId, event, stateVersion, companySlug)`, so the
 * event object itself has to be everything the dispatcher needs — the
 * reason rides along on the DECLINE variant.
 */
const { machine, useHook } = createHeadlessWorkflowMachine<
  ProjectLifecycleSnapshot,
  ProjectLifecycleHumanEventEnvelope
>({
  id: 'projectLifecycle',
  load: (projectId) => fetchProjectLifecycle(projectId),
  submit: (projectId, event, stateVersion) => dispatchProjectLifecycleEvent(projectId, event, stateVersion),
})

export const projectLifecycleMachine = machine

export type ProjectLifecycleViewModel = HeadlessWorkflowHookResult<
  ProjectLifecycleSnapshot,
  ProjectLifecycleHumanEventEnvelope
>

export function useProjectLifecycle(projectId: string, companySlug: string): ProjectLifecycleViewModel {
  return useHook(projectId, companySlug)
}
