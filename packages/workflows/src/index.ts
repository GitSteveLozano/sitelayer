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
  RENTAL_BILLING_ALL_STATES,
  RENTAL_BILLING_EVENT_TYPES,
  RENTAL_BILLING_TERMINAL_STATES,
  RENTAL_BILLING_WORKFLOW_NAME,
  RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
  rentalBillingWorkflow,
  transitionRentalBillingWorkflow,
  type RentalBillingEventParseResult,
  type RentalBillingEventRequest,
  type RentalBillingHumanEventType,
  type RentalBillingWorkflowEvent,
  type RentalBillingWorkflowSnapshot,
  type RentalBillingWorkflowState,
} from './rental-billing.js'

export {
  __resetWorkflowRegistryForTests,
  getWorkflow,
  listWorkflows,
  registerWorkflow,
  type WorkflowDefinition,
} from './registry.js'

export { applyEventLog, type WorkflowEventLogEntry, type ReplayResult } from './replay.js'

export {
  CREW_SCHEDULE_ALL_STATES,
  CREW_SCHEDULE_EVENT_TYPES,
  CREW_SCHEDULE_TERMINAL_STATES,
  CREW_SCHEDULE_WORKFLOW_NAME,
  CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
  CrewScheduleEventRequestSchema,
  crewScheduleWorkflow,
  isHumanCrewScheduleEvent,
  nextCrewScheduleEvents,
  parseCrewScheduleEventRequest,
  transitionCrewScheduleWorkflow,
  type CrewScheduleEventParseResult,
  type CrewScheduleEventRequest,
  type CrewScheduleHumanEventType,
  type CrewScheduleWorkflowEvent,
  type CrewScheduleWorkflowSnapshot,
  type CrewScheduleWorkflowState,
} from './crew-schedule.js'

export {
  PROJECT_CLOSEOUT_ALL_STATES,
  PROJECT_CLOSEOUT_EVENT_TYPES,
  PROJECT_CLOSEOUT_TERMINAL_STATES,
  PROJECT_CLOSEOUT_WORKFLOW_NAME,
  PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION,
  ProjectCloseoutEventRequestSchema,
  projectCloseoutWorkflow,
  isHumanProjectCloseoutEvent,
  nextProjectCloseoutEvents,
  parseProjectCloseoutEventRequest,
  projectStatusToCloseoutState,
  transitionProjectCloseoutWorkflow,
  type ProjectCloseoutEventParseResult,
  type ProjectCloseoutEventRequest,
  type ProjectCloseoutHumanEventType,
  type ProjectCloseoutWorkflowEvent,
  type ProjectCloseoutWorkflowSnapshot,
  type ProjectCloseoutWorkflowState,
} from './project-closeout.js'

export {
  RENTAL_ALL_STATES,
  RENTAL_EVENT_TYPES,
  RENTAL_TERMINAL_STATES,
  RENTAL_WORKFLOW_NAME,
  RENTAL_WORKFLOW_SCHEMA_VERSION,
  RentalEventRequestSchema,
  rentalWorkflow,
  isHumanRentalEvent,
  nextRentalEvents,
  parseRentalEventRequest,
  transitionRentalWorkflow,
  type RentalEventParseResult,
  type RentalEventRequest,
  type RentalHumanEventType,
  type RentalWorkflowEvent,
  type RentalWorkflowSnapshot,
  type RentalWorkflowState,
} from './rental.js'

export {
  ESTIMATE_PUSH_ALL_STATES,
  ESTIMATE_PUSH_EVENT_TYPES,
  ESTIMATE_PUSH_TERMINAL_STATES,
  ESTIMATE_PUSH_WORKFLOW_NAME,
  ESTIMATE_PUSH_WORKFLOW_SCHEMA_VERSION,
  EstimatePushEventRequestSchema,
  estimatePushWorkflow,
  isHumanEstimatePushEvent,
  nextEstimatePushEvents,
  parseEstimatePushEventRequest,
  transitionEstimatePushWorkflow,
  type EstimatePushEventParseResult,
  type EstimatePushEventRequest,
  type EstimatePushHumanEventType,
  type EstimatePushWorkflowEvent,
  type EstimatePushWorkflowSnapshot,
  type EstimatePushWorkflowState,
} from './estimate-push.js'
