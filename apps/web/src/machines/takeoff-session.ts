import { useCallback, useMemo, useRef } from 'react'
import { useMachine } from '@xstate/react'
import { assign, createActor, fromPromise, setup, type Actor, type SnapshotFrom, type StateValue } from 'xstate'
import { calculateLinealLength, calculatePolygonArea, type PitchDriver, type TakeoffPoint } from '@sitelayer/domain'

/**
 * `takeoff-session` — the single state owner for the blueprint takeoff canvas.
 *
 * Why this exists
 * ---------------
 * The canvas (`screens/desktop/est-canvas.tsx`, ~5.4k lines) scattered its
 * session across ~40 `useState` atoms spread over three divergent surfaces
 * (desktop body, phone body, and the since-retired v1
 * `screens/projects/takeoff-canvas.tsx`, deleted 2026-06-12). There
 * was no way to *assert* or *inject* a canvas state, so getting a tester into
 * "mid-polygon-draw with 3 points placed" or "AI capture pending review" meant
 * replaying a multi-minute click path. This machine absorbs all of that UI
 * state into ONE context with explicit, hierarchical modes, so:
 *
 *   1. tests drive transitions deterministically (createActor + send), and
 *   2. a test OR a dev "jump to scenario" affordance can boot the canvas
 *      straight into any state via {@link takeoffSessionSeedActor} (xstate
 *      `resolveState` rehydration — no entry side-effects fire).
 *
 * House style (see docs/DETERMINISTIC_WORKFLOWS.md + machines/estimate-push.ts):
 *   - This is an ARCHETYPE B local-orchestration machine. There is NO server
 *     takeoff workflow to mirror, so its states are local UI states.
 *   - Business data (the measurement rows themselves) is NOT mirrored here — it
 *     stays in TanStack Query (`useProjectMeasurements`). The machine owns the
 *     *session* (what you're doing), the screen reads the *data* and renders it.
 *   - All IO lives in injectable `fromPromise` actors (the factory's `deps`),
 *     never in guards/actions. Tests inject synchronous resolve/reject.
 *   - `mode` (top-level state) and `tool` (a context slice) are ORTHOGONAL —
 *     the legal combinations are enforced by which events each state accepts,
 *     not by silently ignoring an out-of-band tool (the old bug).
 *
 * State graph (top-level = mode):
 *
 *   loading ──▶ idle
 *   idle ──START_DRAW──▶ drawing.placing
 *        ──START_CALIBRATION──▶ calibrating.placing
 *        ──START_SELECT──▶ selecting.browsing
 *        ──START_CAPTURE──▶ capturing.configuring
 *   drawing.placing ──PLACE_POINT/UNDO_POINT──▶ drawing.placing
 *                   ──COMMIT (guard canCommit)──▶ drawing.committing ──▶ idle
 *                   ──CANCEL──▶ idle
 *   calibrating.placing ──PLACE_SCALE_POINT/SET_SCALE_LENGTH──▶ self
 *                       ──APPLY (guard scaleReady)──▶ calibrating.applying ──▶ idle
 *   selecting.browsing ──START_EDIT_GEOM──▶ selecting.editingVertex ──APPLY_EDIT──▶ browsing
 *                      ──OPEN_COPY──▶ selecting.copying ──APPLY_COPY──▶ browsing
 *   capturing.configuring ──RUN_CAPTURE──▶ capturing.running ──▶ reviewing
 *   capturing.reviewing ──PROMOTE──▶ capturing.promoting ──▶ idle
 */

// ────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ────────────────────────────────────────────────────────────────────────────

/** A drawing tool. Maps to a `geometry_kind` at commit time (see TOOL_GEOMETRY_KIND). */
export type TakeoffTool = 'polygon' | 'rect' | 'lineal' | 'arc' | 'count' | 'volume'

/** Logical canvas mode. Form-factor independent — pan/zoom is a *capability*
 *  (useCanvasViewport), NOT a separate phone mode. */
export type TakeoffMode = 'loading' | 'idle' | 'drawing' | 'calibrating' | 'selecting' | 'capturing'

/** geometry_kind written to `takeoff_measurements`. */
export type TakeoffGeometryKind = 'polygon' | 'lineal' | 'count' | 'volume'

export const TOOL_GEOMETRY_KIND: Record<TakeoffTool, TakeoffGeometryKind> = {
  polygon: 'polygon',
  rect: 'polygon',
  lineal: 'lineal',
  arc: 'lineal',
  count: 'count',
  volume: 'volume',
}

export const TAKEOFF_ELEVATIONS = ['east', 'south', 'west', 'north', 'roof', 'other'] as const
export type TakeoffElevation = (typeof TAKEOFF_ELEVATIONS)[number]

/** Capture pipelines that can populate a draft's `takeoff_result_json`. */
export type TakeoffCaptureKind = 'blueprint_vision' | 'roomplan' | 'drone' | 'photogrammetry'

/** Single-open overlay region. One nullable field instead of nine booleans
 *  guarantees the single-open invariant by construction. */
export type TakeoffOverlay = 'item_palette' | 'condition_form' | 'copy_panel' | 'assembly_panel' | 'callouts' | null

/** Per-captured-quantity review decision (AI human-in-the-loop). */
export type CaptureDecision = 'accept' | 'reject' | 'edit'

// ────────────────────────────────────────────────────────────────────────────
// Context slices
// ────────────────────────────────────────────────────────────────────────────

export interface TakeoffViewportSlice {
  zoom: number
  pan: { x: number; y: number }
}

export interface TakeoffDraftSlice {
  tool: TakeoffTool
  /** In-progress vertices in 0–100 board space. Empty = nothing being drawn. */
  points: TakeoffPoint[]
  /** Undo/redo over the in-progress vertices only (committed rows undo elsewhere). */
  redo: TakeoffPoint[]
  serviceItemCode: string | null
  divisionCode: string | null
  conditionId: string | null
  elevation: TakeoffElevation | null
  /** Area cutout — nets out of the parent area downstream (`is_deduction`). */
  deduct: boolean
  pitch: PitchDriver | null
}

export interface TakeoffCalibrationSlice {
  /** 0..2 reference clicks for the two-point scale line. */
  points: TakeoffPoint[]
  /** Typed known real-world length for the reference line. */
  lengthText: string
  unit: string
}

export interface TakeoffSelectionSlice {
  selectedId: string | null
  bulkIds: string[]
  /** When set, the next item-palette pick REASSIGNS these rows instead of
   *  setting the draft scope item. */
  reassignIds: string[] | null
  /** Vertex-edit target + its working point set. */
  editGeomId: string | null
  editPoints: TakeoffPoint[] | null
}

export interface TakeoffCaptureSlice {
  kind: TakeoffCaptureKind | null
  /** live = real pipeline call; dry-run = deterministic stub. An ATTRIBUTE,
   *  never a hardcoded assumption (the old projects surface pinned dryRun:true).
   *  After a run completes, the runCapture actor overwrites this with the
   *  SERVER-resolved mode (from the draft's `capture_provenance`) so the
   *  review overlay's LIVE/DEMO chip reflects what actually happened, not what
   *  was requested. */
  mode: 'live' | 'dry-run'
  /** The takeoff draft CREATED by the capture run (POST /capture creates a new
   *  draft). Promote targets this draft, never the session's pre-capture
   *  `draftId`. Null until a run completes. */
  draftId: string | null
  /** Captured result JSON awaiting review (shape owned by capture-schema). */
  result: unknown | null
  /** Per-quantity-id review decisions. */
  decisions: Record<string, CaptureDecision>
  showLow: boolean
}

export interface TakeoffSessionContext {
  projectId: string
  companySlug: string
  /** Active selection — single source of truth (the screen mirrors these to URL). */
  blueprintId: string | null
  pageId: string | null
  draftId: string | null
  viewport: TakeoffViewportSlice
  draft: TakeoffDraftSlice
  calibration: TakeoffCalibrationSlice
  selection: TakeoffSelectionSlice
  capture: TakeoffCaptureSlice
  overlay: TakeoffOverlay
  error: string | null
}

// ────────────────────────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────────────────────────

export type TakeoffSessionEvent =
  | { type: 'LOAD' }
  | { type: 'SELECT_BLUEPRINT'; blueprintId: string | null }
  | { type: 'SELECT_PAGE'; pageId: string | null }
  | { type: 'SELECT_DRAFT'; draftId: string | null }
  | { type: 'SET_VIEWPORT'; zoom?: number; pan?: { x: number; y: number } }
  // draw
  | { type: 'SET_TOOL'; tool: TakeoffTool }
  | { type: 'START_DRAW' }
  | { type: 'PLACE_POINT'; point: TakeoffPoint }
  | { type: 'UNDO_POINT' }
  | { type: 'REDO_POINT' }
  | { type: 'COMMIT' }
  | { type: 'CANCEL' }
  | { type: 'SET_SERVICE_ITEM'; serviceItemCode: string | null; divisionCode?: string | null }
  | { type: 'SET_CONDITION'; conditionId: string | null }
  | { type: 'SET_ELEVATION'; elevation: TakeoffElevation | null }
  | { type: 'TOGGLE_DEDUCT' }
  | { type: 'SET_PITCH'; pitch: PitchDriver | null }
  // calibrate
  | { type: 'START_CALIBRATION' }
  | { type: 'PLACE_SCALE_POINT'; point: TakeoffPoint }
  | { type: 'SET_SCALE_LENGTH'; lengthText: string; unit?: string }
  | { type: 'APPLY_CALIBRATION' }
  // select / edit / copy
  | { type: 'START_SELECT' }
  | { type: 'SELECT_MEASUREMENT'; measurementId: string | null }
  | { type: 'BULK_SELECT'; ids: string[] }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'START_REASSIGN'; ids: string[] }
  | { type: 'START_EDIT_GEOM'; measurementId: string; points: TakeoffPoint[] }
  | { type: 'DRAG_VERTEX'; index: number; point: TakeoffPoint }
  | { type: 'APPLY_EDIT' }
  | { type: 'OPEN_COPY' }
  | { type: 'APPLY_COPY' }
  // capture / AI review
  | { type: 'START_CAPTURE'; kind: TakeoffCaptureKind; mode?: 'live' | 'dry-run' }
  | { type: 'RUN_CAPTURE' }
  | { type: 'REVIEW_DECISION'; quantityId: string; decision: CaptureDecision }
  | { type: 'TOGGLE_SHOW_LOW' }
  | { type: 'PROMOTE'; quantityIds: string[] }
  // overlays + errors
  | { type: 'OPEN_OVERLAY'; overlay: Exclude<TakeoffOverlay, null> }
  | { type: 'CLOSE_OVERLAY' }
  | { type: 'DISMISS_ERROR' }

// ────────────────────────────────────────────────────────────────────────────
// Injectable IO (the factory deps). Tests pass synchronous mocks.
// ────────────────────────────────────────────────────────────────────────────

export interface TakeoffSessionDeps {
  /** Resolve the active blueprint/page/draft for a project (defaults shown). */
  loadSession: (input: {
    projectId: string
    companySlug: string
    blueprintId: string | null
    pageId: string | null
    draftId: string | null
  }) => Promise<{ blueprintId: string | null; pageId: string | null; draftId: string | null }>
  /** Persist the in-progress draft geometry as a committed measurement. */
  commitMeasurement: (input: { context: TakeoffSessionContext }) => Promise<{ measurementId: string }>
  /** Persist a two-point page calibration. */
  calibratePage: (input: {
    pageId: string
    points: TakeoffPoint[]
    worldDistance: number
    unit: string
  }) => Promise<void>
  /** Run a capture pipeline; resolves once the result is reviewable.
   *  REAL contract (async-capture split 2026-06-12, wired by
   *  `takeoff-session-deps.ts`): POST /capture (creates a NEW draft; a live
   *  read answers 202 'processing'), then poll GET /takeoff-drafts/:id/result
   *  until the status leaves 'processing'. A 'failed' status REJECTS (provider
   *  errors never produce stub rows). `mode`/`draftId` in the output are the
   *  server-resolved honesty signals — when present they overwrite the
   *  requested mode and record the capture-created draft for promote. */
  runCapture: (input: {
    projectId: string
    draftId: string | null
    kind: TakeoffCaptureKind
    mode: 'live' | 'dry-run'
  }) => Promise<TakeoffCaptureRunOutput>
  /** Promote selected captured quantities into committed measurements.
   *  `draftId` is the capture-created draft (capture.draftId) when one exists,
   *  else the session draft. */
  promoteCaptured: (input: { projectId: string; draftId: string | null; quantityIds: string[] }) => Promise<void>
}

/** Output of a completed capture run (see {@link TakeoffSessionDeps.runCapture}). */
export interface TakeoffCaptureRunOutput {
  /** The reviewable result JSON (shape owned by capture-schema). */
  result: unknown
  /** Server-resolved honesty signal: 'live' only when the draft's
   *  `capture_provenance` is a real provider read. Optional for injected test
   *  deps — absent keeps the requested mode. */
  mode?: 'live' | 'dry-run'
  /** Id of the draft the capture run created (promote targets it). */
  draftId?: string | null
}

/** Default deps throw until wired. The REAL lib/api-backed capture/promote
 *  implementations live in `takeoff-session-deps.ts`
 *  (`createTakeoffSessionApiDeps`) — the est-canvas bodies pass those; tests
 *  inject synchronous mocks. The remaining actors (commit / calibrate) still
 *  persist via the screens' hybrid TanStack-Query path and are never invoked. */
export const unwiredTakeoffSessionDeps: TakeoffSessionDeps = {
  loadSession: async ({ blueprintId, pageId, draftId }) => ({ blueprintId, pageId, draftId }),
  commitMeasurement: async () => {
    throw new Error('takeoff-session: commitMeasurement not wired')
  },
  calibratePage: async () => {
    throw new Error('takeoff-session: calibratePage not wired')
  },
  runCapture: async () => {
    throw new Error('takeoff-session: runCapture not wired')
  },
  promoteCaptured: async () => {
    throw new Error('takeoff-session: promoteCaptured not wired')
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (also used by guards + the UI)
// ────────────────────────────────────────────────────────────────────────────

/** Minimum vertices required before a draft of the given tool can commit. */
export function minPointsForTool(tool: TakeoffTool): number {
  switch (tool) {
    case 'polygon':
    case 'rect':
      return 3
    case 'lineal':
    case 'arc':
      return 2
    case 'count':
    case 'volume':
      return 1
  }
}

/** A scope (service item OR condition) and enough vertices are required to commit. */
export function canCommitDraft(context: TakeoffSessionContext): boolean {
  const { draft } = context
  const hasScope = Boolean(draft.serviceItemCode) || Boolean(draft.conditionId)
  return hasScope && draft.points.length >= minPointsForTool(draft.tool)
}

/** Two reference points + a positive typed length are required to calibrate. */
export function isScaleReady(context: TakeoffSessionContext): boolean {
  const length = Number.parseFloat(context.calibration.lengthText)
  return context.calibration.points.length === 2 && Number.isFinite(length) && length > 0
}

/** Live board-space quantity of the in-progress draft (for the HUD readout). */
export function draftQuantity(context: TakeoffSessionContext): number {
  const { draft } = context
  const kind = TOOL_GEOMETRY_KIND[draft.tool]
  if (kind === 'polygon') return calculatePolygonArea(draft.points)
  if (kind === 'lineal') return calculateLinealLength(draft.points)
  if (kind === 'count') return draft.points.length
  return 0
}

function defaultViewport(): TakeoffViewportSlice {
  return { zoom: 1, pan: { x: 0, y: 0 } }
}
function defaultDraft(): TakeoffDraftSlice {
  return {
    tool: 'polygon',
    points: [],
    redo: [],
    serviceItemCode: null,
    divisionCode: null,
    conditionId: null,
    elevation: null,
    deduct: false,
    pitch: null,
  }
}
function defaultCalibration(): TakeoffCalibrationSlice {
  return { points: [], lengthText: '', unit: 'ft' }
}
function defaultSelection(): TakeoffSelectionSlice {
  return { selectedId: null, bulkIds: [], reassignIds: null, editGeomId: null, editPoints: null }
}
function defaultCapture(): TakeoffCaptureSlice {
  return { kind: null, mode: 'dry-run', draftId: null, result: null, decisions: {}, showLow: true }
}

export interface BuildTakeoffSessionContextInput {
  projectId: string
  companySlug: string
  blueprintId?: string | null
  pageId?: string | null
  draftId?: string | null
  viewport?: Partial<TakeoffViewportSlice>
  draft?: Partial<TakeoffDraftSlice>
  calibration?: Partial<TakeoffCalibrationSlice>
  selection?: Partial<TakeoffSelectionSlice>
  capture?: Partial<TakeoffCaptureSlice>
  overlay?: TakeoffOverlay
  error?: string | null
}

/** Deterministic context builder — the seed seam for tests + dev jump. */
export function buildTakeoffSessionContext(input: BuildTakeoffSessionContextInput): TakeoffSessionContext {
  return {
    projectId: input.projectId,
    companySlug: input.companySlug,
    blueprintId: input.blueprintId ?? null,
    pageId: input.pageId ?? null,
    draftId: input.draftId ?? null,
    viewport: { ...defaultViewport(), ...(input.viewport ?? {}) },
    draft: { ...defaultDraft(), ...(input.draft ?? {}) },
    calibration: { ...defaultCalibration(), ...(input.calibration ?? {}) },
    selection: { ...defaultSelection(), ...(input.selection ?? {}) },
    capture: { ...defaultCapture(), ...(input.capture ?? {}) },
    overlay: input.overlay ?? null,
    error: input.error ?? null,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The machine factory
// ────────────────────────────────────────────────────────────────────────────

export type TakeoffSessionInput = BuildTakeoffSessionContextInput

export function createTakeoffSessionMachine(deps: TakeoffSessionDeps = unwiredTakeoffSessionDeps) {
  return setup({
    types: {
      context: {} as TakeoffSessionContext,
      input: {} as TakeoffSessionInput,
      events: {} as TakeoffSessionEvent,
    },
    guards: {
      canCommit: ({ context }) => canCommitDraft(context),
      scaleReady: ({ context }) => isScaleReady(context),
    },
    actors: {
      loadSession: fromPromise<
        { blueprintId: string | null; pageId: string | null; draftId: string | null },
        { context: TakeoffSessionContext }
      >(async ({ input }) =>
        deps.loadSession({
          projectId: input.context.projectId,
          companySlug: input.context.companySlug,
          blueprintId: input.context.blueprintId,
          pageId: input.context.pageId,
          draftId: input.context.draftId,
        }),
      ),
      commitMeasurement: fromPromise<{ measurementId: string }, { context: TakeoffSessionContext }>(async ({ input }) =>
        deps.commitMeasurement({ context: input.context }),
      ),
      calibratePage: fromPromise<void, { context: TakeoffSessionContext }>(async ({ input }) => {
        const { calibration, pageId } = input.context
        if (!pageId) throw new Error('takeoff-session: cannot calibrate without a page')
        await deps.calibratePage({
          pageId,
          points: calibration.points,
          worldDistance: Number.parseFloat(calibration.lengthText),
          unit: calibration.unit,
        })
      }),
      runCapture: fromPromise<TakeoffCaptureRunOutput, { context: TakeoffSessionContext }>(async ({ input }) =>
        deps.runCapture({
          projectId: input.context.projectId,
          draftId: input.context.draftId,
          kind: input.context.capture.kind ?? 'blueprint_vision',
          mode: input.context.capture.mode,
        }),
      ),
      promoteCaptured: fromPromise<void, { context: TakeoffSessionContext; quantityIds: string[] }>(async ({ input }) =>
        deps.promoteCaptured({
          projectId: input.context.projectId,
          // Promote targets the draft the capture run CREATED; the session
          // draftId is only a fallback for seeded/legacy states.
          draftId: input.context.capture.draftId ?? input.context.draftId,
          quantityIds: input.quantityIds,
        }),
      ),
    },
    actions: {
      clearDraftPoints: assign({
        draft: ({ context }) => ({ ...context.draft, points: [], redo: [] }),
      }),
      clearError: assign({ error: () => null }),
    },
  }).createMachine({
    id: 'takeoffSession',
    initial: 'loading',
    context: ({ input }) => buildTakeoffSessionContext(input),
    // Global events — valid in any mode (selection-independent UI slices).
    on: {
      SELECT_BLUEPRINT: { actions: assign({ blueprintId: ({ event }) => event.blueprintId, pageId: () => null }) },
      SELECT_PAGE: { actions: assign({ pageId: ({ event }) => event.pageId }) },
      SELECT_DRAFT: { actions: assign({ draftId: ({ event }) => event.draftId }) },
      SET_VIEWPORT: {
        actions: assign({
          viewport: ({ context, event }) => ({
            zoom: event.zoom ?? context.viewport.zoom,
            pan: event.pan ?? context.viewport.pan,
          }),
        }),
      },
      SET_TOOL: {
        // Switching tool resets the in-progress draft (the old code left a stale
        // draft dangling across a tool change — a real footgun).
        actions: assign({
          draft: ({ context, event }) => ({ ...context.draft, tool: event.tool, points: [], redo: [] }),
        }),
      },
      SET_SERVICE_ITEM: {
        actions: assign({
          draft: ({ context, event }) => ({
            ...context.draft,
            serviceItemCode: event.serviceItemCode,
            divisionCode: event.divisionCode ?? context.draft.divisionCode,
          }),
        }),
      },
      SET_CONDITION: {
        actions: assign({ draft: ({ context, event }) => ({ ...context.draft, conditionId: event.conditionId }) }),
      },
      SET_ELEVATION: {
        actions: assign({ draft: ({ context, event }) => ({ ...context.draft, elevation: event.elevation }) }),
      },
      TOGGLE_DEDUCT: {
        actions: assign({ draft: ({ context }) => ({ ...context.draft, deduct: !context.draft.deduct }) }),
      },
      SET_PITCH: { actions: assign({ draft: ({ context, event }) => ({ ...context.draft, pitch: event.pitch }) }) },
      OPEN_OVERLAY: { actions: assign({ overlay: ({ event }) => event.overlay }) },
      CLOSE_OVERLAY: { actions: assign({ overlay: () => null }) },
      DISMISS_ERROR: { actions: 'clearError' },
      // Selection is orthogonal to mode: on the phone canvas you can single- or
      // bulk-select a committed measurement WHILE a draft is in progress (the
      // draft slice persists across mode flips), so the pure selection setters
      // are global. The `selecting` state still owns the same events at its own
      // level (deepest handler wins there), plus the mode-transition events
      // START_EDIT_GEOM / DRAG_VERTEX / APPLY_EDIT / OPEN_COPY which only make
      // sense inside `selecting` and stay scoped to it.
      SELECT_MEASUREMENT: {
        actions: assign({
          selection: ({ context, event }) => ({ ...context.selection, selectedId: event.measurementId, bulkIds: [] }),
        }),
      },
      BULK_SELECT: {
        actions: assign({
          selection: ({ context, event }) => ({
            ...context.selection,
            bulkIds: event.ids,
            selectedId: event.ids.length === 1 ? event.ids[0]! : null,
          }),
        }),
      },
      CLEAR_SELECTION: { actions: assign({ selection: () => defaultSelection() }) },
      // Vertex-edit slice is likewise orthogonal: a form factor (the phone) that
      // edits geometry from the same surface it draws on can populate / drag /
      // clear the working edit point set without a mode flip (the draft slice
      // must survive). When the machine IS in `selecting.browsing` the scoped
      // handler additionally drives the editingVertex sub-state transition
      // (deepest handler wins there); these globals just own the context.
      START_EDIT_GEOM: {
        actions: assign({
          selection: ({ context, event }) => ({
            ...context.selection,
            editGeomId: event.measurementId,
            editPoints: event.points,
          }),
        }),
      },
      DRAG_VERTEX: {
        actions: assign({
          selection: ({ context, event }) => {
            const editPoints = (context.selection.editPoints ?? []).map((p, i) => (i === event.index ? event.point : p))
            return { ...context.selection, editPoints }
          },
        }),
      },
      APPLY_EDIT: {
        actions: assign({ selection: ({ context }) => ({ ...context.selection, editGeomId: null, editPoints: null }) }),
      },
    },
    states: {
      loading: {
        invoke: {
          src: 'loadSession',
          input: ({ context }) => ({ context }),
          onDone: {
            target: 'idle',
            actions: assign({
              blueprintId: ({ event }) => event.output.blueprintId,
              pageId: ({ event }) => event.output.pageId,
              draftId: ({ event }) => event.output.draftId,
              error: () => null,
            }),
          },
          onError: {
            target: 'idle',
            actions: assign({
              error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to load'),
            }),
          },
        },
      },

      idle: {
        on: {
          LOAD: 'loading',
          START_DRAW: 'drawing',
          START_CALIBRATION: {
            target: 'calibrating',
            actions: assign({ calibration: ({ context }) => ({ ...context.calibration, points: [] }) }),
          },
          START_SELECT: 'selecting',
          START_CAPTURE: {
            target: 'capturing',
            actions: assign({
              capture: ({ context, event }) => ({
                ...context.capture,
                kind: event.kind,
                mode: event.mode ?? context.capture.mode,
                draftId: null,
                result: null,
                decisions: {},
              }),
            }),
          },
        },
      },

      drawing: {
        initial: 'placing',
        on: {
          CANCEL: { target: 'idle', actions: 'clearDraftPoints' },
        },
        states: {
          placing: {
            on: {
              PLACE_POINT: {
                actions: assign({
                  draft: ({ context, event }) => ({
                    ...context.draft,
                    points: [...context.draft.points, event.point],
                    redo: [],
                  }),
                }),
              },
              UNDO_POINT: {
                guard: ({ context }) => context.draft.points.length > 0,
                actions: assign({
                  draft: ({ context }) => {
                    const points = context.draft.points.slice(0, -1)
                    const undone = context.draft.points[context.draft.points.length - 1]!
                    return { ...context.draft, points, redo: [...context.draft.redo, undone] }
                  },
                }),
              },
              REDO_POINT: {
                guard: ({ context }) => context.draft.redo.length > 0,
                actions: assign({
                  draft: ({ context }) => {
                    const redo = context.draft.redo.slice(0, -1)
                    const restored = context.draft.redo[context.draft.redo.length - 1]!
                    return { ...context.draft, points: [...context.draft.points, restored], redo }
                  },
                }),
              },
              COMMIT: { target: 'committing', guard: 'canCommit' },
            },
          },
          committing: {
            invoke: {
              src: 'commitMeasurement',
              input: ({ context }) => ({ context }),
              onDone: { target: '#takeoffSession.idle', actions: 'clearDraftPoints' },
              onError: {
                target: 'placing',
                actions: assign({
                  error: ({ event }) =>
                    event.error instanceof Error ? event.error.message : 'failed to save measurement',
                }),
              },
            },
          },
        },
      },

      calibrating: {
        initial: 'placing',
        on: {
          CANCEL: 'idle',
        },
        states: {
          placing: {
            on: {
              PLACE_SCALE_POINT: {
                actions: assign({
                  calibration: ({ context, event }) => {
                    // Two points max; a third click restarts the reference line.
                    const points =
                      context.calibration.points.length >= 2
                        ? [event.point]
                        : [...context.calibration.points, event.point]
                    return { ...context.calibration, points }
                  },
                }),
              },
              SET_SCALE_LENGTH: {
                actions: assign({
                  calibration: ({ context, event }) => ({
                    ...context.calibration,
                    lengthText: event.lengthText,
                    unit: event.unit ?? context.calibration.unit,
                  }),
                }),
              },
              APPLY_CALIBRATION: { target: 'applying', guard: 'scaleReady' },
            },
          },
          applying: {
            invoke: {
              src: 'calibratePage',
              input: ({ context }) => ({ context }),
              onDone: { target: '#takeoffSession.idle' },
              onError: {
                target: 'placing',
                actions: assign({
                  error: ({ event }) => (event.error instanceof Error ? event.error.message : 'failed to calibrate'),
                }),
              },
            },
          },
        },
      },

      selecting: {
        initial: 'browsing',
        on: {
          CANCEL: { target: 'idle', actions: assign({ selection: () => defaultSelection() }) },
          SELECT_MEASUREMENT: {
            actions: assign({
              selection: ({ context, event }) => ({
                ...context.selection,
                selectedId: event.measurementId,
                bulkIds: [],
              }),
            }),
          },
          BULK_SELECT: {
            actions: assign({
              selection: ({ context, event }) => ({
                ...context.selection,
                bulkIds: event.ids,
                selectedId: event.ids.length === 1 ? event.ids[0]! : null,
              }),
            }),
          },
          CLEAR_SELECTION: { actions: assign({ selection: () => defaultSelection() }) },
          START_REASSIGN: {
            actions: assign({ selection: ({ context, event }) => ({ ...context.selection, reassignIds: event.ids }) }),
          },
        },
        states: {
          browsing: {
            on: {
              START_EDIT_GEOM: {
                target: 'editingVertex',
                actions: assign({
                  selection: ({ context, event }) => ({
                    ...context.selection,
                    editGeomId: event.measurementId,
                    editPoints: event.points,
                  }),
                }),
              },
              OPEN_COPY: 'copying',
            },
          },
          editingVertex: {
            on: {
              DRAG_VERTEX: {
                actions: assign({
                  selection: ({ context, event }) => {
                    const editPoints = (context.selection.editPoints ?? []).map((p, i) =>
                      i === event.index ? event.point : p,
                    )
                    return { ...context.selection, editPoints }
                  },
                }),
              },
              APPLY_EDIT: {
                target: 'browsing',
                actions: assign({
                  selection: ({ context }) => ({ ...context.selection, editGeomId: null, editPoints: null }),
                }),
              },
              CANCEL: {
                target: 'browsing',
                actions: assign({
                  selection: ({ context }) => ({ ...context.selection, editGeomId: null, editPoints: null }),
                }),
              },
            },
          },
          copying: {
            on: {
              APPLY_COPY: 'browsing',
              CANCEL: 'browsing',
            },
          },
        },
      },

      capturing: {
        initial: 'configuring',
        on: {
          CANCEL: { target: 'idle', actions: assign({ capture: () => defaultCapture() }) },
        },
        states: {
          configuring: {
            on: {
              RUN_CAPTURE: 'running',
            },
          },
          running: {
            invoke: {
              src: 'runCapture',
              input: ({ context }) => ({ context }),
              onDone: {
                target: 'reviewing',
                actions: assign({
                  // The output's mode/draftId are the server-resolved honesty
                  // signals — adopt them when present so the review overlay's
                  // LIVE/DEMO chip reflects what actually ran.
                  capture: ({ context, event }) => ({
                    ...context.capture,
                    result: event.output.result,
                    mode: event.output.mode ?? context.capture.mode,
                    draftId: event.output.draftId ?? context.capture.draftId,
                  }),
                }),
              },
              onError: {
                target: 'configuring',
                actions: assign({
                  error: ({ event }) => (event.error instanceof Error ? event.error.message : 'capture failed'),
                }),
              },
            },
          },
          reviewing: {
            on: {
              REVIEW_DECISION: {
                actions: assign({
                  capture: ({ context, event }) => ({
                    ...context.capture,
                    decisions: { ...context.capture.decisions, [event.quantityId]: event.decision },
                  }),
                }),
              },
              TOGGLE_SHOW_LOW: {
                actions: assign({
                  capture: ({ context }) => ({ ...context.capture, showLow: !context.capture.showLow }),
                }),
              },
              PROMOTE: 'promoting',
            },
          },
          promoting: {
            invoke: {
              src: 'promoteCaptured',
              input: ({ context, event }) => {
                if (event.type !== 'PROMOTE') throw new Error('promoting entered without PROMOTE')
                return { context, quantityIds: event.quantityIds }
              },
              onDone: { target: '#takeoffSession.idle', actions: assign({ capture: () => defaultCapture() }) },
              onError: {
                target: 'reviewing',
                actions: assign({
                  error: ({ event }) => (event.error instanceof Error ? event.error.message : 'promote failed'),
                }),
              },
            },
          },
        },
      },
    },
  })
}

export type TakeoffSessionMachine = ReturnType<typeof createTakeoffSessionMachine>
export type TakeoffSessionActor = Actor<TakeoffSessionMachine>
export type TakeoffSessionSnapshot = SnapshotFrom<TakeoffSessionMachine>

/** A seed: the state value to boot into + a partial context to merge. */
export interface TakeoffSessionSeed {
  value?: StateValue
  context: BuildTakeoffSessionContextInput
}

/**
 * Boot a session actor straight into an arbitrary state — the testability seam.
 * Uses xstate `resolveState` rehydration, so NO entry actions / actors fire
 * (seeding is side-effect free). Used by unit tests and the dev scenario-jump
 * affordance to land the canvas in e.g. `{ drawing: 'placing' }` with 3 points
 * already placed, or `{ capturing: 'reviewing' }` with a result loaded.
 */
export function takeoffSessionSeedActor(machine: TakeoffSessionMachine, seed: TakeoffSessionSeed): TakeoffSessionActor {
  const context = buildTakeoffSessionContext(seed.context)
  const snapshot = machine.resolveState({ value: seed.value ?? 'idle', context })
  // `input` is required by the actor types even though the resolved snapshot
  // supplies the context at runtime (rehydration path — input is not re-applied).
  return createActor(machine, { snapshot, input: seed.context })
}

// ────────────────────────────────────────────────────────────────────────────
// React hook (co-located, house style). Deps are injected so the screen wires
// real lib/api-backed implementations; defaults stay unwired until that lands.
// ────────────────────────────────────────────────────────────────────────────

export interface UseTakeoffSessionOptions {
  projectId: string
  companySlug: string
  blueprintId?: string | null
  pageId?: string | null
  draftId?: string | null
  deps?: TakeoffSessionDeps
  /**
   * Dev/test-only boot-into-a-named-state seam. When provided, the machine is
   * rehydrated straight into `seed.value` with `seed.context` merged over the
   * defaults — the canvas lands mid-draw / in AI review / etc. with no clicks.
   * NO entry actions/actors fire (xstate `resolveState` rehydration), so the
   * `loading → idle` load actor is skipped and the seeded state is authoritative.
   * Callers gate this behind `import.meta.env.MODE !== 'production'`.
   */
  seed?: TakeoffSessionSeed | null
}

export function useTakeoffSession(options: UseTakeoffSessionOptions) {
  const machine = useMemo(() => createTakeoffSessionMachine(options.deps ?? unwiredTakeoffSessionDeps), [options.deps])
  // A seed is a ONE-TIME boot snapshot, captured on first render: a later
  // re-render (or the seed object identity changing) must never rehydrate the
  // live machine out from under the user mid-session.
  const seedRef = useRef(options.seed)
  const initialSnapshot = useMemo(() => {
    const seed = seedRef.current
    if (!seed) return undefined
    return machine.resolveState({ value: seed.value ?? 'idle', context: buildTakeoffSessionContext(seed.context) })
    // resolveState is pure; the machine identity is stable for the deps lifetime.
  }, [machine])
  const [state, send] = useMachine(machine, {
    ...(initialSnapshot ? { snapshot: initialSnapshot } : {}),
    input: {
      projectId: options.projectId,
      companySlug: options.companySlug,
      blueprintId: options.blueprintId ?? null,
      pageId: options.pageId ?? null,
      draftId: options.draftId ?? null,
    },
  })

  const dispatch = useCallback((event: TakeoffSessionEvent) => send(event), [send])
  const mode = (typeof state.value === 'string' ? state.value : Object.keys(state.value)[0]) as TakeoffMode

  return {
    mode,
    value: state.value,
    context: state.context,
    matches: state.matches,
    can: state.can,
    draftQuantity: draftQuantity(state.context),
    canCommit: canCommitDraft(state.context),
    scaleReady: isScaleReady(state.context),
    dispatch,
  }
}
