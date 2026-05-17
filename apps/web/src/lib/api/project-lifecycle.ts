/**
 * `project_lifecycle` workflow client. Backend reducer lives in
 * `packages/workflows/project-lifecycle.ts`; routes are in
 * `apps/api/src/routes/project-lifecycle.ts`. UI hook is in
 * `apps/web/src/machines/project-lifecycle.ts`.
 */
import type { ProjectLifecycleHumanEventType, ProjectLifecycleWorkflowState } from '@sitelayer/workflows'
import { request } from './client'

// Re-exported under the v2 names. Canonical union lives in
// @sitelayer/workflows so the reducer and the client agree.
export type ProjectLifecycleHumanEvent = ProjectLifecycleHumanEventType
export type ProjectLifecycleState = ProjectLifecycleWorkflowState

/**
 * Discriminated envelope sent through the headless workflow factory.
 * DECLINE carries an optional free-text reason that the reducer
 * persists onto `context.decline_reason`; every other event is just
 * the type tag. Modelling the reason on the event itself (rather than
 * a parallel side channel) lets us reuse the generic
 * `createHeadlessWorkflowMachine` factory — its `submit` signature is
 * `(entityId, event, stateVersion, companySlug)` and the event object
 * carries everything the dispatcher needs.
 */
export type ProjectLifecycleHumanEventEnvelope =
  | { type: 'DECLINE'; reason?: string }
  | { type: Exclude<ProjectLifecycleHumanEvent, 'DECLINE'> }

export interface ProjectLifecycleSnapshot {
  state: ProjectLifecycleState
  state_version: number
  context: {
    project_id: string
    name: string
    customer_name: string
    sent_at: string | null
    accepted_at: string | null
    declined_at: string | null
    decline_reason: string | null
    started_at: string | null
    completed_at: string | null
    archived_at: string | null
  }
  next_events: Array<{ type: ProjectLifecycleHumanEvent; label: string; disabled_reason?: string }>
}

export function fetchProjectLifecycle(projectId: string): Promise<ProjectLifecycleSnapshot> {
  return request<ProjectLifecycleSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/lifecycle`)
}

export function dispatchProjectLifecycleEvent(
  projectId: string,
  event: ProjectLifecycleHumanEventEnvelope,
  stateVersion: number,
): Promise<ProjectLifecycleSnapshot> {
  const reason = event.type === 'DECLINE' ? event.reason : undefined
  return request<ProjectLifecycleSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/lifecycle/events`, {
    method: 'POST',
    json: {
      event: event.type,
      state_version: stateVersion,
      ...(reason ? { reason } : {}),
    },
  })
}
