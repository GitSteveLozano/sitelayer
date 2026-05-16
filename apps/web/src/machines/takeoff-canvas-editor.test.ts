import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { takeoffCanvasEditorMachine, TAKEOFF_TOOL_MIN_POINTS } from './takeoff-canvas-editor.js'

function newActor(input: { maxPolygonPoints?: number; initialElevation?: 'none' | 'east' } = {}) {
  const actor = createActor(takeoffCanvasEditorMachine, { input })
  actor.start()
  return actor
}

describe('takeoffCanvasEditorMachine', () => {
  describe('initial state', () => {
    it('starts in idle with no tool, no points, default elevation', () => {
      const actor = newActor()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.tool).toBeNull()
      expect(snap.context.draftPoints).toEqual([])
      expect(snap.context.elevation).toBe('none')
      expect(snap.context.commitSerial).toBe(0)
      expect(snap.context.maxPolygonPoints).toBe(64)
    })

    it('respects input overrides for maxPolygonPoints + initialElevation', () => {
      const actor = newActor({ maxPolygonPoints: 8, initialElevation: 'east' })
      const snap = actor.getSnapshot()
      expect(snap.context.maxPolygonPoints).toBe(8)
      expect(snap.context.elevation).toBe('east')
    })
  })

  describe('tool selection from idle', () => {
    it('SELECT_TOOL polygon transitions to polygon_drawing', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('polygon_drawing')
      expect(snap.context.tool).toBe('polygon')
    })

    it('SELECT_TOOL lineal transitions to lineal_drawing', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'lineal' })
      expect(actor.getSnapshot().value).toBe('lineal_drawing')
    })

    it('SELECT_TOOL count transitions to count_active', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'count' })
      expect(actor.getSnapshot().value).toBe('count_active')
    })
  })

  describe('polygon drawing', () => {
    it('ADD_POINT appends to draft buffer', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 1, y: 1 } })
      actor.send({ type: 'ADD_POINT', point: { x: 2, y: 2 } })
      expect(actor.getSnapshot().context.draftPoints).toEqual([
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ])
    })

    it('respects maxPolygonPoints cap', () => {
      const actor = newActor({ maxPolygonPoints: 2 })
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'ADD_POINT', point: { x: 1, y: 1 } })
      actor.send({ type: 'ADD_POINT', point: { x: 2, y: 2 } }) // should be ignored
      expect(actor.getSnapshot().context.draftPoints.length).toBe(2)
    })

    it('COMMIT below minimum (3 points) is rejected', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'ADD_POINT', point: { x: 1, y: 1 } })
      actor.send({ type: 'COMMIT' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('polygon_drawing')
      expect(snap.context.commitSerial).toBe(0)
    })

    it('COMMIT with >=3 points returns to idle, clears draft, bumps serial', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'ADD_POINT', point: { x: 1, y: 1 } })
      actor.send({ type: 'ADD_POINT', point: { x: 2, y: 0 } })
      actor.send({ type: 'COMMIT' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.draftPoints).toEqual([])
      expect(snap.context.tool).toBeNull()
      expect(snap.context.commitSerial).toBe(1)
    })

    it('UNDO_POINT pops the most recent point', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'ADD_POINT', point: { x: 1, y: 1 } })
      actor.send({ type: 'UNDO_POINT' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('polygon_drawing')
      expect(snap.context.draftPoints).toEqual([{ x: 0, y: 0 }])
    })

    it('UNDO_POINT on empty buffer leaves draft empty', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'UNDO_POINT' })
      expect(actor.getSnapshot().context.draftPoints).toEqual([])
    })

    it('CLEAR_DRAFT empties the buffer but stays in the drawing state', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'ADD_POINT', point: { x: 1, y: 1 } })
      actor.send({ type: 'CLEAR_DRAFT' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('polygon_drawing')
      expect(snap.context.draftPoints).toEqual([])
    })

    it('CANCEL clears draft and returns to idle', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'CANCEL' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.draftPoints).toEqual([])
      expect(snap.context.commitSerial).toBe(0)
    })
  })

  describe('lineal drawing', () => {
    it('COMMIT requires at least 2 points', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'lineal' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'COMMIT' }) // not enough
      expect(actor.getSnapshot().value).toBe('lineal_drawing')
      actor.send({ type: 'ADD_POINT', point: { x: 10, y: 10 } })
      actor.send({ type: 'COMMIT' })
      expect(actor.getSnapshot().value).toBe('idle')
      expect(actor.getSnapshot().context.commitSerial).toBe(1)
    })
  })

  describe('count active', () => {
    it('COMMIT requires at least 1 point', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'count' })
      actor.send({ type: 'COMMIT' }) // zero points
      expect(actor.getSnapshot().value).toBe('count_active')
      actor.send({ type: 'ADD_POINT', point: { x: 5, y: 5 } })
      actor.send({ type: 'COMMIT' })
      expect(actor.getSnapshot().value).toBe('idle')
    })
  })

  describe('tool switching guards', () => {
    it("can't SELECT a different tool mid-polygon with points buffered", () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'ADD_POINT', point: { x: 1, y: 1 } })
      // Switching tool should be guarded — operator must COMMIT/CANCEL first.
      actor.send({ type: 'SELECT_TOOL', tool: 'lineal' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('polygon_drawing')
      expect(snap.context.tool).toBe('polygon')
      expect(snap.context.draftPoints.length).toBe(2)
    })

    it('can SELECT_TOOL once draft buffer is empty (after CANCEL)', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'CANCEL' })
      actor.send({ type: 'SELECT_TOOL', tool: 'lineal' })
      expect(actor.getSnapshot().value).toBe('lineal_drawing')
    })

    it('SELECT_TOOL to same tool while drawing is a no-op (not a draft clear)', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      expect(actor.getSnapshot().context.draftPoints.length).toBe(1)
    })
  })

  describe('calibration', () => {
    it('OPEN_CALIBRATION from idle transitions to calibrating with empty point buffer', () => {
      const actor = newActor()
      actor.send({ type: 'OPEN_CALIBRATION' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('calibrating')
      expect(snap.context.calibration).toEqual({ points: [] })
    })

    it('SET_CALIBRATION_POINT appends up to 2 points; further sets replace the second', () => {
      const actor = newActor()
      actor.send({ type: 'OPEN_CALIBRATION' })
      actor.send({ type: 'SET_CALIBRATION_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'SET_CALIBRATION_POINT', point: { x: 100, y: 100 } })
      expect(actor.getSnapshot().context.calibration?.points.length).toBe(2)
      // Third tap should replace second corner — operators re-tap to fix drift.
      actor.send({ type: 'SET_CALIBRATION_POINT', point: { x: 90, y: 90 } })
      const snap = actor.getSnapshot()
      expect(snap.context.calibration?.points.length).toBe(2)
      expect(snap.context.calibration?.points[1]).toEqual({ x: 90, y: 90 })
    })

    it('COMMIT_CALIBRATION requires exactly two points', () => {
      const actor = newActor()
      actor.send({ type: 'OPEN_CALIBRATION' })
      actor.send({ type: 'SET_CALIBRATION_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'COMMIT_CALIBRATION' }) // only 1 point — rejected
      expect(actor.getSnapshot().value).toBe('calibrating')
      actor.send({ type: 'SET_CALIBRATION_POINT', point: { x: 100, y: 100 } })
      actor.send({ type: 'COMMIT_CALIBRATION' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.calibration).toBeNull()
      expect(snap.context.commitSerial).toBe(1)
    })

    it('CANCEL from calibrating clears the in-progress calibration', () => {
      const actor = newActor()
      actor.send({ type: 'OPEN_CALIBRATION' })
      actor.send({ type: 'SET_CALIBRATION_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'CANCEL' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.calibration).toBeNull()
    })

    it('OPEN_CALIBRATION mid-drawing is guarded when draft is non-empty', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'ADD_POINT', point: { x: 0, y: 0 } })
      actor.send({ type: 'OPEN_CALIBRATION' })
      expect(actor.getSnapshot().value).toBe('polygon_drawing')
    })

    it('OPEN_CALIBRATION mid-drawing is allowed when draft is empty', () => {
      const actor = newActor()
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'OPEN_CALIBRATION' })
      expect(actor.getSnapshot().value).toBe('calibrating')
    })
  })

  describe('orthogonal UI state', () => {
    it('SET_ACTIVE_PAGE updates context regardless of state', () => {
      const actor = newActor()
      actor.send({ type: 'SET_ACTIVE_PAGE', pageId: 'page-1' })
      expect(actor.getSnapshot().context.activePageId).toBe('page-1')
      actor.send({ type: 'SELECT_TOOL', tool: 'polygon' })
      actor.send({ type: 'SET_ACTIVE_PAGE', pageId: 'page-2' })
      expect(actor.getSnapshot().context.activePageId).toBe('page-2')
    })

    it('SET_ELEVATION updates context regardless of state', () => {
      const actor = newActor()
      actor.send({ type: 'SET_ELEVATION', elevation: 'south' })
      expect(actor.getSnapshot().context.elevation).toBe('south')
    })

    it('SET_ERROR writes to and clears error context', () => {
      const actor = newActor()
      actor.send({ type: 'SET_ERROR', error: 'boom' })
      expect(actor.getSnapshot().context.error).toBe('boom')
      actor.send({ type: 'SET_ERROR', error: null })
      expect(actor.getSnapshot().context.error).toBeNull()
    })
  })

  describe('exported constants', () => {
    it('exposes per-tool minimum point counts', () => {
      expect(TAKEOFF_TOOL_MIN_POINTS.polygon).toBe(3)
      expect(TAKEOFF_TOOL_MIN_POINTS.lineal).toBe(2)
      expect(TAKEOFF_TOOL_MIN_POINTS.count).toBe(1)
    })
  })
})
