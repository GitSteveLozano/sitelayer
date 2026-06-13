import { describe, it, expect } from 'vitest'
import {
  TENANT_PROVISION_TERMINAL_STATES,
  isHumanTenantProvisionEvent,
  nextTenantProvisionEvents,
  parseTenantProvisionEventRequest,
  tenantProvisionWorkflow,
  transitionTenantProvisionWorkflow,
  type TenantProvisionWorkflowSnapshot,
} from './tenant-provision.js'

const t = transitionTenantProvisionWorkflow

describe('transitionTenantProvisionWorkflow — happy path', () => {
  it('walks company_pending → (create) → company_created → seeding → provisioned', () => {
    const pending: TenantProvisionWorkflowSnapshot = { state: 'company_pending', state_version: 1 }

    // CREATE_COMPANY stamps slug/name but stays company_pending (the worker
    // create_company drain flips it to company_created via COMPANY_CREATED).
    const submitted = t(pending, { type: 'CREATE_COMPANY', slug: 'acme', name: 'Acme Stucco' })
    expect(submitted).toMatchObject({
      state: 'company_pending',
      state_version: 2,
      slug: 'acme',
      name: 'Acme Stucco',
      error: null,
    })

    const created = t(submitted, { type: 'COMPANY_CREATED', company_id: 'co-1' })
    expect(created).toMatchObject({ state: 'company_created', state_version: 3, company_id: 'co-1' })

    const invited = t(created, { type: 'INVITE_MEMBER', clerk_user_id: 'u-1', role: 'admin' })
    expect(invited).toMatchObject({ state: 'company_created', state_version: 4 })
    expect(invited.invited).toEqual([{ clerk_user_id: 'u-1', role: 'admin' }])

    // MEMBER_INVITED is the worker ack — version bumps, invite list unchanged.
    const ack = t(invited, { type: 'MEMBER_INVITED', clerk_user_id: 'u-1' })
    expect(ack).toMatchObject({ state: 'company_created', state_version: 5 })
    expect(ack.invited).toEqual(invited.invited)

    const seeding = t(ack, { type: 'SEED_REQUESTED', seed_request: { customer_name: 'Cavy' } })
    expect(seeding).toMatchObject({ state: 'seeding', state_version: 6, failed_seeds: [] })
    expect(seeding.seed_request).toEqual({ customer_name: 'Cavy' })

    const provisioned = t(seeding, { type: 'SEED_COMPLETED' })
    expect(provisioned).toMatchObject({ state: 'provisioned', state_version: 7, failed_seeds: [] })
  })

  it('SKIP_SEED short-circuits company_created → provisioned', () => {
    const created: TenantProvisionWorkflowSnapshot = { state: 'company_created', state_version: 3, company_id: 'co-1' }
    expect(t(created, { type: 'SKIP_SEED' })).toMatchObject({ state: 'provisioned', state_version: 4 })
  })
})

describe('transitionTenantProvisionWorkflow — branches', () => {
  it('SEED_PARTIAL → partially_seeded carries failed_seeds; FINISH completes it', () => {
    const seeding: TenantProvisionWorkflowSnapshot = { state: 'seeding', state_version: 6 }
    const partial = t(seeding, { type: 'SEED_PARTIAL', failed_seeds: ['yard', 'pricing'] })
    expect(partial).toMatchObject({ state: 'partially_seeded', state_version: 7, failed_seeds: ['yard', 'pricing'] })

    // Retry seeding OR finish anyway.
    expect(t(partial, { type: 'SEED_REQUESTED', seed_request: {} })).toMatchObject({
      state: 'seeding',
      failed_seeds: [],
    })
    expect(t(partial, { type: 'FINISH' })).toMatchObject({ state: 'provisioned', state_version: 8 })
  })

  it('COMPANY_REJECTED → failed records error + suggested_slug; CREATE_COMPANY retries from failed', () => {
    const pending: TenantProvisionWorkflowSnapshot = { state: 'company_pending', state_version: 2, slug: 'taken' }
    const failed = t(pending, { type: 'COMPANY_REJECTED', error: 'slug taken', suggested_slug: 'taken-2' })
    expect(failed).toMatchObject({ state: 'failed', state_version: 3, error: 'slug taken', suggested_slug: 'taken-2' })

    // Retry clears the error and goes back to company_pending.
    const retry = t(failed, { type: 'CREATE_COMPANY', slug: 'taken-2', name: 'Acme' })
    expect(retry).toMatchObject({
      state: 'company_pending',
      state_version: 4,
      slug: 'taken-2',
      error: null,
      suggested_slug: null,
    })
  })

  it('ABANDON is reachable from company_created, partially_seeded, and failed', () => {
    for (const state of ['company_created', 'partially_seeded', 'failed'] as const) {
      const snap: TenantProvisionWorkflowSnapshot = { state, state_version: 5 }
      expect(t(snap, { type: 'ABANDON' })).toMatchObject({ state: 'abandoned', state_version: 6 })
    }
  })
})

describe('transitionTenantProvisionWorkflow — guards', () => {
  it('rejects illegal transitions', () => {
    const created: TenantProvisionWorkflowSnapshot = { state: 'company_created', state_version: 3 }
    // SEED_COMPLETED is only legal from seeding; FINISH only from partially_seeded.
    expect(() => t(created, { type: 'SEED_COMPLETED' })).toThrow(/illegal transition/)
    expect(() => t(created, { type: 'FINISH' })).toThrow(/illegal transition/)
    // CREATE_COMPANY is only legal from company_pending | failed.
    expect(() => t(created, { type: 'CREATE_COMPANY', slug: 'x', name: 'X' })).toThrow(/illegal transition/)
  })

  it('terminal states reject every event', () => {
    for (const state of TENANT_PROVISION_TERMINAL_STATES) {
      const snap: TenantProvisionWorkflowSnapshot = { state, state_version: 9 }
      expect(() => t(snap, { type: 'ABANDON' })).toThrow(/illegal transition/)
      expect(() => t(snap, { type: 'CREATE_COMPANY', slug: 'x', name: 'X' })).toThrow(/illegal transition/)
    }
  })
})

describe('nextTenantProvisionEvents', () => {
  it('offers the company_created actions and nothing from terminal/awaiting states', () => {
    expect(nextTenantProvisionEvents('company_created').map((e) => e.type)).toEqual([
      'INVITE_MEMBER',
      'SEED_REQUESTED',
      'SKIP_SEED',
      'ABANDON',
    ])
    // Awaiting-a-worker-drain and terminal states surface no human actions.
    for (const state of ['company_pending', 'seeding', 'provisioned', 'abandoned'] as const) {
      expect(nextTenantProvisionEvents(state)).toEqual([])
    }
  })
})

describe('isHumanTenantProvisionEvent', () => {
  it('partitions human and worker-only events', () => {
    expect(isHumanTenantProvisionEvent('CREATE_COMPANY')).toBe(true)
    expect(isHumanTenantProvisionEvent('SKIP_SEED')).toBe(true)
    // Worker-only outcomes are not dispatchable by a human.
    expect(isHumanTenantProvisionEvent('COMPANY_CREATED')).toBe(false)
    expect(isHumanTenantProvisionEvent('SEED_COMPLETED')).toBe(false)
  })
})

describe('parseTenantProvisionEventRequest', () => {
  it('accepts a well-formed human event and coerces a string state_version', () => {
    const parsed = parseTenantProvisionEventRequest({ event: 'SKIP_SEED', state_version: '4' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toMatchObject({ event: 'SKIP_SEED', state_version: 4 })
  })

  it('rejects a worker-only event at the human endpoint', () => {
    const parsed = parseTenantProvisionEventRequest({ event: 'COMPANY_CREATED', state_version: 3 })
    expect(parsed.ok).toBe(false)
  })
})

describe('tenantProvisionWorkflow registry', () => {
  it('exposes reducer + metadata + initial state', () => {
    expect(tenantProvisionWorkflow.name).toBe('tenant_provision')
    expect(tenantProvisionWorkflow.initialState).toBe('company_pending')
    expect(tenantProvisionWorkflow.reduce).toBe(transitionTenantProvisionWorkflow)
    expect([...tenantProvisionWorkflow.terminalStates].sort()).toEqual(['abandoned', 'provisioned'])
  })
})
