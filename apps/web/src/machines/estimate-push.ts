import {
  dispatchEstimatePushEvent,
  getEstimatePushSnapshot,
  type EstimatePushHumanEvent,
  type EstimatePushWorkflowSnapshotResponse,
} from '../api-v1-compat'
import { createHeadlessWorkflowMachine, type HeadlessWorkflowHookResult } from './headless-workflow'

/**
 * Headless estimate-push state machine. The full machine shape lives in
 * headless-workflow.ts; this file only binds the workflow-specific
 * snapshot + event types and the API client calls.
 */
const { machine, useHook } = createHeadlessWorkflowMachine<
  EstimatePushWorkflowSnapshotResponse,
  EstimatePushHumanEvent
>({
  id: 'estimatePush',
  load: (pushId, companySlug) => getEstimatePushSnapshot(pushId, companySlug),
  submit: (pushId, event, stateVersion, companySlug) =>
    dispatchEstimatePushEvent(pushId, event, stateVersion, companySlug),
})

export const estimatePushMachine = machine

export type EstimatePushHookSnapshot = HeadlessWorkflowHookResult<
  EstimatePushWorkflowSnapshotResponse,
  EstimatePushHumanEvent
>

export function useEstimatePush(pushId: string, companySlug: string): EstimatePushHookSnapshot {
  return useHook(pushId, companySlug)
}
