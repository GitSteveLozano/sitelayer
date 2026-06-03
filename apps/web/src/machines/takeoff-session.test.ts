import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import {
  buildTakeoffSessionContext,
  canCommitDraft,
  createTakeoffSessionMachine,
  draftQuantity,
  isScaleReady,
  minPointsForTool,
  takeoffSessionSeedActor,
  TOOL_GEOMETRY_KIND,
  type TakeoffSessionDeps,
} from './takeoff-session'

// Flush the fromPromise microtask scheduler (6 turns — enough for an actor's
// invoke onDone chain, matching headless-workflow.test.ts).
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function makeDeps(overrides: Partial<TakeoffSessionDeps> = {}): TakeoffSessionDeps {
  return {
    loadSession: vi.fn(async ({ blueprintId, pageId, draftId }) => ({ blueprintId, pageId, draftId })),
    commitMeasurement: vi.fn(async () => ({ measurementId: 'm-1' })),
    calibratePage: vi.fn(async () => undefined),
    runCapture: vi.fn(async () => ({ result: { quantities: [{ id: 'q1', confidence: 0.4 }] } })),
    promoteCaptured: vi.fn(async () => undefined),
    ...overrides,
  }
}

const BASE_INPUT = { projectId: 'p-1', companySlug: 'acme', blueprintId: 'b-1', pageId: 'pg-1', draftId: 'd-1' }

function startMachine(deps = makeDeps()) {
  const machine = createTakeoffSessionMachine(deps)
  const actor = createActor(machine, { input: BASE_INPUT })
  actor.start()
  return { machine, actor, deps }
}

describe('takeoff-session: load → idle', () => {
  it('resolves the active blueprint/page/draft and lands in idle', async () => {
    const { actor, deps } = startMachine()
    expect(actor.getSnapshot().value).toBe('loading')
    await settle()
    expect(actor.getSnapshot().value).toBe('idle')
    expect(deps.loadSession).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().context.blueprintId).toBe('b-1')
  })

  it('surfaces a load error but still reaches idle (degraded, not stuck)', async () => {
    const deps = makeDeps({ loadSession: vi.fn(async () => { throw new Error('boom') }) })
    const { actor } = startMachine(deps)
    await settle()
    expect(actor.getSnapshot().value).toBe('idle')
    expect(actor.getSnapshot().context.error).toBe('boom')
  })
})

describe('takeoff-session: drawing', () => {
  it('places, undoes, redoes vertices and tracks the live quantity', async () => {
    const { actor } = startMachine()
    await settle()
    actor.send({ type: 'START_DRAW' })
    expect(actor.getSnapshot().value).toEqual({ drawing: 'placing' })

    actor.send({ type: 'PLACE_POINT', point: { x: 0, y: 0 } })
    actor.send({ type: 'PLACE_POINT', point: { x: 0, y: 10 } })
    actor.send({ type: 'PLACE_POINT', point: { x: 10, y: 10 } })
    expect(actor.getSnapshot().context.draft.points).toHaveLength(3)

    actor.send({ type: 'UNDO_POINT' })
    expect(actor.getSnapshot().context.draft.points).toHaveLength(2)
    expect(actor.getSnapshot().context.draft.redo).toHaveLength(1)
    actor.send({ type: 'REDO_POINT' })
    expect(actor.getSnapshot().context.draft.points).toHaveLength(3)
    expect(draftQuantity(actor.getSnapshot().context)).toBeGreaterThan(0)
  })

  it('blocks COMMIT until a scope + enough points exist, then persists and returns to idle', async () => {
    const { actor, deps } = startMachine()
    await settle()
    actor.send({ type: 'START_DRAW' })
    actor.send({ type: 'PLACE_POINT', point: { x: 0, y: 0 } })
    actor.send({ type: 'PLACE_POINT', point: { x: 0, y: 10 } })
    actor.send({ type: 'PLACE_POINT', point: { x: 10, y: 10 } })

    // No service item yet → COMMIT is a no-op (guard fails).
    actor.send({ type: 'COMMIT' })
    expect(actor.getSnapshot().value).toEqual({ drawing: 'placing' })
    expect(deps.commitMeasurement).not.toHaveBeenCalled()

    actor.send({ type: 'SET_SERVICE_ITEM', serviceItemCode: 'EPS' })
    actor.send({ type: 'COMMIT' })
    await settle()
    expect(deps.commitMeasurement).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().value).toBe('idle')
    // Draft cleared after commit.
    expect(actor.getSnapshot().context.draft.points).toHaveLength(0)
  })

  it('returns to placing with an error when the commit fails', async () => {
    const deps = makeDeps({ commitMeasurement: vi.fn(async () => { throw new Error('save failed') }) })
    const { actor } = startMachine(deps)
    await settle()
    const seeded = takeoffSessionSeedActor(createTakeoffSessionMachine(deps), {
      value: { drawing: 'placing' },
      context: { ...BASE_INPUT, draft: { tool: 'polygon', serviceItemCode: 'EPS', points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }] } },
    })
    seeded.start()
    seeded.send({ type: 'COMMIT' })
    await settle()
    expect(seeded.getSnapshot().value).toEqual({ drawing: 'placing' })
    expect(seeded.getSnapshot().context.error).toBe('save failed')
    void actor
  })

  it('SET_TOOL resets the in-progress draft (no stale dangling points)', async () => {
    const { actor } = startMachine()
    await settle()
    actor.send({ type: 'START_DRAW' })
    actor.send({ type: 'PLACE_POINT', point: { x: 1, y: 1 } })
    actor.send({ type: 'SET_TOOL', tool: 'lineal' })
    expect(actor.getSnapshot().context.draft.tool).toBe('lineal')
    expect(actor.getSnapshot().context.draft.points).toHaveLength(0)
  })
})

describe('takeoff-session: calibration', () => {
  it('requires two points + a positive length, then persists calibration', async () => {
    const { actor, deps } = startMachine()
    await settle()
    actor.send({ type: 'START_CALIBRATION' })
    expect(actor.getSnapshot().value).toEqual({ calibrating: 'placing' })

    actor.send({ type: 'PLACE_SCALE_POINT', point: { x: 10, y: 50 } })
    actor.send({ type: 'APPLY_CALIBRATION' }) // only 1 point + no length → blocked
    expect(actor.getSnapshot().value).toEqual({ calibrating: 'placing' })

    actor.send({ type: 'PLACE_SCALE_POINT', point: { x: 30, y: 50 } })
    actor.send({ type: 'SET_SCALE_LENGTH', lengthText: '24', unit: 'ft' })
    expect(isScaleReady(actor.getSnapshot().context)).toBe(true)
    actor.send({ type: 'APPLY_CALIBRATION' })
    await settle()
    expect(deps.calibratePage).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().value).toBe('idle')
  })

  it('a third scale point restarts the reference line', async () => {
    const { actor } = startMachine()
    await settle()
    actor.send({ type: 'START_CALIBRATION' })
    actor.send({ type: 'PLACE_SCALE_POINT', point: { x: 1, y: 1 } })
    actor.send({ type: 'PLACE_SCALE_POINT', point: { x: 2, y: 2 } })
    actor.send({ type: 'PLACE_SCALE_POINT', point: { x: 9, y: 9 } })
    expect(actor.getSnapshot().context.calibration.points).toEqual([{ x: 9, y: 9 }])
  })
})

describe('takeoff-session: select / edit', () => {
  it('selects, enters vertex-edit, drags a vertex, applies', async () => {
    const { actor } = startMachine()
    await settle()
    actor.send({ type: 'START_SELECT' })
    expect(actor.getSnapshot().value).toEqual({ selecting: 'browsing' })
    actor.send({ type: 'SELECT_MEASUREMENT', measurementId: 'm-9' })
    expect(actor.getSnapshot().context.selection.selectedId).toBe('m-9')

    actor.send({ type: 'START_EDIT_GEOM', measurementId: 'm-9', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] })
    expect(actor.getSnapshot().value).toEqual({ selecting: 'editingVertex' })
    actor.send({ type: 'DRAG_VERTEX', index: 1, point: { x: 8, y: 8 } })
    expect(actor.getSnapshot().context.selection.editPoints).toEqual([{ x: 0, y: 0 }, { x: 8, y: 8 }])
    actor.send({ type: 'APPLY_EDIT' })
    expect(actor.getSnapshot().value).toEqual({ selecting: 'browsing' })
    expect(actor.getSnapshot().context.selection.editGeomId).toBeNull()
  })
})

describe('takeoff-session: AI capture → review → promote', () => {
  it('runs a capture, lands in reviewing with a result, records decisions, promotes', async () => {
    const { actor, deps } = startMachine()
    await settle()
    actor.send({ type: 'START_CAPTURE', kind: 'blueprint_vision', mode: 'dry-run' })
    expect(actor.getSnapshot().value).toEqual({ capturing: 'configuring' })
    actor.send({ type: 'RUN_CAPTURE' })
    await settle()
    expect(deps.runCapture).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().value).toEqual({ capturing: 'reviewing' })
    expect(actor.getSnapshot().context.capture.result).not.toBeNull()

    actor.send({ type: 'REVIEW_DECISION', quantityId: 'q1', decision: 'accept' })
    expect(actor.getSnapshot().context.capture.decisions).toEqual({ q1: 'accept' })

    actor.send({ type: 'PROMOTE', quantityIds: ['q1'] })
    await settle()
    expect(deps.promoteCaptured).toHaveBeenCalledWith(expect.objectContaining({ quantityIds: ['q1'] }))
    expect(actor.getSnapshot().value).toBe('idle')
  })

  it('mode is an attribute, not a hardcoded dry-run assumption', async () => {
    const { actor, deps } = startMachine()
    await settle()
    actor.send({ type: 'START_CAPTURE', kind: 'blueprint_vision', mode: 'live' })
    actor.send({ type: 'RUN_CAPTURE' })
    await settle()
    expect(deps.runCapture).toHaveBeenCalledWith(expect.objectContaining({ mode: 'live' }))
  })
})

describe('takeoff-session: overlay single-open invariant', () => {
  it('opening a second overlay replaces the first (never two open)', async () => {
    const { actor } = startMachine()
    await settle()
    actor.send({ type: 'OPEN_OVERLAY', overlay: 'item_palette' })
    expect(actor.getSnapshot().context.overlay).toBe('item_palette')
    actor.send({ type: 'OPEN_OVERLAY', overlay: 'copy_panel' })
    expect(actor.getSnapshot().context.overlay).toBe('copy_panel')
    actor.send({ type: 'CLOSE_OVERLAY' })
    expect(actor.getSnapshot().context.overlay).toBeNull()
  })
})

describe('takeoff-session: seed/hydrate seam', () => {
  it('boots straight into mid-draw with points + scope already set (no clicks)', () => {
    const machine = createTakeoffSessionMachine(makeDeps())
    const actor = takeoffSessionSeedActor(machine, {
      value: { drawing: 'placing' },
      context: {
        ...BASE_INPUT,
        draft: { tool: 'polygon', serviceItemCode: 'EPS', points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }] },
      },
    })
    actor.start()
    expect(actor.getSnapshot().value).toEqual({ drawing: 'placing' })
    expect(actor.getSnapshot().context.draft.points).toHaveLength(3)
    expect(canCommitDraft(actor.getSnapshot().context)).toBe(true)
  })

  it('boots straight into AI review with a loaded result', () => {
    const machine = createTakeoffSessionMachine(makeDeps())
    const actor = takeoffSessionSeedActor(machine, {
      value: { capturing: 'reviewing' },
      context: { ...BASE_INPUT, capture: { kind: 'blueprint_vision', mode: 'live', result: { quantities: [] } } },
    })
    actor.start()
    expect(actor.getSnapshot().value).toEqual({ capturing: 'reviewing' })
    expect(actor.getSnapshot().context.capture.mode).toBe('live')
    // Promote affordance is live in this seeded state.
    expect(actor.getSnapshot().can({ type: 'PROMOTE', quantityIds: [] })).toBe(true)
  })

  it('seeds into a verified/calibrated idle state for quantity-path testing', () => {
    const machine = createTakeoffSessionMachine(makeDeps())
    const actor = takeoffSessionSeedActor(machine, {
      value: 'idle',
      context: { ...BASE_INPUT, calibration: { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }], lengthText: '24', unit: 'ft' } },
    })
    actor.start()
    expect(actor.getSnapshot().value).toBe('idle')
    expect(isScaleReady(actor.getSnapshot().context)).toBe(true)
  })
})

describe('takeoff-session: affordance golden map', () => {
  it('idle exposes exactly the four mode-entry affordances', () => {
    const machine = createTakeoffSessionMachine(makeDeps())
    const actor = takeoffSessionSeedActor(machine, { value: 'idle', context: BASE_INPUT })
    actor.start()
    const snap = actor.getSnapshot()
    expect(snap.can({ type: 'START_DRAW' })).toBe(true)
    expect(snap.can({ type: 'START_CALIBRATION' })).toBe(true)
    expect(snap.can({ type: 'START_SELECT' })).toBe(true)
    expect(snap.can({ type: 'START_CAPTURE', kind: 'blueprint_vision' })).toBe(true)
    // Drawing-only affordances are NOT available from idle.
    expect(snap.can({ type: 'PLACE_POINT', point: { x: 0, y: 0 } })).toBe(false)
    expect(snap.can({ type: 'COMMIT' })).toBe(false)
  })

  it('COMMIT affordance reflects the canCommit guard', () => {
    const machine = createTakeoffSessionMachine(makeDeps())
    const empty = takeoffSessionSeedActor(machine, { value: { drawing: 'placing' }, context: BASE_INPUT })
    empty.start()
    expect(empty.getSnapshot().can({ type: 'COMMIT' })).toBe(false)

    const ready = takeoffSessionSeedActor(machine, {
      value: { drawing: 'placing' },
      context: { ...BASE_INPUT, draft: { tool: 'polygon', serviceItemCode: 'EPS', points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }] } },
    })
    ready.start()
    expect(ready.getSnapshot().can({ type: 'COMMIT' })).toBe(true)
  })
})

describe('takeoff-session: pure helpers', () => {
  it('minPointsForTool matches the geometry kind', () => {
    expect(minPointsForTool('polygon')).toBe(3)
    expect(minPointsForTool('rect')).toBe(3)
    expect(minPointsForTool('lineal')).toBe(2)
    expect(minPointsForTool('count')).toBe(1)
    expect(TOOL_GEOMETRY_KIND.arc).toBe('lineal')
    expect(TOOL_GEOMETRY_KIND.rect).toBe('polygon')
  })

  it('buildTakeoffSessionContext fills defaults and merges overrides', () => {
    const ctx = buildTakeoffSessionContext({ projectId: 'p', companySlug: 'c', draft: { tool: 'count' } })
    expect(ctx.draft.tool).toBe('count')
    expect(ctx.draft.points).toEqual([])
    expect(ctx.viewport.zoom).toBe(1)
    expect(ctx.overlay).toBeNull()
  })
})
