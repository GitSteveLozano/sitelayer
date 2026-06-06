import { describe, it, expect } from 'vitest'
import {
  ASSET_DEPLOYMENT_ALL_STATES,
  ASSET_DEPLOYMENT_TERMINAL_STATES,
  assetDeploymentWorkflow,
  isHumanAssetDeploymentEvent,
  nextAssetDeploymentEvents,
  parseAssetDeploymentEventRequest,
  transitionAssetDeploymentWorkflow,
  type AssetDeploymentWorkflowSnapshot,
} from './asset-deployment.js'

describe('transitionAssetDeploymentWorkflow — happy path', () => {
  it('walks staged → out → overdue → out (extend) → returning → returned', () => {
    const staged: AssetDeploymentWorkflowSnapshot = { state: 'staged', state_version: 1 }
    const out = transitionAssetDeploymentWorkflow(staged, {
      type: 'DISPATCH',
      dispatched_at: '2026-04-15T08:00:00.000Z',
      project_id: 'proj-1',
      handoff_worker_id: 'worker-1',
      estimated_return_on: '2026-05-17',
      day_rate_cents: 8500,
      bill_mode: 'daily',
    })
    expect(out).toMatchObject({ state: 'out', state_version: 2, handoff_worker_id: 'worker-1' })

    const overdue = transitionAssetDeploymentWorkflow(out, {
      type: 'MARK_OVERDUE',
      overdue_since: '2026-05-18T00:00:00.000Z',
    })
    expect(overdue).toMatchObject({ state: 'overdue', state_version: 3, overdue_since: '2026-05-18T00:00:00.000Z' })

    const extended = transitionAssetDeploymentWorkflow(overdue, {
      type: 'EXTEND',
      estimated_return_on: '2026-05-31',
      extension_reason: 'job ran long',
    })
    expect(extended).toMatchObject({ state: 'out', state_version: 4, estimated_return_on: '2026-05-31' })
    expect(extended.overdue_since).toBeNull()

    const returning = transitionAssetDeploymentWorkflow(extended, {
      type: 'BEGIN_RETURN',
      return_started_at: '2026-05-30T16:00:00.000Z',
    })
    expect(returning).toMatchObject({ state: 'returning', state_version: 5 })

    const returned = transitionAssetDeploymentWorkflow(returning, {
      type: 'COMPLETE_RETURN',
      returned_at: '2026-05-31T09:00:00.000Z',
      returned_by: 'yard-user',
      condition_grade: 'good',
    })
    expect(returned).toMatchObject({ state: 'returned', state_version: 6, condition_grade: 'good' })
  })

  it('CONFIRM_HANDOFF is an idempotent re-stamp that stays out', () => {
    const out: AssetDeploymentWorkflowSnapshot = { state: 'out', state_version: 2 }
    const confirmed = transitionAssetDeploymentWorkflow(out, {
      type: 'CONFIRM_HANDOFF',
      handoff_confirmed_at: '2026-04-15T09:00:00.000Z',
      handoff_confirmed_by: 'worker-1',
    })
    expect(confirmed.state).toBe('out')
    expect(confirmed.handoff_confirmed_by).toBe('worker-1')
    expect(confirmed.state_version).toBe(3)
  })

  it('WRITE_OFF is reachable from out, overdue, and returning', () => {
    for (const state of ['out', 'overdue', 'returning'] as const) {
      const off = transitionAssetDeploymentWorkflow(
        { state, state_version: 2 },
        {
          type: 'WRITE_OFF',
          written_off_at: '2026-05-01T00:00:00.000Z',
          written_off_by: 'admin',
          write_off_reason: 'lost',
        },
      )
      expect(off.state).toBe('written_off')
      expect(off.write_off_reason).toBe('lost')
    }
  })

  it('rejects illegal transitions', () => {
    expect(() =>
      transitionAssetDeploymentWorkflow(
        { state: 'staged', state_version: 1 },
        { type: 'BEGIN_RETURN', return_started_at: 'x' },
      ),
    ).toThrow(/illegal transition/)
    expect(() =>
      transitionAssetDeploymentWorkflow(
        { state: 'returned', state_version: 6 },
        { type: 'EXTEND', estimated_return_on: '2026-06-01' },
      ),
    ).toThrow(/illegal transition/)
    // MARK_OVERDUE only from out (not overdue, not returning).
    expect(() =>
      transitionAssetDeploymentWorkflow(
        { state: 'overdue', state_version: 3 },
        { type: 'MARK_OVERDUE', overdue_since: 'x' },
      ),
    ).toThrow(/illegal transition/)
  })
})

describe('nextAssetDeploymentEvents', () => {
  it('returns only events the reducer accepts (and never MARK_OVERDUE)', () => {
    for (const state of ASSET_DEPLOYMENT_ALL_STATES) {
      const events = nextAssetDeploymentEvents(state)
      for (const next of events) {
        expect(next.type).not.toBe('MARK_OVERDUE')
      }
    }
  })

  it('terminal states have no next events', () => {
    for (const state of ASSET_DEPLOYMENT_TERMINAL_STATES) {
      expect(nextAssetDeploymentEvents(state)).toEqual([])
    }
  })
})

describe('isHumanAssetDeploymentEvent', () => {
  it('partitions human and worker events (MARK_OVERDUE is worker-only)', () => {
    expect(isHumanAssetDeploymentEvent('DISPATCH')).toBe(true)
    expect(isHumanAssetDeploymentEvent('CONFIRM_HANDOFF')).toBe(true)
    expect(isHumanAssetDeploymentEvent('EXTEND')).toBe(true)
    expect(isHumanAssetDeploymentEvent('BEGIN_RETURN')).toBe(true)
    expect(isHumanAssetDeploymentEvent('COMPLETE_RETURN')).toBe(true)
    expect(isHumanAssetDeploymentEvent('WRITE_OFF')).toBe(true)
    expect(isHumanAssetDeploymentEvent('MARK_OVERDUE')).toBe(false)
    expect(isHumanAssetDeploymentEvent('NOPE')).toBe(false)
  })
})

describe('parseAssetDeploymentEventRequest', () => {
  it('accepts well-formed human events', () => {
    expect(parseAssetDeploymentEventRequest({ event: 'DISPATCH', state_version: 1 }).ok).toBe(true)
    expect(
      parseAssetDeploymentEventRequest({ event: 'EXTEND', state_version: 2, estimated_return_on: '2026-06-01' }).ok,
    ).toBe(true)
  })
  it('rejects the worker-only MARK_OVERDUE event at the human endpoint', () => {
    expect(parseAssetDeploymentEventRequest({ event: 'MARK_OVERDUE', state_version: 1 }).ok).toBe(false)
  })
  it('coerces a string state_version', () => {
    const r = parseAssetDeploymentEventRequest({ event: 'DISPATCH', state_version: '3' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.state_version).toBe(3)
  })
})

describe('assetDeploymentWorkflow registry', () => {
  it('exposes reducer + metadata + side-effect type', () => {
    expect(assetDeploymentWorkflow.name).toBe('asset_deployment')
    expect(assetDeploymentWorkflow.initialState).toBe('staged')
    expect(assetDeploymentWorkflow.terminalStates).toEqual(['returned', 'written_off'])
    expect(assetDeploymentWorkflow.sideEffectTypes).toContain('notify_handoff_assignment')
  })
})
