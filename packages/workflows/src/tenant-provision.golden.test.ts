import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  TENANT_PROVISION_WORKFLOW_NAME,
  TENANT_PROVISION_WORKFLOW_SCHEMA_VERSION,
  nextTenantProvisionEvents,
  transitionTenantProvisionWorkflow,
  type TenantProvisionWorkflowEvent,
  type TenantProvisionWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = TENANT_PROVISION_WORKFLOW_NAME
const SCHEMA = TENANT_PROVISION_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-0000000000aa'

function logEntry(
  stateVersion: number,
  event: TenantProvisionWorkflowEvent,
  snapshotAfter: TenantProvisionWorkflowSnapshot,
): WorkflowEventLogEntry {
  return {
    workflow_name: NAME,
    schema_version: SCHEMA,
    entity_id: ENTITY,
    state_version: stateVersion,
    event_payload: event,
    snapshot_after: snapshotAfter as unknown as WorkflowEventLogEntry['snapshot_after'],
  }
}

describe('tenant-provision — nextEvents golden', () => {
  it('matches the affordance map per state', () => {
    const map = Object.fromEntries(
      (
        [
          'company_pending',
          'company_created',
          'seeding',
          'partially_seeded',
          'provisioned',
          'failed',
          'abandoned',
        ] as const
      ).map((s) => [s, nextTenantProvisionEvents(s).map((e) => e.type)]),
    )
    expect(map).toMatchInlineSnapshot(`
      {
        "abandoned": [],
        "company_created": [
          "INVITE_MEMBER",
          "SEED_REQUESTED",
          "SKIP_SEED",
          "ABANDON",
        ],
        "company_pending": [],
        "failed": [
          "CREATE_COMPANY",
          "ABANDON",
        ],
        "partially_seeded": [
          "SEED_REQUESTED",
          "FINISH",
          "ABANDON",
        ],
        "provisioned": [],
        "seeding": [],
      }
    `)
  })
})

describe('tenant-provision — applyEventLog replay', () => {
  it('happy path: pending → created → seeding → provisioned', () => {
    const s0: TenantProvisionWorkflowSnapshot = {
      state: 'company_pending',
      state_version: 1,
      slug: 'acme',
      name: 'ACME',
    }
    const created = { type: 'COMPANY_CREATED' as const, company_id: 'co-1' }
    const s1 = transitionTenantProvisionWorkflow(s0, created)
    const seedReq = { type: 'SEED_REQUESTED' as const, seed_request: { customer_name: 'Bob' } }
    const s2 = transitionTenantProvisionWorkflow(s1, seedReq)
    const seedDone = { type: 'SEED_COMPLETED' as const }
    const s3 = transitionTenantProvisionWorkflow(s2, seedDone)

    const log = [logEntry(1, created, s1), logEntry(2, seedReq, s2), logEntry(3, seedDone, s3)]
    const result = applyEventLog<TenantProvisionWorkflowSnapshot>(s0, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('provisioned')
    expect(result.finalSnapshot?.company_id).toBe('co-1')
  })

  it('partial-seed → retry → completed', () => {
    const s0: TenantProvisionWorkflowSnapshot = { state: 'company_created', state_version: 5, company_id: 'co-2' }
    const seedReq = { type: 'SEED_REQUESTED' as const, seed_request: { yard_name: 'Main' } }
    const s1 = transitionTenantProvisionWorkflow(s0, seedReq)
    const partial = { type: 'SEED_PARTIAL' as const, failed_seeds: ['customer', 'worker'] }
    const s2 = transitionTenantProvisionWorkflow(s1, partial)
    const retry = { type: 'SEED_REQUESTED' as const, seed_request: { yard_name: 'Main' } }
    const s3 = transitionTenantProvisionWorkflow(s2, retry)
    const done = { type: 'SEED_COMPLETED' as const }
    const s4 = transitionTenantProvisionWorkflow(s3, done)

    const log = [logEntry(5, seedReq, s1), logEntry(6, partial, s2), logEntry(7, retry, s3), logEntry(8, done, s4)]
    const result = applyEventLog<TenantProvisionWorkflowSnapshot>(s0, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('provisioned')
    expect(result.finalSnapshot?.failed_seeds).toEqual([])
  })

  it('company rejected with suggested slug → failed', () => {
    const s0: TenantProvisionWorkflowSnapshot = {
      state: 'company_pending',
      state_version: 1,
      slug: 'acme',
      name: 'ACME',
    }
    const rejected = { type: 'COMPANY_REJECTED' as const, error: 'slug taken', suggested_slug: 'acme-2' }
    const s1 = transitionTenantProvisionWorkflow(s0, rejected)
    const result = applyEventLog<TenantProvisionWorkflowSnapshot>(s0, [logEntry(1, rejected, s1)])
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('failed')
    expect(result.finalSnapshot?.suggested_slug).toBe('acme-2')
  })

  it('skip seed shortcuts company_created → provisioned', () => {
    const s0: TenantProvisionWorkflowSnapshot = { state: 'company_created', state_version: 2, company_id: 'co-3' }
    const skip = { type: 'SKIP_SEED' as const }
    const s1 = transitionTenantProvisionWorkflow(s0, skip)
    expect(s1.state).toBe('provisioned')
  })
})
