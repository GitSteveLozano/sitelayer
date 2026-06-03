import { describe, expect, it } from 'vitest'
import { canCommitDraft, createTakeoffSessionMachine, isScaleReady } from './takeoff-session'
import {
  resolveTakeoffSeed,
  seedTakeoffSessionActor,
  TAKEOFF_SEED_NAMES,
  type TakeoffSeedBase,
} from './takeoff-session-seeds'

const BASE: TakeoffSeedBase = {
  projectId: 'p-1',
  companySlug: 'acme',
  blueprintId: 'b-1',
  pageId: 'pg-1',
  draftId: 'd-1',
}

function boot(name: string) {
  const machine = createTakeoffSessionMachine()
  const actor = seedTakeoffSessionActor(machine, name, BASE)!
  actor.start()
  return actor
}

describe('takeoff-session seed catalog', () => {
  it('every catalog name resolves and grafts the base ids', () => {
    for (const name of TAKEOFF_SEED_NAMES) {
      const seed = resolveTakeoffSeed(name, BASE)
      expect(seed, name).not.toBeNull()
      expect(seed!.context.projectId).toBe('p-1')
      expect(seed!.context.blueprintId).toBe('b-1')
    }
  })

  it('unknown seed name returns null (and a null actor)', () => {
    expect(resolveTakeoffSeed('nope', BASE)).toBeNull()
    expect(seedTakeoffSessionActor(createTakeoffSessionMachine(), 'nope', BASE)).toBeNull()
  })

  it('boots each seed into the expected state value', () => {
    expect(boot('empty').getSnapshot().value).toBe('idle')
    expect(boot('drawing-empty').getSnapshot().value).toEqual({ drawing: 'placing' })
    expect(boot('drawing-polygon').getSnapshot().value).toEqual({ drawing: 'placing' })
    expect(boot('calibrating').getSnapshot().value).toEqual({ calibrating: 'placing' })
    expect(boot('calibrating-ready').getSnapshot().value).toEqual({ calibrating: 'placing' })
    expect(boot('selecting').getSnapshot().value).toEqual({ selecting: 'browsing' })
    expect(boot('editing-vertex').getSnapshot().value).toEqual({ selecting: 'editingVertex' })
    expect(boot('ai-configuring').getSnapshot().value).toEqual({ capturing: 'configuring' })
    expect(boot('ai-reviewing').getSnapshot().value).toEqual({ capturing: 'reviewing' })
  })

  it('drawing-polygon is commit-ready; drawing-empty is not', () => {
    expect(canCommitDraft(boot('drawing-polygon').getSnapshot().context)).toBe(true)
    expect(canCommitDraft(boot('drawing-empty').getSnapshot().context)).toBe(false)
  })

  it('calibrating-ready satisfies the scale guard; calibrating does not', () => {
    expect(isScaleReady(boot('calibrating-ready').getSnapshot().context)).toBe(true)
    expect(isScaleReady(boot('calibrating').getSnapshot().context)).toBe(false)
  })

  it('ai-reviewing exposes PROMOTE and carries loaded proposals', () => {
    const snap = boot('ai-reviewing').getSnapshot()
    expect(snap.can({ type: 'PROMOTE', quantityIds: [] })).toBe(true)
    expect(snap.context.capture.mode).toBe('live')
    expect(snap.context.capture.result).not.toBeNull()
  })
})
