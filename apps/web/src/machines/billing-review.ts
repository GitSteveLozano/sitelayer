import { RENTAL_BILLING_WORKFLOW_NAME } from '@sitelayer/workflows'
import {
  dispatchBillingRunEvent,
  fetchBillingRun,
  type RentalBillingHumanEvent,
  type RentalBillingSnapshot,
} from '@/lib/api'
import { createHeadlessWorkflowMachine, type HeadlessWorkflowHookResult } from './headless-workflow'

/**
 * Headless billing-review state machine. The full machine shape lives in
 * headless-workflow.ts; this file only binds the workflow-specific
 * snapshot + event types and the API client calls.
 */
const { machine, useHook } = createHeadlessWorkflowMachine<RentalBillingSnapshot, RentalBillingHumanEvent>({
  id: 'billingReview',
  workflowName: RENTAL_BILLING_WORKFLOW_NAME,
  load: (runId) => fetchBillingRun(runId),
  submit: (runId, event, stateVersion) => dispatchBillingRunEvent(runId, event, stateVersion),
})

export const billingReviewMachine = machine

export type BillingReviewSnapshot = HeadlessWorkflowHookResult<RentalBillingSnapshot, RentalBillingHumanEvent>

export function useBillingReview(runId: string, companySlug: string): BillingReviewSnapshot {
  return useHook(runId, companySlug)
}
