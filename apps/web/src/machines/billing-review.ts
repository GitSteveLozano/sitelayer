import {
  dispatchRentalBillingEvent,
  getRentalBillingRunSnapshot,
  type RentalBillingHumanEvent,
  type RentalBillingWorkflowSnapshotResponse,
} from '../api-v1-compat'
import { createHeadlessWorkflowMachine, type HeadlessWorkflowHookResult } from './headless-workflow'

/**
 * Headless billing-review state machine. The full machine shape lives in
 * headless-workflow.ts; this file only binds the workflow-specific
 * snapshot + event types and the API client calls.
 */
const { machine, useHook } = createHeadlessWorkflowMachine<
  RentalBillingWorkflowSnapshotResponse,
  RentalBillingHumanEvent
>({
  id: 'billingReview',
  load: (runId, companySlug) => getRentalBillingRunSnapshot(runId, companySlug),
  submit: (runId, event, stateVersion, companySlug) =>
    dispatchRentalBillingEvent(runId, event, stateVersion, companySlug),
})

export const billingReviewMachine = machine

export type BillingReviewSnapshot = HeadlessWorkflowHookResult<
  RentalBillingWorkflowSnapshotResponse,
  RentalBillingHumanEvent
>

export function useBillingReview(runId: string, companySlug: string): BillingReviewSnapshot {
  return useHook(runId, companySlug)
}
