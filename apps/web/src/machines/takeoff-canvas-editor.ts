import { useCallback } from 'react'
import { useMachine } from '@xstate/react'
import { assign, setup } from 'xstate'

/**
 * Pure-UI orchestration machine for the takeoff canvas editor
 * (`apps/web/src/screens/projects/takeoff-canvas.tsx`).
 *
 * The original screen hand-rolled ~11 `useState` calls for tool mode,
 * draft point buffer, calibration overlay, page selection, elevation,
 * and the inline error banner — with no guard against switching tool
 * mid-polygon (which silently dropped the operator's in-progress
 * drafting).
 *
 * This machine owns ONLY UI orchestration. The persisted measurement
 * rows still come from TanStack Query (`useProjectMeasurements`), and
 * the save itself is still a mutation on the parent component — the
 * machine commits the geometry by emitting `COMMIT` and resetting its
 * own draft buffer; the parent forwards the geometry to the API.
 *
 * State graph (textual):
 *
 *   idle ──SELECT_TOOL polygon──▶ polygon_drawing
 *        ──SELECT_TOOL lineal───▶ lineal_drawing
 *        ──SELECT_TOOL count────▶ count_active
 *        ──OPEN_CALIBRATION─────▶ calibrating
 *
 *   polygon_drawing ──ADD_POINT──▶ polygon_drawing  (append draft point)
 *                   ──COMMIT(min 3 pts)──▶ idle    (clear draft, increment commit count)
 *                   ──CANCEL───▶ idle               (clear draft)
 *                   ──SELECT_TOOL (only when draftPoints empty) ──▶ <new tool>
 *
 *   lineal_drawing  ──ADD_POINT──▶ lineal_drawing
 *                   ──COMMIT(min 2 pts)──▶ idle
 *                   ──CANCEL───▶ idle
 *
 *   count_active    ──ADD_POINT──▶ count_active
 *                   ──COMMIT(min 1 pt)──▶ idle
 *                   ──CANCEL───▶ idle
 *
 *   calibrating ──SET_CALIBRATION_POINT (×2)──▶ calibrating
 *               ──COMMIT_CALIBRATION──▶ idle
 *               ──CANCEL───▶ idle
 *
 * Guards:
 *   - SELECT_TOOL while a drawing state has points must `COMMIT` or
 *     `CANCEL` first (prevents silent draft loss). This is the primary
 *     correctness gain over the old useState-based screen.
 *   - COMMIT enforces the per-tool minimum point count.
 */

export type TakeoffTool = 'polygon' | 'lineal' | 'count'

export interface Point {
  x: number
  y: number
}

export interface CalibrationPoint extends Point {
  /** Optional label, only used in the UI for which corner. */
  corner?: 'a' | 'b'
}

export interface PendingCalibration {
  points: CalibrationPoint[]
}

export type ElevationTag = 'none' | 'east' | 'south' | 'west' | 'north' | 'roof' | 'other'

type Context = {
  /** Active tool while a drawing state is current. Reset to `null` in idle. */
  tool: TakeoffTool | null
  /** Buffer of in-progress vertices for polygon / lineal / count modes. */
  draftPoints: Point[]
  /** Currently active blueprint page id (null when no pages loaded). */
  activePageId: string | null
  /** Elevation tag applied to the next saved measurement. */
  elevation: ElevationTag
  /** Calibration draft (two corner clicks) while `calibrating`. */
  calibration: PendingCalibration | null
  /** Inline banner text — opaque to the machine, surfaced by the screen. */
  error: string | null
  /** Cap on polygon vertices; the old screen hard-coded 64. */
  maxPolygonPoints: number
  /** Monotonic counter — bumps every time a measurement is committed so
   * the parent component can detect "machine just committed" without
   * subscribing to internal events. */
  commitSerial: number
}

export type TakeoffCanvasEvent =
  | { type: 'SELECT_TOOL'; tool: TakeoffTool }
  | { type: 'ADD_POINT'; point: Point }
  | { type: 'UNDO_POINT' }
  | { type: 'CLEAR_DRAFT' }
  | { type: 'COMMIT' }
  | { type: 'CANCEL' }
  | { type: 'OPEN_CALIBRATION' }
  | { type: 'SET_CALIBRATION_POINT'; point: Point }
  | { type: 'COMMIT_CALIBRATION' }
  | { type: 'SET_ACTIVE_PAGE'; pageId: string | null }
  | { type: 'SET_ELEVATION'; elevation: ElevationTag }
  | { type: 'SET_ERROR'; error: string | null }

const MIN_POINTS: Record<TakeoffTool, number> = {
  polygon: 3,
  lineal: 2,
  count: 1,
}

export const takeoffCanvasEditorMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { maxPolygonPoints?: number; initialElevation?: ElevationTag },
    events: {} as TakeoffCanvasEvent,
  },
  guards: {
    /** Can the operator switch tools right now? Allowed in `idle` and
     * when the current drawing buffer is empty. */
    canSwitchTool: ({ context }) => context.draftPoints.length === 0,
    hasPolygonMinimum: ({ context }) => context.draftPoints.length >= MIN_POINTS.polygon,
    hasLinealMinimum: ({ context }) => context.draftPoints.length >= MIN_POINTS.lineal,
    hasCountMinimum: ({ context }) => context.draftPoints.length >= MIN_POINTS.count,
    underPolygonCap: ({ context }) => context.draftPoints.length < context.maxPolygonPoints,
    hasTwoCalibrationPoints: ({ context }) => (context.calibration?.points.length ?? 0) >= 2,
  },
  actions: {
    addPoint: assign({
      draftPoints: ({ context, event }) => {
        if (event.type !== 'ADD_POINT') return context.draftPoints
        return [...context.draftPoints, event.point]
      },
    }),
    clearDraft: assign({
      draftPoints: () => [],
    }),
    popPoint: assign({
      draftPoints: ({ context }) => context.draftPoints.slice(0, -1),
    }),
    bumpCommitSerial: assign({
      commitSerial: ({ context }) => context.commitSerial + 1,
    }),
    setToolFromEvent: assign({
      tool: ({ event }) => (event.type === 'SELECT_TOOL' ? event.tool : null),
    }),
    clearTool: assign({
      tool: () => null,
    }),
    startCalibration: assign({
      calibration: () => ({ points: [] }),
    }),
    appendCalibrationPoint: assign({
      calibration: ({ context, event }) => {
        if (event.type !== 'SET_CALIBRATION_POINT') return context.calibration
        const points = context.calibration?.points ?? []
        // Cap at two — the calibration overlay expects exactly two corners.
        const next = points.length >= 2 ? [points[0]!, event.point] : [...points, event.point]
        return { points: next as CalibrationPoint[] }
      },
    }),
    clearCalibration: assign({
      calibration: () => null,
    }),
    setActivePage: assign({
      activePageId: ({ context, event }) => (event.type === 'SET_ACTIVE_PAGE' ? event.pageId : context.activePageId),
    }),
    setElevation: assign({
      elevation: ({ context, event }) => (event.type === 'SET_ELEVATION' ? event.elevation : context.elevation),
    }),
    setError: assign({
      error: ({ context, event }) => (event.type === 'SET_ERROR' ? event.error : context.error),
    }),
  },
}).createMachine({
  id: 'takeoffCanvasEditor',
  initial: 'idle',
  context: ({ input }) => ({
    tool: null,
    draftPoints: [],
    activePageId: null,
    elevation: input.initialElevation ?? 'none',
    calibration: null,
    error: null,
    maxPolygonPoints: input.maxPolygonPoints ?? 64,
    commitSerial: 0,
  }),
  // Page / elevation / error transitions are valid in any state — they
  // describe orthogonal UI surfaces (page strip, elevation chip, banner)
  // that the active tool shouldn't constrain.
  on: {
    SET_ACTIVE_PAGE: { actions: 'setActivePage' },
    SET_ELEVATION: { actions: 'setElevation' },
    SET_ERROR: { actions: 'setError' },
  },
  states: {
    idle: {
      entry: ['clearDraft', 'clearTool'],
      on: {
        SELECT_TOOL: [
          {
            target: 'polygon_drawing',
            guard: ({ event }) => event.tool === 'polygon',
            actions: 'setToolFromEvent',
          },
          {
            target: 'lineal_drawing',
            guard: ({ event }) => event.tool === 'lineal',
            actions: 'setToolFromEvent',
          },
          {
            target: 'count_active',
            guard: ({ event }) => event.tool === 'count',
            actions: 'setToolFromEvent',
          },
        ],
        OPEN_CALIBRATION: {
          target: 'calibrating',
          actions: 'startCalibration',
        },
      },
    },
    polygon_drawing: {
      on: {
        ADD_POINT: {
          guard: 'underPolygonCap',
          actions: 'addPoint',
        },
        UNDO_POINT: { actions: 'popPoint' },
        CLEAR_DRAFT: { actions: 'clearDraft' },
        COMMIT: {
          target: 'idle',
          guard: 'hasPolygonMinimum',
          actions: 'bumpCommitSerial',
        },
        CANCEL: 'idle',
        SELECT_TOOL: [
          // SELECT_TOOL switching to the same tool while in polygon_drawing
          // is a no-op rather than a draft-loss footgun. Anything else
          // requires the operator to COMMIT/CANCEL first.
          {
            target: 'polygon_drawing',
            guard: ({ event }) => event.tool === 'polygon',
          },
          {
            target: 'lineal_drawing',
            guard: 'canSwitchTool',
            actions: 'setToolFromEvent',
          },
          {
            target: 'count_active',
            guard: 'canSwitchTool',
            actions: 'setToolFromEvent',
          },
        ],
        OPEN_CALIBRATION: {
          target: 'calibrating',
          guard: 'canSwitchTool',
          actions: ['clearDraft', 'startCalibration'],
        },
      },
    },
    lineal_drawing: {
      on: {
        ADD_POINT: { actions: 'addPoint' },
        UNDO_POINT: { actions: 'popPoint' },
        CLEAR_DRAFT: { actions: 'clearDraft' },
        COMMIT: {
          target: 'idle',
          guard: 'hasLinealMinimum',
          actions: 'bumpCommitSerial',
        },
        CANCEL: 'idle',
        SELECT_TOOL: [
          {
            target: 'lineal_drawing',
            guard: ({ event }) => event.tool === 'lineal',
          },
          {
            target: 'polygon_drawing',
            guard: 'canSwitchTool',
            actions: 'setToolFromEvent',
          },
          {
            target: 'count_active',
            guard: 'canSwitchTool',
            actions: 'setToolFromEvent',
          },
        ],
        OPEN_CALIBRATION: {
          target: 'calibrating',
          guard: 'canSwitchTool',
          actions: ['clearDraft', 'startCalibration'],
        },
      },
    },
    count_active: {
      on: {
        ADD_POINT: { actions: 'addPoint' },
        UNDO_POINT: { actions: 'popPoint' },
        CLEAR_DRAFT: { actions: 'clearDraft' },
        COMMIT: {
          target: 'idle',
          guard: 'hasCountMinimum',
          actions: 'bumpCommitSerial',
        },
        CANCEL: 'idle',
        SELECT_TOOL: [
          {
            target: 'count_active',
            guard: ({ event }) => event.tool === 'count',
          },
          {
            target: 'polygon_drawing',
            guard: 'canSwitchTool',
            actions: 'setToolFromEvent',
          },
          {
            target: 'lineal_drawing',
            guard: 'canSwitchTool',
            actions: 'setToolFromEvent',
          },
        ],
        OPEN_CALIBRATION: {
          target: 'calibrating',
          guard: 'canSwitchTool',
          actions: ['clearDraft', 'startCalibration'],
        },
      },
    },
    calibrating: {
      on: {
        SET_CALIBRATION_POINT: { actions: 'appendCalibrationPoint' },
        COMMIT_CALIBRATION: {
          target: 'idle',
          guard: 'hasTwoCalibrationPoints',
          actions: ['clearCalibration', 'bumpCommitSerial'],
        },
        CANCEL: {
          target: 'idle',
          actions: 'clearCalibration',
        },
      },
    },
  },
})

export type TakeoffCanvasEditorState = 'idle' | 'polygon_drawing' | 'lineal_drawing' | 'count_active' | 'calibrating'

export interface TakeoffCanvasEditorHookResult {
  state: TakeoffCanvasEditorState
  tool: TakeoffTool | null
  draftPoints: Point[]
  activePageId: string | null
  elevation: ElevationTag
  calibration: PendingCalibration | null
  error: string | null
  commitSerial: number
  isDrawing: boolean
  isCalibrating: boolean
  canCommit: boolean
  selectTool: (tool: TakeoffTool) => void
  addPoint: (point: Point) => void
  undoPoint: () => void
  clearDraft: () => void
  commit: () => void
  cancel: () => void
  openCalibration: () => void
  setCalibrationPoint: (point: Point) => void
  commitCalibration: () => void
  setActivePage: (pageId: string | null) => void
  setElevation: (elevation: ElevationTag) => void
  setError: (error: string | null) => void
}

/**
 * Convenience hook. Keeps the surface area focused on the action the
 * screen wants to perform — the screen doesn't need to know the event
 * type names.
 */
export function useTakeoffCanvasEditor(
  options: { maxPolygonPoints?: number; initialElevation?: ElevationTag } = {},
): TakeoffCanvasEditorHookResult {
  const input: { maxPolygonPoints?: number; initialElevation?: ElevationTag } = {}
  if (options.maxPolygonPoints !== undefined) input.maxPolygonPoints = options.maxPolygonPoints
  if (options.initialElevation !== undefined) input.initialElevation = options.initialElevation
  const [state, send] = useMachine(takeoffCanvasEditorMachine, { input })

  const selectTool = useCallback((tool: TakeoffTool) => send({ type: 'SELECT_TOOL', tool }), [send])
  const addPoint = useCallback((point: Point) => send({ type: 'ADD_POINT', point }), [send])
  const undoPoint = useCallback(() => send({ type: 'UNDO_POINT' }), [send])
  const clearDraft = useCallback(() => send({ type: 'CLEAR_DRAFT' }), [send])
  const commit = useCallback(() => send({ type: 'COMMIT' }), [send])
  const cancel = useCallback(() => send({ type: 'CANCEL' }), [send])
  const openCalibration = useCallback(() => send({ type: 'OPEN_CALIBRATION' }), [send])
  const setCalibrationPoint = useCallback((point: Point) => send({ type: 'SET_CALIBRATION_POINT', point }), [send])
  const commitCalibration = useCallback(() => send({ type: 'COMMIT_CALIBRATION' }), [send])
  const setActivePage = useCallback((pageId: string | null) => send({ type: 'SET_ACTIVE_PAGE', pageId }), [send])
  const setElevation = useCallback((elevation: ElevationTag) => send({ type: 'SET_ELEVATION', elevation }), [send])
  const setError = useCallback((error: string | null) => send({ type: 'SET_ERROR', error }), [send])

  const currentState = (state.value as TakeoffCanvasEditorState) ?? 'idle'
  const canCommit =
    (currentState === 'polygon_drawing' && state.context.draftPoints.length >= MIN_POINTS.polygon) ||
    (currentState === 'lineal_drawing' && state.context.draftPoints.length >= MIN_POINTS.lineal) ||
    (currentState === 'count_active' && state.context.draftPoints.length >= MIN_POINTS.count) ||
    (currentState === 'calibrating' && (state.context.calibration?.points.length ?? 0) >= 2)

  return {
    state: currentState,
    tool: state.context.tool,
    draftPoints: state.context.draftPoints,
    activePageId: state.context.activePageId,
    elevation: state.context.elevation,
    calibration: state.context.calibration,
    error: state.context.error,
    commitSerial: state.context.commitSerial,
    isDrawing: currentState !== 'idle' && currentState !== 'calibrating',
    isCalibrating: currentState === 'calibrating',
    canCommit,
    selectTool,
    addPoint,
    undoPoint,
    clearDraft,
    commit,
    cancel,
    openCalibration,
    setCalibrationPoint,
    commitCalibration,
    setActivePage,
    setElevation,
    setError,
  }
}

export const TAKEOFF_TOOL_MIN_POINTS = MIN_POINTS
