// Generic workflow types — see docs/DETERMINISTIC_WORKFLOWS.md.
//
// Every deterministic workflow exports its own State + Event + Snapshot
// types. This package holds the shared shape that ties them to a UI/API
// surface (next_events list, snapshot envelope) so screens never invent
// a separate vocabulary.

export type WorkflowNextEvent<EventType extends string> = {
  type: EventType
  label: string
  disabled_reason?: string
}

export type WorkflowSnapshot<State extends string, EventType extends string, Context> = {
  state: State
  state_version: number
  context: Context
  next_events: Array<WorkflowNextEvent<EventType>>
}

export {
  isHumanRentalBillingEvent,
  nextRentalBillingEvents,
  parseRentalBillingEventRequest,
  RentalBillingEventRequestSchema,
  transitionRentalBillingWorkflow,
  type RentalBillingEventParseResult,
  type RentalBillingEventRequest,
  type RentalBillingHumanEventType,
  type RentalBillingWorkflowEvent,
  type RentalBillingWorkflowSnapshot,
  type RentalBillingWorkflowState,
} from './rental-billing.js'
