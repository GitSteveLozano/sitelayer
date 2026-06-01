import { z } from 'zod'
import type { WorkflowNextEvent } from './index.js'
import { registerWorkflow } from './registry.js'

/**
 * Tenant provision workflow.
 *
 * Lifts the most consequential multi-step external write in the product
 * — new-tenant bootstrap (company create → admin membership → seed
 * defaults) — out of the onboarding screen's hand-rolled
 * `Promise.allSettled` and into a registered deterministic workflow so
 * the provision is replayable and partial-seed failure recovery is
 * modeled rather than a copy string in the React component.
 *
 * The reducer owns the business state; all side-effects (the actual
 * company/membership/seed creates) are emitted into `mutation_outbox`
 * with per-provision idempotency keys and applied by worker drains,
 * which emit the worker-only result events back through this reducer.
 *
 *   company_pending   — form submitted; `create_company` enqueued
 *   company_created   — company + admin membership exist; on team/seed
 *   seeding           — `seed_tenant_defaults` enqueued; worker draining
 *   partially_seeded  — ≥1 seed insert failed; carries failedSeeds[]
 *   provisioned       — terminal success
 *   failed            — terminal-recoverable company-create failure
 *                       (carries error + suggestedSlug)
 *   abandoned         — terminal; user skipped to home
 *
 * Human vs worker events: CREATE_COMPANY / INVITE_MEMBER /
 * SEED_REQUESTED / SKIP_SEED / FINISH / ABANDON are human (dispatchable
 * at the POST .../events route). COMPANY_CREATED / COMPANY_REJECTED /
 * MEMBER_INVITED / SEED_COMPLETED / SEED_PARTIAL are worker-only and are
 * rejected at the human endpoint.
 *
 * Side effects (outbox commands, per-provision idempotency keys):
 *   - create_company        → tenant_provision:create_company:<id>
 *   - invite_member         → tenant_provision:invite_member:<id>:<clerkUserId>
 *   - seed_tenant_defaults  → tenant_provision:seed:<id>
 */

export type TenantProvisionWorkflowState =
  | 'company_pending'
  | 'company_created'
  | 'seeding'
  | 'partially_seeded'
  | 'provisioned'
  | 'failed'
  | 'abandoned'

export const TENANT_PROVISION_WORKFLOW_NAME = 'tenant_provision'
export const TENANT_PROVISION_WORKFLOW_SCHEMA_VERSION = 1

export const TENANT_PROVISION_ALL_STATES: readonly TenantProvisionWorkflowState[] = [
  'company_pending',
  'company_created',
  'seeding',
  'partially_seeded',
  'provisioned',
  'failed',
  'abandoned',
]

export const TENANT_PROVISION_TERMINAL_STATES: readonly TenantProvisionWorkflowState[] = ['provisioned', 'abandoned']

export const TENANT_PROVISION_EVENT_TYPES = [
  'CREATE_COMPANY',
  'COMPANY_CREATED',
  'COMPANY_REJECTED',
  'INVITE_MEMBER',
  'MEMBER_INVITED',
  'SEED_REQUESTED',
  'SEED_COMPLETED',
  'SEED_PARTIAL',
  'SKIP_SEED',
  'FINISH',
  'ABANDON',
] as const

/** Events a human may dispatch at the POST .../events endpoint. */
export const TENANT_PROVISION_HUMAN_EVENT_TYPES = [
  'CREATE_COMPANY',
  'INVITE_MEMBER',
  'SEED_REQUESTED',
  'SKIP_SEED',
  'FINISH',
  'ABANDON',
] as const

export type TenantProvisionHumanEventType = (typeof TENANT_PROVISION_HUMAN_EVENT_TYPES)[number]

export interface TenantProvisionInvite {
  clerk_user_id: string
  role: string
}

export interface TenantProvisionSeedRequest {
  customer_name?: string | null
  worker_name?: string | null
  yard_name?: string | null
}

export type TenantProvisionWorkflowEvent =
  // human
  | { type: 'CREATE_COMPANY'; slug: string; name: string }
  | { type: 'INVITE_MEMBER'; clerk_user_id: string; role: string }
  | { type: 'SEED_REQUESTED'; seed_request: TenantProvisionSeedRequest }
  | { type: 'SKIP_SEED' }
  | { type: 'FINISH' }
  | { type: 'ABANDON' }
  // worker-only
  | { type: 'COMPANY_CREATED'; company_id: string }
  | { type: 'COMPANY_REJECTED'; error: string; suggested_slug?: string | null }
  | { type: 'MEMBER_INVITED'; clerk_user_id: string }
  | { type: 'SEED_COMPLETED' }
  | { type: 'SEED_PARTIAL'; failed_seeds: string[] }

export interface TenantProvisionWorkflowSnapshot {
  state: TenantProvisionWorkflowState
  state_version: number
  company_id?: string | null
  slug?: string | null
  name?: string | null
  invited?: TenantProvisionInvite[]
  seed_request?: TenantProvisionSeedRequest | null
  failed_seeds?: string[]
  error?: string | null
  suggested_slug?: string | null
}

function assertTransition(
  state: TenantProvisionWorkflowState,
  allowed: readonly TenantProvisionWorkflowState[],
  eventType: string,
): void {
  if (!allowed.includes(state)) {
    throw new Error(`tenant_provision: illegal transition from ${state} on ${eventType}`)
  }
}

export function transitionTenantProvisionWorkflow(
  snapshot: TenantProvisionWorkflowSnapshot,
  event: TenantProvisionWorkflowEvent,
): TenantProvisionWorkflowSnapshot {
  const nextVersion = snapshot.state_version + 1
  switch (event.type) {
    case 'CREATE_COMPANY':
      // Initial submit OR retry from `failed`. Both land in
      // company_pending with the (possibly corrected) slug/name, and the
      // route enqueues `create_company`.
      assertTransition(snapshot.state, ['company_pending', 'failed'], event.type)
      return {
        ...snapshot,
        state: 'company_pending',
        state_version: nextVersion,
        slug: event.slug,
        name: event.name,
        error: null,
        suggested_slug: null,
      }
    case 'COMPANY_CREATED':
      assertTransition(snapshot.state, ['company_pending'], event.type)
      return {
        ...snapshot,
        state: 'company_created',
        state_version: nextVersion,
        company_id: event.company_id,
        error: null,
        suggested_slug: null,
      }
    case 'COMPANY_REJECTED':
      assertTransition(snapshot.state, ['company_pending'], event.type)
      return {
        ...snapshot,
        state: 'failed',
        state_version: nextVersion,
        error: event.error,
        suggested_slug: event.suggested_slug ?? null,
      }
    case 'INVITE_MEMBER':
      assertTransition(snapshot.state, ['company_created'], event.type)
      return {
        ...snapshot,
        state: 'company_created',
        state_version: nextVersion,
        invited: [...(snapshot.invited ?? []), { clerk_user_id: event.clerk_user_id, role: event.role }],
      }
    case 'MEMBER_INVITED':
      // Worker confirmation of an invite_member side effect; no state
      // change beyond version bump (the invite is already recorded).
      assertTransition(snapshot.state, ['company_created'], event.type)
      return { ...snapshot, state_version: nextVersion }
    case 'SEED_REQUESTED':
      // From company_created (first seed) or partially_seeded (retry).
      assertTransition(snapshot.state, ['company_created', 'partially_seeded'], event.type)
      return {
        ...snapshot,
        state: 'seeding',
        state_version: nextVersion,
        seed_request: event.seed_request,
        failed_seeds: [],
      }
    case 'SEED_COMPLETED':
      assertTransition(snapshot.state, ['seeding'], event.type)
      return { ...snapshot, state: 'provisioned', state_version: nextVersion, failed_seeds: [] }
    case 'SEED_PARTIAL':
      assertTransition(snapshot.state, ['seeding'], event.type)
      return { ...snapshot, state: 'partially_seeded', state_version: nextVersion, failed_seeds: event.failed_seeds }
    case 'SKIP_SEED':
      assertTransition(snapshot.state, ['company_created'], event.type)
      return { ...snapshot, state: 'provisioned', state_version: nextVersion }
    case 'FINISH':
      assertTransition(snapshot.state, ['partially_seeded'], event.type)
      return { ...snapshot, state: 'provisioned', state_version: nextVersion }
    case 'ABANDON':
      assertTransition(snapshot.state, ['company_created', 'partially_seeded', 'failed'], event.type)
      return { ...snapshot, state: 'abandoned', state_version: nextVersion }
    default: {
      const exhaustive: never = event
      throw new Error(`unhandled tenant_provision event ${JSON.stringify(exhaustive)}`)
    }
  }
}

export function nextTenantProvisionEvents(
  state: TenantProvisionWorkflowState,
): Array<WorkflowNextEvent<TenantProvisionHumanEventType>> {
  switch (state) {
    case 'company_pending':
      return [] // waiting on the create_company worker drain
    case 'company_created':
      return [
        { type: 'INVITE_MEMBER', label: 'Invite teammate' },
        { type: 'SEED_REQUESTED', label: 'Seed starter data' },
        { type: 'SKIP_SEED', label: 'Skip seeding' },
        { type: 'ABANDON', label: 'Finish later' },
      ]
    case 'partially_seeded':
      return [
        { type: 'SEED_REQUESTED', label: 'Retry seeding' },
        { type: 'FINISH', label: 'Finish anyway' },
        { type: 'ABANDON', label: 'Finish later' },
      ]
    case 'failed':
      return [
        { type: 'CREATE_COMPANY', label: 'Try again' },
        { type: 'ABANDON', label: 'Finish later' },
      ]
    case 'seeding':
      return [] // waiting on the seed_tenant_defaults worker drain
    case 'provisioned':
    case 'abandoned':
      return []
  }
}

export function isHumanTenantProvisionEvent(eventType: string): eventType is TenantProvisionHumanEventType {
  return (TENANT_PROVISION_HUMAN_EVENT_TYPES as readonly string[]).includes(eventType)
}

export const tenantProvisionWorkflow = registerWorkflow<
  TenantProvisionWorkflowState,
  TenantProvisionWorkflowEvent,
  TenantProvisionHumanEventType,
  TenantProvisionWorkflowSnapshot
>({
  name: TENANT_PROVISION_WORKFLOW_NAME,
  schemaVersion: TENANT_PROVISION_WORKFLOW_SCHEMA_VERSION,
  initialState: 'company_pending',
  terminalStates: TENANT_PROVISION_TERMINAL_STATES,
  allStates: TENANT_PROVISION_ALL_STATES,
  allEventTypes: TENANT_PROVISION_EVENT_TYPES,
  reduce: transitionTenantProvisionWorkflow,
  nextEvents: nextTenantProvisionEvents,
  isHumanEvent: isHumanTenantProvisionEvent,
  sideEffectTypes: ['create_company', 'invite_member', 'seed_tenant_defaults'] as const,
})

const SeedRequestSchema = z
  .object({
    customer_name: z.string().max(200).optional().nullable(),
    worker_name: z.string().max(200).optional().nullable(),
    yard_name: z.string().max(200).optional().nullable(),
  })
  .strict()

export const TenantProvisionEventRequestSchema = z.object({
  event: z.enum(TENANT_PROVISION_HUMAN_EVENT_TYPES),
  state_version: z.number().int().positive(),
  // CREATE_COMPANY
  slug: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(200).optional(),
  // INVITE_MEMBER
  clerk_user_id: z.string().min(1).max(200).optional(),
  role: z.string().min(1).max(64).optional(),
  // SEED_REQUESTED
  seed_request: SeedRequestSchema.optional(),
})

export type TenantProvisionEventRequest = z.infer<typeof TenantProvisionEventRequestSchema>
export type TenantProvisionEventParseResult =
  | { ok: true; value: TenantProvisionEventRequest }
  | { ok: false; error: string }

export function parseTenantProvisionEventRequest(body: unknown): TenantProvisionEventParseResult {
  const normalized: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  if (typeof normalized.state_version === 'string') {
    const numeric = Number(normalized.state_version)
    if (Number.isFinite(numeric)) normalized.state_version = numeric
  }
  const result = TenantProvisionEventRequestSchema.safeParse(normalized)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
