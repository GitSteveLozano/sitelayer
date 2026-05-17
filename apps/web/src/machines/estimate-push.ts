import {
  dispatchEstimatePushEvent,
  fetchEstimatePush,
  type EstimatePushHumanEvent,
  type EstimatePushSnapshot,
} from '@/lib/api'
import { createHeadlessWorkflowMachine, type HeadlessWorkflowHookResult } from './headless-workflow'

/**
 * Headless estimate-push state machine. The full machine shape lives in
 * headless-workflow.ts; this file only binds the workflow-specific
 * snapshot + event types and the API client calls.
 */
const { machine, useHook } = createHeadlessWorkflowMachine<EstimatePushSnapshot, EstimatePushHumanEvent>({
  id: 'estimatePush',
  load: (pushId) => fetchEstimatePush(pushId),
  submit: (pushId, event, stateVersion) => dispatchEstimatePushEvent(pushId, event, stateVersion),
})

export const estimatePushMachine = machine

export type EstimatePushHookSnapshot = HeadlessWorkflowHookResult<EstimatePushSnapshot, EstimatePushHumanEvent>

export function useEstimatePush(pushId: string, companySlug: string): EstimatePushHookSnapshot {
  return useHook(pushId, companySlug)
}
