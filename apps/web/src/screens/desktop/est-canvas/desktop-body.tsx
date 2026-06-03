import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  calculateLinealLengthScaled,
  calculatePolygonAreaScaled,
  calculatePolygonCentroid,
  slopeFactor,
  type PitchDriver,
  type TakeoffPoint,
} from '@sitelayer/domain'
import {
  ApiError,
  useBlueprintPages,
  useCalibratePage,
  useCreateMeasurement,
  useDeleteMeasurement,
  usePatchMeasurement,
  useProjectBlueprints,
  useProjectMeasurements,
  useServiceItems,
  useTakeoffDrafts,
  useUploadBlueprint,
  type BlueprintDocument,
  type BlueprintPage,
  type MeasurementGeometry,
  type ServiceItem,
  type TakeoffDraft,
  type TakeoffMeasurement,
} from '@/lib/api'
import {
  useConditions,
  useCreateCondition,
  type ConditionMeasurementKind,
  type TakeoffCondition,
} from '@/lib/api/conditions'
import { useAuthenticatedObjectUrl } from '@/lib/api/blob-url'
import { currentCaptureRoutePath } from '@/lib/capture-session'
import { registerCaptureArtifactProvider } from '@/lib/capture-artifact-providers'
// Phase B responsive consolidation: the AI setup panels moved into the merged
// responsive screens (former desktop twins est-ai-count.tsx / est-ai-takeoff.tsx
// were deleted). The standalone float-palette exports are unchanged.
import { EstAiCountSetupPanel } from '../../mobile/takeoff-ai-count'
import { EstAiTakeoffSetupPanel } from '../../mobile/takeoff-ai-takeoff'
import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { buildCanvasGeometryArtifact, uploadCanvasGeometryArtifact } from '@/lib/takeoff/canvas-geometry-artifact'
import { arcPolyline } from '@/lib/takeoff/arc'
import { clamp, round2, screenToBoardPoint } from '@/lib/takeoff/canvas-math'
import { useSnapping, resolveDraftPoint } from '@/lib/takeoff/snapping'
import { useCanvasViewport } from '@/lib/takeoff/use-canvas-viewport'
import { buildDuplicateGeometries, type CopyPlan, type MirrorAxis } from '@/lib/takeoff/copy-transform'
import { buildScopeTotals, formatQty } from '@/lib/takeoff/canvas-totals'
import { detectSheetScale, type DetectedScale } from '@/lib/takeoff/sheet-scale'
import { solveWorldScale, type WorldScale } from '@/lib/takeoff/world-scale'
import { PdfPageCanvas, usePdfDocument } from '@/lib/pdf/pdf-page-canvas'
import { useRole } from '@/lib/role'

import { MButton, MPill, MSelect } from '@/components/m'

import { DEmptyState } from '@/components/d'

import { type Tool, type CanvasMode, type SheetCallout } from './types'
import { BLUEPRINT_UPLOAD_ACCEPT, MAX_POLYGON_POINTS, SHEET_CALLOUTS, pitchInputStyle, ghostChip } from './constants'
import { floatBox, floatHead } from './desktop-body-styles'
import { EstCanvasDesktopLoading } from './desktop-loading'
import { AssemblyAttachPanel } from './assembly-panel'
import { AiReviewOverlay, AiReviewMarkers, buildAiReviewModel } from './ai-review-overlay'
import { ToolPalette } from './tool-palette'
import { ViewPalette } from './view-palette'
import { AiAssistPalette } from './ai-assist-palette'
import { SheetsPanel } from './sheets-panel'
import { TopStrip } from './top-strip'
import { ScaleOverlay } from './scale-overlay'
import { ItemPalette } from './item-palette'
import { CopyPanel } from './copy-panel'

import { useTakeoffSession } from '@/machines/takeoff-session'
import { resolveTakeoffSeed, TAKEOFF_SEED_NAMES } from '@/machines/takeoff-session-seeds'

// Desktop command-center takeoff body — extracted verbatim from est-canvas.tsx
// (behavior preserved). Mounted by TakeoffCanvas at/above the 1024px gate.

// Desktop capability body — the full-bleed floating-palette command-center
// takeoff editor. Phase C: rendered by the responsive `TakeoffCanvas` wrapper
// (bottom of file) at the lg: / desktop capability; the phone form factor
// renders `TakeoffCanvasMobileBody` instead. Both share the 0–100 board space,
// the `@sitelayer/domain` geometry, and the data hooks, so rows are
// interchangeable across form factors.
export function EstCanvasDesktopBody() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? ''
  // Desktop resolves the company from the request layer (no companySlug prop);
  // the machine context only uses it for identity, so an empty slug is fine.
  const companySlug = ''

  // --- Session machine (CORE canvas state owner) ----------------------------
  // The `takeoff-session` statechart is the single source of truth for the
  // CORE command-center slices on desktop: `tool` + in-progress draft `points`
  // (+ redo), the two-point `calibration` slice (scale points + typed length),
  // and the committed-measurement `selection` (single / marquee bulk / reassign
  // / vertex-edit). Reads come off `session.context.draft` / `.calibration` /
  // `.selection`; writes dispatch machine events. Everything the machine does
  // NOT model stays local (hybrid): blueprint/page selection, upload, the AI
  // setup panels, copy/array/mirror panel, conditions form, sheet callouts,
  // pitch/deduct/snap toggles, toasts, and the `useCanvasViewport` pan/zoom
  // capability. The dep actors stay unwired — COMMIT / calibrate / edit / etc.
  // persist via the EXISTING TanStack-Query mutation hooks, then dispatch the
  // matching machine event to reset the UI slice (so behavior is identical and
  // the async actor wiring is a clean follow-up rather than a risky rewrite).
  //
  // `?seed=<name>` (dev/test only) boots the machine straight into a named
  // state via resolveTakeoffSeed — a tester lands mid-polygon-draw / scale /
  // select with no clicks. Never honored in production.
  const seedName = searchParams.get('seed')
  const initialSeed = useMemo(() => {
    if (!seedName || import.meta.env.MODE === 'production') return null
    if (!(TAKEOFF_SEED_NAMES as readonly string[]).includes(seedName)) return null
    return resolveTakeoffSeed(seedName, { projectId, companySlug, blueprintId: null, pageId: null, draftId: null })
    // Captured ONCE at mount (empty deps); the live blueprint/page/draft picker
    // re-syncs ids below. (react-hooks/exhaustive-deps is not enabled here.)
  }, [])

  const session = useTakeoffSession({ projectId, companySlug, seed: initialSeed })
  const { context: sctx, dispatch: sdispatch } = session

  // --- Drafts (reuse mobile data layer; default to active/first) -----------
  const drafts = useTakeoffDrafts(projectId)
  const draftList = useMemo(() => drafts.data?.drafts ?? [], [drafts.data])
  const activeDraft: TakeoffDraft | null = draftList.find((d) => d.status === 'active') ?? draftList[0] ?? null
  const activeDraftId = activeDraft?.id ?? null

  // --- Blueprints + pages ---------------------------------------------------
  const blueprints = useProjectBlueprints(projectId)
  const blueprintList = useMemo(
    () => (blueprints.data?.blueprints ?? []).filter((b) => !b.deleted_at),
    [blueprints.data],
  )
  const [blueprintId, setBlueprintId] = useState<string | null>(null)
  const activeBlueprint: BlueprintDocument | null =
    blueprintList.find((b) => b.id === blueprintId) ?? blueprintList[0] ?? null

  // --- Blueprint upload (admin/foreman/office only) -------------------------
  const role = useRole()
  const canUploadBlueprint = role === 'owner' || role === 'foreman'
  const uploadBlueprint = useUploadBlueprint(projectId)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const onPickBlueprintFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    // Reset the input so re-picking the same file fires `change` again.
    e.target.value = ''
    if (!file) return
    setUploadError(null)
    uploadBlueprint.mutate(file, {
      onSuccess: (doc) => {
        // Refetch happens via the hook's invalidate; auto-select the new
        // document so the canvas immediately underlays it.
        setBlueprintId(doc.id)
        setPageId(null)
        void blueprints.refetch()
      },
      onError: (err) => setUploadError(err instanceof Error ? err.message : 'Upload failed'),
    })
  }

  const blueprintPages = useBlueprintPages(activeBlueprint?.id)
  const pages = useMemo(() => blueprintPages.data?.pages ?? [], [blueprintPages.data])
  const [pageId, setPageId] = useState<string | null>(null)
  const activePage: BlueprintPage | null = pages.find((p) => p.id === pageId) ?? pages[0] ?? null

  const blueprintReference = useMemo(
    () => buildBlueprintReference(activeBlueprint, activePage),
    [activeBlueprint, activePage],
  )
  const sourceImage = useAuthenticatedObjectUrl(blueprintReference?.texturePath)

  // Phase 1: render the ORIGINAL PDF via PDFium for crisp vector zoom instead of
  // the server-rasterized page PNG. ON by default now that the drawing surface
  // (large-sheet cap, snapping, undo/redo, on-canvas dimensions) is in place;
  // set localStorage['sitelayer.pdf_engine'] = 'image' to fall back to the
  // rasterized PNG. Non-PDF blueprints and the still-loading window also fall
  // back to the image path.
  const pdfEngineOn = typeof window !== 'undefined' && window.localStorage?.getItem('sitelayer.pdf_engine') !== 'image'
  const blueprintIsPdf = (activeBlueprint?.file_name ?? '').toLowerCase().endsWith('.pdf')
  const pdfDocUrl = useAuthenticatedObjectUrl(
    pdfEngineOn && blueprintIsPdf && activeBlueprint
      ? `/api/blueprints/${encodeURIComponent(activeBlueprint.id)}/file`
      : null,
  )
  const pdfDocState = usePdfDocument(pdfDocUrl.url ?? null)

  // Auto-scale: when a PDF page is open, read its extracted text and detect the
  // title-block drawing scale (1/4" = 1'-0", 1" = 20', ...). Surfaced read-only
  // as a hint — it does not change measurement quantities (board→world
  // calibration is a separate piece of work).
  const [detectedScale, setDetectedScale] = useState<DetectedScale | null>(null)
  const activePageNumber = activePage?.page_number ?? 1
  useEffect(() => {
    const doc = pdfDocState.doc
    if (!doc?.getPageText) {
      setDetectedScale(null)
      return
    }
    let cancelled = false
    setDetectedScale(null)
    void doc
      .getPageText(activePageNumber)
      .then((txt) => {
        if (!cancelled) setDetectedScale(detectSheetScale(txt))
      })
      .catch(() => {
        if (!cancelled) setDetectedScale(null)
      })
    return () => {
      cancelled = true
    }
  }, [pdfDocState.doc, activePageNumber])

  // Page size in PDF points (isotropic) — needed to turn the anisotropic 0–100
  // board space + the page's two-point calibration into a real-world per-axis
  // scale, so saved measurements carry true sqft/lf instead of board area.
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const doc = pdfDocState.doc
    if (!doc?.getPageSize) {
      setPageSize(null)
      return
    }
    let cancelled = false
    setPageSize(null)
    void doc
      .getPageSize(activePageNumber)
      .then((size) => {
        if (!cancelled && size) setPageSize({ width: size.width, height: size.height })
      })
      .catch(() => {
        if (!cancelled) setPageSize(null)
      })
    return () => {
      cancelled = true
    }
  }, [pdfDocState.doc, activePageNumber])

  // Per-axis real-world scale for the active page (null when uncalibrated or the
  // page size is unknown → measurements stay in board space, as before).
  const worldScale: WorldScale | null = useMemo(
    () => solveWorldScale(activePage, pageSize?.width, pageSize?.height),
    [activePage, pageSize],
  )

  // Auto-Bookmark (Phase 0): read the PDF's embedded bookmarks/page labels so the
  // estimator can jump straight to a sheet (Plans, Elevations, …) instead of
  // paging through a 20–80 page set.
  const [bookmarks, setBookmarks] = useState<Array<{ title: string; pageNumber: number }>>([])
  useEffect(() => {
    const doc = pdfDocState.doc
    if (!doc?.getBookmarks) {
      setBookmarks([])
      return
    }
    let cancelled = false
    setBookmarks([])
    void doc
      .getBookmarks()
      .then((nodes) => {
        if (cancelled) return
        const flat: Array<{ title: string; pageNumber: number }> = []
        const walk = (list: typeof nodes) => {
          for (const n of list) {
            if (typeof n.pageNumber === 'number') flat.push({ title: n.title, pageNumber: n.pageNumber })
            if (n.children) walk(n.children)
          }
        }
        walk(nodes)
        setBookmarks(flat)
      })
      .catch(() => {
        if (!cancelled) setBookmarks([])
      })
    return () => {
      cancelled = true
    }
  }, [pdfDocState.doc])

  // --- Measurements ---------------------------------------------------------
  const measurements = useProjectMeasurements(projectId, { draftId: activeDraftId })
  const create = useCreateMeasurement(projectId)
  const removeMeasurement = useDeleteMeasurement()
  const patchMeasurement = usePatchMeasurement()
  const serviceItems = useServiceItems()
  const items = useMemo(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])
  // Condition layer (Deep Dive H1). The list powers the picker + legend; the
  // create hook backs the inline "+ New" form. Additive — when no condition is
  // active, measurements save exactly as before (condition_id null).
  const conditionsQuery = useConditions()
  const conditions = useMemo(() => conditionsQuery.data?.conditions ?? [], [conditionsQuery.data])
  const createCondition = useCreateCondition()

  // --- Entry state (identical semantics to mobile draw mode) ----------------
  // `tool` is the machine draft tool, narrowed to the desktop `Tool` union
  // (the machine adds `volume`, which the desktop surface never selects).
  const tool = sctx.draft.tool as Tool
  // SET_TOOL resets the in-progress draft points in the machine (the old
  // setDraftPoints([]) is now implicit). Keep the draw surface live so the
  // next tap places a point.
  const setTool = (next: Tool) => {
    sdispatch({ type: 'SET_TOOL', tool: next })
    if (session.matches('idle')) sdispatch({ type: 'START_DRAW' })
  }
  const [serviceItemCode, setServiceItemCode] = useState('')
  // Which division performs this scope item (Cavy, WhatsApp:227-229). An item
  // can be curated to several divisions (e.g. EPS under EIFS, or under a
  // different division on a non-EIFS job); the picker below lets the estimator
  // choose. Defaults to the item's first curated division.
  const [divisionCode, setDivisionCode] = useState('')
  // The in-progress draft vertices live in the machine. `setDraftPoints`
  // keeps the useState setter shape (value | updater) the call sites use:
  // an EMPTY/whole-replacement set re-enters drawing (CANCEL drops points →
  // START_DRAW), a single append is a PLACE_POINT, and a one-vertex pop is
  // an UNDO_POINT, so the machine's draft slice stays authoritative.
  const draftPoints = sctx.draft.points
  const setDraftPoints = (next: TakeoffPoint[] | ((prev: TakeoffPoint[]) => TakeoffPoint[])) => {
    const value = typeof next === 'function' ? next(draftPoints) : next
    if (value.length === 0) {
      // Clear the in-progress draft while staying on the draw surface.
      sdispatch({ type: 'CANCEL' })
      sdispatch({ type: 'START_DRAW' })
      return
    }
    if (value.length === draftPoints.length + 1) {
      // A single appended point (the tap path) → PLACE_POINT.
      if (session.matches('idle')) sdispatch({ type: 'START_DRAW' })
      sdispatch({ type: 'PLACE_POINT', point: value[value.length - 1]! })
      return
    }
    if (value.length === draftPoints.length - 1) {
      // A single popped point (undo path) → UNDO_POINT.
      sdispatch({ type: 'UNDO_POINT' })
      return
    }
    // A whole-set replacement (RECT box → 4 corners, ARC tessellation). Reset
    // then place each vertex so the machine ends with exactly `value`.
    sdispatch({ type: 'CANCEL' })
    sdispatch({ type: 'START_DRAW' })
    for (const p of value) sdispatch({ type: 'PLACE_POINT', point: p })
  }
  const [error, setError] = useState<string | null>(null)
  const [savedToast, setSavedToast] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // --- Zoom + pan (canvas navigation) --------------------------------------
  // Phase C: the PlanSwift-style pan/zoom navigation layer now lives in the
  // shared `useCanvasViewport` capability hook (cursor-anchored wheel zoom,
  // drag-to-pan via middle/right button + Space-hold + Hand tool, fit/reset).
  // Desktop turns it ON; the responsive mobile body leaves it off. Re-attach the
  // wheel listener once the canvas mounts (loading early-return nulls the ref).
  const viewport = useCanvasViewport(true, [drafts.isLoading, blueprints.isLoading])
  const { containerRef, zoom, pan, handMode, setHandMode, spaceHeld, panning, zoomBy, resetView } = viewport

  // --- Canvas interaction states (Desktop v2 mockup ports) -----------------
  // `mode` ('draw' | 'scale' | 'select' | 'ai-count' | 'ai-takeoff') has no
  // clean 1:1 with the machine's exclusive modes — ai-count/ai-takeoff are
  // overlay-panel launchers that don't drive draft/calibration/selection — so
  // it stays a thin local notion. A sync effect (below) parks the machine in
  // the matching mode: draw→drawing, scale→calibrating, select→selecting, the
  // AI overlays→idle. Lazy-init from the boot snapshot so a `?seed=` lands on
  // the right tab WITHOUT the sync effect cancelling the seeded slice on mount.
  const [mode, setMode] = useState<CanvasMode>(() =>
    session.matches('calibrating') ? 'scale' : session.matches('selecting') ? 'select' : 'draw',
  )
  // Scale-calibration overlay (DCanvasScale): the real-world length the user
  // types for the reference line they drew. Provisional until applied. Lives
  // in the machine's calibration slice (lengthText); the SET_SCALE_LENGTH
  // event only lands in `calibrating`, so the typed value is mirrored locally
  // for editing and pushed to the machine while in scale mode.
  const scaleLength = sctx.calibration.lengthText || '24'
  const setScaleLength = (next: string) => sdispatch({ type: 'SET_SCALE_LENGTH', lengthText: next })
  // The two board-space reference points live in the machine's calibration
  // slice. `setScalePoints` keeps the useState setter shape: a single appended
  // point (or a third click that restarts the pair) is a PLACE_SCALE_POINT;
  // an empty set restarts calibration.
  const scalePoints = sctx.calibration.points
  const setScalePoints = (next: TakeoffPoint[] | ((prev: TakeoffPoint[]) => TakeoffPoint[])) => {
    const value = typeof next === 'function' ? next(scalePoints) : next
    if (value.length === 0) {
      sdispatch({ type: 'START_CALIBRATION' })
      return
    }
    // The call site only ever appends/restarts a single point at a time
    // (prev.length >= 2 ? [p] : [...prev, p]); PLACE_SCALE_POINT models both
    // (two-max, a third click restarts the line).
    if (!session.matches('calibrating')) sdispatch({ type: 'START_CALIBRATION' })
    sdispatch({ type: 'PLACE_SCALE_POINT', point: value[value.length - 1]! })
  }
  const [scaleError, setScaleError] = useState<string | null>(null)
  const calibratePage = useCalibratePage()
  // Item command-palette (DCanvasItemPalette): "/"-triggered scope-item picker.
  const [itemPaletteOpen, setItemPaletteOpen] = useState(false)
  const [itemQuery, setItemQuery] = useState('')
  // Selection slices all live in the machine's `selection` slice. When set,
  // the next item picked in the palette REASSIGNS these committed measurements
  // instead of setting the draft item (REASSIGN actions). The machine's
  // START_REASSIGN sets `reassignIds` (and is scoped to `selecting`, preserving
  // selectedId/bulkIds); clearing reassign-only sends START_REASSIGN with [] so
  // the marquee selection survives a palette-Escape (the old behavior). When
  // not in `selecting` (e.g. the draw-mode "/" affordance) there is nothing to
  // clear and the event is a no-op. A `[]` reassignIds reads as "not pending"
  // (applyItemPick guards on `length > 0`).
  const reassignIds = sctx.selection.reassignIds
  const setReassignIds = (next: string[] | null) => {
    sdispatch({ type: 'START_REASSIGN', ids: next ?? [] })
  }
  // Edit popover (DCanvasEditMeasure): the single committed measurement that
  // is currently selected for reassign / duplicate / delete (machine
  // selection.selectedId — mirrored by BULK_SELECT when the set lands at size
  // 1, so the desktop never single-selects through a standalone setter).
  const selectedMeasurementId = sctx.selection.selectedId
  // Bulk-select toolbar (DCanvasBulkSelect): the set of measurements picked
  // while in marquee/select mode. The machine holds `bulkIds` as an array; the
  // desktop reads it as a Set and `setBulkSelected` mirrors the useState setter
  // shape (value | updater) by funneling through BULK_SELECT.
  const bulkSelected = useMemo(() => new Set(sctx.selection.bulkIds), [sctx.selection.bulkIds])
  const setBulkSelected = (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const value = typeof next === 'function' ? next(new Set(sctx.selection.bulkIds)) : next
    sdispatch({ type: 'BULK_SELECT', ids: Array.from(value) })
  }
  // Interactive vertex-drag edit (dsg__48 "EDIT MEASUREMENT"). When EDIT GEOM
  // is engaged on a single selected measurement, its committed vertices become
  // draggable handles. `editGeomId` is the measurement under edit; `editPoints`
  // is the working (unsaved) point set; `editDragIdx` is the vertex currently
  // being dragged. Both live in the machine's selection slice; dropping a
  // vertex PATCHes the new geometry (server recomputes the quantity) — no
  // redraw-from-scratch round trip.
  const editGeomId = sctx.selection.editGeomId
  const editPoints = sctx.selection.editPoints ?? []
  const editDragIdxRef = useRef<number | null>(null)
  // Redo stack for draft points (PlanSwift-style undo/redo) lives in the
  // machine's draft.redo slice. UNDO pushes the popped vertex there (handled by
  // the draft setters / UNDO_POINT), REDO pops it back. Any new vertex / tool
  // change / save clears it (you can't redo into a diverged draft).
  const redoStack = sctx.draft.redo
  // Vertex + ortho snapping toggle. When on, a tapped point snaps to a nearby
  // existing vertex or locks to horizontal/vertical from the previous point —
  // the precision PlanSwift drawing-surface behaviour. Persisted per-operator.
  const [snapEnabled, setSnapEnabled] = useState(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem('sitelayer.snap') !== 'off' : true,
  )
  // Cutout/deduct mode (polygon only): when on, the next saved polygon is a
  // deduction (window/door opening) whose area subtracts from the net for its
  // service item. Sticky so several openings can be cut in a row.
  const [deduct, setDeduct] = useState(false)

  // Pitch / slope driver (H2) for area + lineal takeoff. Empty ⇒ flat/vertical
  // (slope factor 1.0, unchanged). When set to a valid rise:run the next saved
  // measurement carries `pitch` inside its JSONB geometry and the server applies
  // `√(rise²+run²)/run` to the scaled quantity. Sticky across saves like deduct.
  const [pitchRise, setPitchRise] = useState('')
  const [pitchRun, setPitchRun] = useState('12')

  // Condition layer (Deep Dive H1) — the reusable typed template the next draw
  // is made against. NULL = legacy shape-first flow (the existing tag/service-
  // item path is untouched and remains the fallback). `conditionFormOpen`
  // toggles the inline create form; the three fields back a minimal create.
  const [activeConditionId, setActiveConditionId] = useState<string | null>(null)
  const [conditionFormOpen, setConditionFormOpen] = useState(false)
  const [newConditionName, setNewConditionName] = useState('')
  const [newConditionColor, setNewConditionColor] = useState('#2f7d32')
  const [newConditionKind, setNewConditionKind] = useState<ConditionMeasurementKind>('area')
  const activeCondition = useMemo<TakeoffCondition | null>(
    () => conditions.find((c) => c.id === activeConditionId) ?? null,
    [conditions, activeConditionId],
  )

  // Copy / array / mirror tools (deep-dive gap H6 — repeated bays/typicals).
  // When a selection exists in SELECT mode, a small toolbar group lets the
  // estimator duplicate the selected measurement(s) by a board-space offset,
  // array them N-up along a row/grid, or mirror/rotate the copies. Each copy is
  // saved as a NEW measurement via the existing `useCreateMeasurement` path, so
  // quantities recompute server-side just like a hand-drawn shape. `copyOpen`
  // toggles the parameter panel; the rest hold the user's chosen plan.
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyDx, setCopyDx] = useState('6')
  const [copyDy, setCopyDy] = useState('0')
  const [copyCount, setCopyCount] = useState('3')
  const [copyMirror, setCopyMirror] = useState<MirrorAxis | 'none'>('none')
  const [copyRotate, setCopyRotate] = useState('0')
  const [copyBusy, setCopyBusy] = useState(false)

  // Cross-sheet callout jump (dsg__50). `showCallouts` toggles the callout
  // markers over the sheet; `jumpedFrom` remembers the sheet we jumped FROM so
  // the "JUMPED FROM …" panel can offer a one-click RETURN. The callouts are
  // only meaningful in draw mode (they overlay the takeoff surface).
  const [showCallouts, setShowCallouts] = useState(false)
  const [jumpedFrom, setJumpedFrom] = useState<{ pageId: string; label: string } | null>(null)

  // --- On-canvas AI review (capturing.reviewing) ---------------------------
  // "AI proposes, human ratifies ON the plan." When the machine is in
  // `capturing.reviewing` (reachable in dev via `?seed=ai-reviewing`) the
  // editable review surface renders: a synced LIST panel (`AiReviewOverlay`) +
  // canvas markers (`AiReviewMarkers`) for proposals that carry geometry. The
  // overlay is strictly gated to this state, so the draw / scale / select
  // surfaces are untouched. `reviewSelectedId` is the LOCAL shared selection
  // that syncs the list row ↔ canvas marker (clicking either highlights both);
  // the machine already owns the authoritative `capture.decisions` / `showLow`.
  const isReviewing = session.matches({ capturing: 'reviewing' })
  const isPromoting = session.matches({ capturing: 'promoting' })
  const [reviewSelectedId, setReviewSelectedId] = useState<string | null>(null)
  // Build the marker view-model off the same machine slices the overlay reads,
  // so the list and the canvas markers stay in lockstep (same bucketing,
  // ordering, and show-low filter). Cheap; only meaningful while reviewing.
  const reviewModel = useMemo(
    () => buildAiReviewModel(sctx.capture.result, sctx.capture.decisions, sctx.capture.showLow),
    [sctx.capture.result, sctx.capture.decisions, sctx.capture.showLow],
  )

  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

  // Park the machine in the mode that matches the canvas surface: 'draw' →
  // `drawing` (so PLACE_POINT lands), 'scale' → `calibrating` (so the two-point
  // calibration events land), 'select' → `selecting` (so the edit/copy
  // sub-states are reachable). The AI overlays ('ai-count' / 'ai-takeoff')
  // don't drive any machine slice, so they park the machine in `idle`.
  //
  // The START_* entries are all only valid from `idle`, so a cross-mode flip
  // (e.g. select → draw) must CANCEL back to idle FIRST. xstate processes both
  // events synchronously in this tick, so CANCEL → idle → START_DRAW → drawing
  // lands in one pass.
  //
  // SCOPE GUARD: `capturing` (configuring/running/reviewing/promoting) is a
  // MACHINE-driven mode with no local `CanvasMode` peer — a `?seed=ai-reviewing`
  // boots straight into `capturing.reviewing`. The sync effect must NOT CANCEL
  // out of it (that would tear down the AI-review overlay on mount), so it
  // no-ops while the machine is capturing. Re-running on `sessionValue` re-parks
  // the surface once review ends (CANCEL/PROMOTE → idle → draw).
  const sessionValue = session.value
  const target =
    mode === 'draw' ? 'drawing' : mode === 'scale' ? 'calibrating' : mode === 'select' ? 'selecting' : 'idle'
  useEffect(() => {
    if (session.matches('capturing')) return
    if (session.matches(target)) return
    if (!session.matches('idle')) sdispatch({ type: 'CANCEL' })
    if (target === 'drawing') sdispatch({ type: 'START_DRAW' })
    else if (target === 'calibrating') sdispatch({ type: 'START_CALIBRATION' })
    else if (target === 'selecting') sdispatch({ type: 'START_SELECT' })
    // target === 'idle' → the CANCEL above already landed us there.
  }, [mode, sessionValue])

  // Mirror the scope item into the machine draft so its commit guard + future
  // wired actors see the same scope the UI persists with. (react-hooks/
  // exhaustive-deps is not enabled here — mirror on scope change only.)
  useEffect(() => {
    if (serviceItemCode && sctx.draft.serviceItemCode !== serviceItemCode) {
      sdispatch({ type: 'SET_SERVICE_ITEM', serviceItemCode })
    }
  }, [serviceItemCode])

  const selectedItem = items.find((i) => i.code === serviceItemCode) ?? null
  // Keep the chosen division valid for the selected item — reset to its first
  // curated division whenever the current choice isn't one of the item's.
  useEffect(() => {
    const divs = selectedItem?.divisions ?? []
    setDivisionCode((cur) => (divs.includes(cur) ? cur : (divs[0] ?? '')))
  }, [selectedItem])
  // Area tools (freeform polygon + drag rectangle) share square-foot semantics;
  // lineal-like tools (freeform lineal + 3-point arc) share linear-foot length.
  const isAreaTool = tool === 'polygon' || tool === 'rect'
  const isLinealLike = tool === 'lineal' || tool === 'arc'
  const unitForItem = selectedItem?.unit ?? (isAreaTool ? 'sqft' : isLinealLike ? 'lf' : 'ea')

  // The 3-point arc draft (start, through, end). Tessellated into a lineal
  // polyline for length/render/save once all three control points are placed.
  const arcCurve = useMemo(() => {
    if (tool !== 'arc' || draftPoints.length !== 3) return null
    const [a, b, c] = draftPoints
    return a && b && c ? arcPolyline(a, b, c) : null
  }, [tool, draftPoints])

  // Pitch / slope driver (H2). A valid rise:run yields a `PitchDriver`; an empty
  // or non-positive run is treated as flat (null ⇒ slope factor 1.0). Pitch only
  // applies to sloped-surface tools (area + lineal/arc), never to counts.
  const activePitch = useMemo<PitchDriver | null>(() => {
    const rise = Number(pitchRise)
    const run = Number(pitchRun)
    if (!Number.isFinite(rise) || !Number.isFinite(run)) return null
    if (rise <= 0 || run <= 0) return null
    return { rise, run }
  }, [pitchRise, pitchRun])
  const pitchAppliesToTool = tool === 'polygon' || tool === 'rect' || tool === 'lineal' || tool === 'arc'
  const pitchFactor = pitchAppliesToTool ? slopeFactor(activePitch) : 1
  // On-canvas audit suffix (deep-dive H2: "show the multiplier on the canvas
  // label"). Only shown when pitch is actually multiplying the quantity (> 1).
  const pitchLabel =
    activePitch && pitchFactor > 1 ? ` ×${round2(pitchFactor)} (${activePitch.rise}:${activePitch.run})` : ''

  // --- Geometry (unchanged from mobile) ------------------------------------
  const draftQuantity = useMemo(() => {
    // Mirror the server's quantity math: when the page is calibrated, the live
    // running quantity reads in real sqft/lf, not board-space units. The optional
    // pitch slope-factor is the 4th arg (default 1.0 ⇒ flat ⇒ legacy behavior).
    const wx = worldScale?.wx ?? 1
    const wy = worldScale?.wy ?? 1
    if (tool === 'polygon' || tool === 'rect')
      return round2(calculatePolygonAreaScaled(draftPoints, wx, wy, pitchFactor))
    if (tool === 'lineal') return round2(calculateLinealLengthScaled(draftPoints, wx, wy, pitchFactor))
    if (tool === 'arc') return arcCurve ? round2(calculateLinealLengthScaled(arcCurve, wx, wy, pitchFactor)) : 0
    return draftPoints.length
  }, [tool, draftPoints, arcCurve, worldScale, pitchFactor])

  // Screen→board mapping uses the shared `screenToBoardPoint` CTM transform
  // (`@/lib/takeoff/canvas-math`), the same one the mobile + projects canvases use.
  const onCanvasTap = (e: ReactPointerEvent<SVGSVGElement>) => {
    // In select/scale mode the canvas tap is not a draft-point append: select
    // mode tapping empty space clears the marquee selection; scale mode lets
    // the calibration overlay drive instead. Only draw mode appends points.
    if (mode !== 'draw') {
      if (mode === 'select') {
        // BULK_SELECT([]) clears bulkIds AND selectedId in one event.
        setBulkSelected(new Set())
      } else if (mode === 'scale') {
        // SCALE mode: click two points of a known dimension to define the
        // reference line. A third click restarts the pair.
        const svg = svgRef.current
        if (!svg) return
        const local = screenToBoardPoint(svg, e.clientX, e.clientY)
        if (!local) return
        const p = { x: round2(clamp(local.x, 0, 100)), y: round2(clamp(local.y, 0, 100)) }
        setScaleError(null)
        setScalePoints((prev) => (prev.length >= 2 ? [p] : [...prev, p]))
      }
      return
    }
    const svg = svgRef.current
    if (!svg) return
    if (tool === 'polygon' && draftPoints.length >= MAX_POLYGON_POINTS) return
    if (tool === 'arc' && draftPoints.length >= 3) return // arc = exactly 3 control points
    const local = screenToBoardPoint(svg, e.clientX, e.clientY)
    if (!local) return
    const snapped = snapPoint({ x: clamp(local.x, 0, 100), y: clamp(local.y, 0, 100) })
    // PLACE_POINT (via setDraftPoints' append path) clears draft.redo itself.
    setDraftPoints((prev) => [...prev, { x: round2(snapped.x), y: round2(snapped.y) }])
  }

  // Persist the drawn reference line as the page calibration. The two board
  // points + the typed real-world length flow through the same calibrate API
  // the mobile overlay uses; once saved, `worldScale` recomputes and new
  // measurements carry true sqft/lf.
  const applyScale = async () => {
    setScaleError(null)
    if (!activePage) {
      setScaleError('Open a sheet page first.')
      return
    }
    if (scalePoints.length < 2) {
      setScaleError('Click two points of a known dimension on the sheet.')
      return
    }
    const [a, b] = scalePoints as [TakeoffPoint, TakeoffPoint]
    if (a.x === b.x && a.y === b.y) {
      setScaleError('The two points must be distinct.')
      return
    }
    const dist = Number(scaleLength)
    if (!Number.isFinite(dist) || dist <= 0) {
      setScaleError('Enter the line’s real-world length (ft).')
      return
    }
    try {
      await calibratePage.mutateAsync({
        pageId: activePage.id,
        world_distance: dist,
        world_unit: 'ft',
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      })
      // APPLY_CALIBRATION-equivalent UI reset through the machine: the page
      // calibration already persisted above via the existing calibratePage
      // hook (hybrid dep wiring — the machine's calibratePage actor stays
      // unwired). setScalePoints([]) re-enters calibration with an empty point
      // set; switching to draw mode then parks the machine in `drawing`.
      setScalePoints([])
      setMode('draw')
    } catch (err) {
      setScaleError(err instanceof Error ? err.message : 'Could not save the scale.')
    }
  }

  // --- Zoom + pan (PlanSwift-style canvas navigation) ----------------------
  // The drawing math relies on svg.getScreenCTM(), which already folds in the
  // CSS transform on the zoom wrapper below — so a click still maps to the
  // correct 0–100 board point at any zoom/pan. The zoom/pan/space/hand/wheel
  // machinery itself moved to the shared `useCanvasViewport` hook above; the
  // pan-drag begin/move/end helpers are consumed in the pointer handlers below.

  // Escape dismisses the Scale-calibration overlay. The scale box is a
  // hand-rolled float div that bypasses the shared DModal/DDrawer
  // `useEscapeClose` behavior, so it needs its own Escape handler to stay
  // consistent with every other overlay in desktop-v2.
  useEffect(() => {
    if (mode !== 'scale' && mode !== 'ai-count' && mode !== 'ai-takeoff') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode('draw')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  // Map a screen point to 0–100 board space (same CTM the tap path uses).
  const clientToBoard = (clientX: number, clientY: number): TakeoffPoint | null => {
    const svg = svgRef.current
    if (!svg) return null
    const local = screenToBoardPoint(svg, clientX, clientY)
    if (!local) return null
    return { x: clamp(local.x, 0, 100), y: clamp(local.y, 0, 100) }
  }

  // Box/marquee (RECT tool): drag a rectangle in draw mode. The start corner is
  // held in a ref; boxRect drives the live preview and becomes a 4-point draft
  // polygon on pointer-up (so the normal area save / quantity / deduct flow
  // applies unchanged).
  const boxStartRef = useRef<TakeoffPoint | null>(null)
  const [boxRect, setBoxRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // Marquee (SELECT mode): drag a rubber-band rectangle to lasso every committed
  // measurement it encloses (design dsg__49 "MARQUEE BULK SELECT"). Distinct from
  // the RECT draw-tool box above so the two never interfere.
  const marqueeStartRef = useRef<TakeoffPoint | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const onPointerDownCanvas = (e: ReactPointerEvent<SVGSVGElement>) => {
    // Middle-button, RIGHT-button (PlanSwift-style drag-to-move the plan, per
    // Cavy's request), Space-hold, or the Hand tool pans instead of drawing.
    // A matching onContextMenu suppresses the browser menu so a right-drag pans.
    // The pan gesture lives in the shared `useCanvasViewport` capability.
    if (e.button === 1 || e.button === 2 || spaceHeld || handMode) {
      e.preventDefault()
      viewport.beginPan(e)
      return
    }
    if (mode === 'draw' && tool === 'rect') {
      const p = clientToBoard(e.clientX, e.clientY)
      if (p) {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        boxStartRef.current = p
        setBoxRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
        // CANCEL→START_DRAW (via setDraftPoints' empty path) also clears redo.
        setDraftPoints([])
      }
      return
    }
    if (mode === 'select' && editGeomId) {
      // While editing a measurement's geometry, a background pointer-down must
      // not start a marquee (that would wipe the edit). The vertex handles own
      // their own pointer-down; the background is inert here.
      return
    }
    if (mode === 'select') {
      // Begin a marquee. A real drag lassos enclosed measurements on pointer-up;
      // a zero-drag falls through to onCanvasTap (clears the selection).
      const p = clientToBoard(e.clientX, e.clientY)
      if (p) {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        marqueeStartRef.current = p
        setMarqueeRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }
      return
    }
    onCanvasTap(e)
  }
  const onPointerMoveCanvas = (e: ReactPointerEvent<SVGSVGElement>) => {
    // Vertex drag (EDIT GEOM): move the active handle to the cursor in board
    // space. Takes priority over every other gesture while a handle is held.
    const dragIdx = editDragIdxRef.current
    if (dragIdx !== null) {
      const p = clientToBoard(e.clientX, e.clientY)
      if (p) sdispatch({ type: 'DRAG_VERTEX', index: dragIdx, point: { x: p.x, y: p.y } })
      return
    }
    const boxStart = boxStartRef.current
    if (boxStart) {
      const p = clientToBoard(e.clientX, e.clientY)
      if (p) setBoxRect({ x0: boxStart.x, y0: boxStart.y, x1: p.x, y1: p.y })
      return
    }
    const marqueeStart = marqueeStartRef.current
    if (marqueeStart) {
      const p = clientToBoard(e.clientX, e.clientY)
      if (p) setMarqueeRect({ x0: marqueeStart.x, y0: marqueeStart.y, x1: p.x, y1: p.y })
      return
    }
    viewport.movePan(e.clientX, e.clientY)
  }
  const onPointerUpCanvas = (e: ReactPointerEvent<SVGSVGElement>) => {
    // End a vertex drag: release the handle but keep the working point set so
    // the user can drag more vertices before committing via the action bar.
    if (editDragIdxRef.current !== null) {
      editDragIdxRef.current = null
      e.currentTarget.releasePointerCapture?.(e.pointerId)
      return
    }
    if (marqueeStartRef.current) {
      marqueeStartRef.current = null
      e.currentTarget.releasePointerCapture?.(e.pointerId)
      const r = marqueeRect
      setMarqueeRect(null)
      if (r) {
        const x0 = Math.min(r.x0, r.x1)
        const y0 = Math.min(r.y0, r.y1)
        const x1 = Math.max(r.x0, r.x1)
        const y1 = Math.max(r.y0, r.y1)
        // A real drag lassos every committed measurement fully inside the box;
        // a negligible drag is a click → clear the current selection.
        if (x1 - x0 > 0.5 && y1 - y0 > 0.5) {
          const inside = new Set<string>()
          for (const m of blueprintMeasurements) {
            const geo = m.geometry as MeasurementGeometry
            const pts = geo.points ?? []
            if (pts.length > 0 && pts.every((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)) {
              inside.add(m.id)
            }
          }
          // BULK_SELECT mirrors selectedId to the lone id when size === 1
          // (else null) — the same rule the old explicit set encoded.
          setBulkSelected(inside)
        } else {
          setBulkSelected(new Set())
        }
      }
      return
    }
    if (boxStartRef.current) {
      boxStartRef.current = null
      e.currentTarget.releasePointerCapture?.(e.pointerId)
      const r = boxRect
      if (r) {
        const x0 = Math.min(r.x0, r.x1)
        const y0 = Math.min(r.y0, r.y1)
        const x1 = Math.max(r.x0, r.x1)
        const y1 = Math.max(r.y0, r.y1)
        // Ignore an accidental click / sliver — needs real area to be a takeoff.
        if (x1 - x0 > 0.5 && y1 - y0 > 0.5) {
          setDraftPoints([
            { x: round2(x0), y: round2(y0) },
            { x: round2(x1), y: round2(y0) },
            { x: round2(x1), y: round2(y1) },
            { x: round2(x0), y: round2(y1) },
          ])
        }
      }
      setBoxRect(null)
      return
    }
    viewport.endPan(e)
  }

  const minPoints = tool === 'polygon' || tool === 'rect' ? 3 : tool === 'arc' ? 3 : tool === 'lineal' ? 2 : 1
  const canSave = !create.isPending && Boolean(serviceItemCode) && draftQuantity > 0 && draftPoints.length >= minPoints

  const onSave = async () => {
    if (!canSave) return
    setError(null)
    setSavedToast(null)
    try {
      let geometry: MeasurementGeometry
      // When the page is calibrated, stamp the per-axis world scale so the
      // server computes true sqft/lf (board-space stays the fallback).
      const scale =
        worldScale && (tool === 'polygon' || tool === 'rect' || tool === 'arc' || tool === 'lineal')
          ? { world_per_board_x: worldScale.wx, world_per_board_y: worldScale.wy }
          : {}
      // Pitch (H2): stamp the rise:run driver inside the JSONB geometry (no
      // column) for sloped-surface tools when a valid pitch is set. The server's
      // `calculateGeometryQuantity` applies the slope factor; flat ⇒ omitted.
      const pitch = pitchAppliesToTool && activePitch ? { pitch: activePitch } : {}
      // RECT produces a polygon; ARC tessellates its 3 control points into a
      // lineal polyline. Both reuse the existing geometry kinds — no new model.
      if (tool === 'polygon' || tool === 'rect') geometry = { kind: 'polygon', points: draftPoints, ...scale, ...pitch }
      else if (tool === 'arc') geometry = { kind: 'lineal', points: arcCurve ?? draftPoints, ...scale, ...pitch }
      else if (tool === 'lineal') geometry = { kind: 'lineal', points: draftPoints, ...scale, ...pitch }
      else geometry = { kind: 'count', points: draftPoints }
      const res = await create.mutateAsync({
        blueprint_document_id: activeBlueprint?.id ?? null,
        page_id: activePage?.id ?? null,
        service_item_code: serviceItemCode,
        // Carry the item's own curated division (e.g. Air Barrier → D5) so the
        // measurement passes the catalog guard instead of falling back to the
        // project division and 422ing. Supports multi-division projects too.
        division_code: divisionCode || selectedItem?.divisions?.[0] || null,
        unit: unitForItem,
        geometry,
        // Cutout/deduct only applies to area (polygon / rect) takeoff.
        is_deduction: isAreaTool && deduct,
        draft_id: activeDraftId,
        // Condition layer (Deep Dive H1): stamp the active condition when one
        // is picked. NULL keeps the legacy shape-first behavior unchanged.
        condition_id: activeConditionId,
      })
      // COMMIT-equivalent UI reset through the machine: persistence already
      // happened above via the existing create hook (hybrid dep wiring). The
      // empty setDraftPoints path (CANCEL→START_DRAW) also clears draft.redo.
      setDraftPoints([])
      setSavedToast(
        'queued' in res && res.queued
          ? 'Saved offline — will sync when you reconnect.'
          : `Added ${formatQty(draftQuantity)} ${unitForItem} of ${serviceItemCode}.`,
      )
    } catch (e) {
      // Surface the server's human-readable reason (e.g. the catalog rejection
      // "service item not in curated catalog for any division") instead of the
      // raw `POST …/measurement → 422` ApiError.message.
      setError(e instanceof ApiError ? e.message_for_user() : e instanceof Error ? e.message : 'Save failed')
    }
  }

  // Condition layer (Deep Dive H1): create a condition from the inline form and
  // make it active for the next draw. Minimal — name + color + measurement_kind
  // (drivers + default assembly are PATCH-able later, deeper flow flagged as a
  // follow-up). Errors surface in the same inline error slot as draws.
  const onCreateCondition = async () => {
    const name = newConditionName.trim()
    if (!name) {
      setError('Condition name is required')
      return
    }
    setError(null)
    try {
      const res = await createCondition.mutateAsync({
        name,
        color: newConditionColor,
        measurement_kind: newConditionKind,
      })
      setActiveConditionId(res.condition.id)
      setNewConditionName('')
      setConditionFormOpen(false)
      setSavedToast(`Condition “${res.condition.name}” ready — draws will tag it.`)
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message_for_user() : e instanceof Error ? e.message : 'Create condition failed',
      )
    }
  }

  const draftMeasurements = measurements.data?.measurements ?? []
  const blueprintMeasurements = draftMeasurements.filter(
    (m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id,
  )

  useEffect(() => {
    if (!projectId) return
    return registerCaptureArtifactProvider(`takeoff:desktop:${projectId}`, async ({ captureSessionId, metadata }) => {
      if (!activeBlueprint && blueprintMeasurements.length === 0 && draftPoints.length === 0) return null
      const payload = buildCanvasGeometryArtifact({
        project_id: projectId,
        route_path: currentCaptureRoutePath(),
        active_draft_id: activeDraftId,
        active_blueprint_id: activeBlueprint?.id ?? null,
        active_page_id: activePage?.id ?? null,
        blueprint: activeBlueprint,
        page: activePage,
        viewport: { zoom, pan, mode, tool },
        draft: {
          points: draftPoints,
          quantity: draftQuantity,
          scale_points: scalePoints,
          edit_geom_id: editGeomId,
          edit_points: editPoints,
        },
        selection: {
          selected_measurement_id: selectedMeasurementId,
          bulk_selected_ids: Array.from(bulkSelected),
          reassign_ids: reassignIds,
        },
        measurements: blueprintMeasurements,
      })
      return uploadCanvasGeometryArtifact(captureSessionId, payload, {
        ...metadata,
        surface: 'desktop_est_canvas',
      })
    })
  }, [
    activeBlueprint,
    activeDraftId,
    activePage,
    blueprintMeasurements,
    bulkSelected,
    draftPoints,
    draftQuantity,
    editGeomId,
    editPoints,
    mode,
    pan,
    projectId,
    reassignIds,
    scalePoints,
    selectedMeasurementId,
    tool,
    zoom,
  ])

  // Snap-to-content index over every committed measurement on this sheet:
  // endpoints, segment midpoints, and on-segment projections. This is the
  // shared engine (`@/lib/takeoff/snapping`) that supersedes the old
  // vertex-only snap — a new measurement now latches to the corner, the middle,
  // OR anywhere along an existing wall, not just its drawn vertices. Memoized
  // so a per-tap `snapToContent` call doesn't rebuild candidates each time.
  const snapIndex = useSnapping(blueprintMeasurements)

  // Tolerance for snap-to-content, in board units (0–100 space). Sits in the
  // 1.5–2.0 sweet spot: tight enough that a deliberate gap survives, loose
  // enough that an estimator aiming at a corner reliably latches onto it.
  const SNAP_TOLERANCE_BOARD = 1.8
  // Angular threshold for the ortho ("straight wall") assist, in degrees.
  const ORTHO_THRESHOLD_DEG = 7

  // Snap a raw board-space point via the shared resolver: latch onto committed
  // geometry (endpoint > midpoint > on-segment), else a nearby in-progress
  // draft vertex (so a polygon closes onto its own start — the engine only sees
  // committed measurements), else lock to H / V / 45° from the previous draft
  // point. With snap OFF the raw point passes through unchanged.
  const snapPoint = (raw: TakeoffPoint): TakeoffPoint => {
    if (!snapEnabled) return raw
    return resolveDraftPoint(raw, snapIndex, {
      toleranceBoard: SNAP_TOLERANCE_BOARD,
      orthoThresholdDeg: ORTHO_THRESHOLD_DEG,
      draftPoints,
    })
  }

  // Undo/redo over draft vertices is now owned by the machine: UNDO_POINT pops
  // the last point and stashes it in draft.redo, REDO_POINT replays it. Both
  // are only accepted in `drawing.placing`, so enter the draw surface first if
  // a seed/idle left us elsewhere.
  const undoPoint = () => {
    if (draftPoints.length === 0) return
    sdispatch({ type: 'UNDO_POINT' })
  }
  const redoPoint = () => {
    if (redoStack.length === 0) return
    if (session.matches('idle')) sdispatch({ type: 'START_DRAW' })
    sdispatch({ type: 'REDO_POINT' })
  }
  const totals = useMemo(() => buildScopeTotals(draftMeasurements), [draftMeasurements])
  const grandTotal = totals.reduce((s, t) => s + t.quantity, 0)

  // Condition legend (Deep Dive H1): per-condition drawn-count + summed
  // quantity over the current draft, ordered like the picker. Only conditions
  // with at least one drawn measurement appear, so the legacy (unlinked) draws
  // simply don't show here — they stay in Running quantities above.
  const conditionLegend = useMemo(() => {
    const counts = new Map<string, { count: number; quantity: number }>()
    for (const m of draftMeasurements) {
      if (!m.condition_id) continue
      const prev = counts.get(m.condition_id) ?? { count: 0, quantity: 0 }
      prev.count += 1
      prev.quantity += Number(m.quantity) || 0
      counts.set(m.condition_id, prev)
    }
    return conditions.filter((c) => counts.has(c.id)).map((c) => ({ condition: c, ...counts.get(c.id)! }))
  }, [draftMeasurements, conditions])

  // --- Selection derivations for the edit popover + bulk-select toolbar -----
  const selectedMeasurement = useMemo(
    () => blueprintMeasurements.find((m) => m.id === selectedMeasurementId) ?? null,
    [blueprintMeasurements, selectedMeasurementId],
  )
  const selectedIndex = selectedMeasurement
    ? blueprintMeasurements.findIndex((m) => m.id === selectedMeasurement.id)
    : -1
  const bulkRows = useMemo(
    () => blueprintMeasurements.filter((m) => bulkSelected.has(m.id)),
    [blueprintMeasurements, bulkSelected],
  )
  const bulkTotal = useMemo(() => round2(bulkRows.reduce((s, m) => s + (Number(m.quantity) || 0), 0)), [bulkRows])

  // Provisional drawing-scale ratio for the SCALE overlay (design dsg__46
  // "= 1:48 ● PROVISIONAL"). While the estimator draws the reference line and
  // types its real-world length, derive the paper:world ratio N in "1:N" form
  // from the line's length in page points (1pt = 1/72") vs the typed feet.
  // Returns null until both endpoints + a positive length are present, or when
  // the page size is unknown.
  const provisionalRatio = useMemo<number | null>(() => {
    if (scalePoints.length < 2 || !pageSize) return null
    const [a, b] = scalePoints as [TakeoffPoint, TakeoffPoint]
    const feet = Number(scaleLength)
    if (!Number.isFinite(feet) || feet <= 0) return null
    // Board space (0–100) maps anisotropically onto the page: board-x → width,
    // board-y → height. Convert the drawn line into page points, then inches.
    const dxPts = ((b.x - a.x) / 100) * pageSize.width
    const dyPts = ((b.y - a.y) / 100) * pageSize.height
    const paperInches = Math.hypot(dxPts, dyPts) / 72
    if (paperInches <= 0) return null
    const ratio = (feet * 12) / paperInches
    return Number.isFinite(ratio) && ratio > 0 ? Math.round(ratio) : null
  }, [scalePoints, scaleLength, pageSize])

  // --- Cross-sheet callout jump (dsg__50) ----------------------------------
  // Resolve a callout against the REAL page list (clamped) so a jump opens an
  // actual sheet even though the callout coordinates are presentational.
  const calloutTargetPage = (c: SheetCallout): BlueprintPage | null => {
    if (pages.length === 0) return null
    return pages[Math.min(c.targetPageIdx, pages.length - 1)] ?? null
  }
  const calloutTargetLabel = (c: SheetCallout): string => {
    const tp = calloutTargetPage(c)
    return tp ? `pg ${tp.page_number}` : `A-50${c.targetPageIdx}`
  }
  const currentSheetLabel = (): string =>
    activePage ? `pg ${activePage.page_number}` : (activeBlueprint?.file_name ?? 'sheet')
  // Jump to the referenced sheet, remembering where we came from for RETURN.
  const jumpToCallout = (c: SheetCallout) => {
    const tp = calloutTargetPage(c)
    if (!tp || tp.id === activePage?.id) return
    if (activePage) setJumpedFrom({ pageId: activePage.id, label: currentSheetLabel() })
    setPageId(tp.id)
  }
  const returnFromJump = () => {
    if (!jumpedFrom) return
    setPageId(jumpedFrom.pageId)
    setJumpedFrom(null)
  }

  // Item command-palette: filter the scope items by the typed query.
  const paletteItems = useMemo(() => {
    const q = itemQuery.trim().toLowerCase()
    const list = q ? items.filter((it) => `${it.code} ${it.name}`.toLowerCase().includes(q)) : items
    return list.slice(0, 6)
  }, [items, itemQuery])

  // Toggle a committed measurement into the bulk set. Exactly-one selected
  // shows the single-edit action bar (DCanvasEditMeasure); two-or-more shows
  // the marquee bulk toolbar (DCanvasBulkSelect). `selectedMeasurementId`
  // mirrors the single case so the polygon highlight + edit bar share state.
  const onMeasurementClick = (id: string) => {
    if (mode !== 'select') return
    // Toggle membership; BULK_SELECT mirrors selectedId to the lone id when the
    // set lands at size 1 (else null), so the single-edit bar shares state.
    const next = new Set(bulkSelected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setBulkSelected(next)
  }

  // In SELECT mode a pointer-down that lands on a measurement must NOT start a
  // canvas marquee — let the shape's own click toggle it instead. Stopping
  // propagation here keeps click-to-toggle and drag-to-marquee from colliding.
  const onShapePointerDown = (e: ReactPointerEvent<SVGElement>) => {
    if (mode === 'select') e.stopPropagation()
  }

  const clearSelection = () => {
    // CLEAR_SELECTION resets the whole machine selection slice (selectedId +
    // bulkIds + reassignIds + editGeomId + editPoints) in one go.
    sdispatch({ type: 'CLEAR_SELECTION' })
    editDragIdxRef.current = null
    setCopyOpen(false)
  }

  // Real delete (was a no-op that only cleared the highlight).
  const onDeleteSelected = () => {
    if (!selectedMeasurement) return
    removeMeasurement.mutate({ id: selectedMeasurement.id })
    clearSelection()
  }
  const onBulkDelete = () => {
    const count = bulkSelected.size
    if (count === 0) return
    // Bulk delete is destructive and (unlike single delete) can wipe many
    // measurements at once — confirm before removing. Matches the discard-draft
    // confirm pattern already used in this file.
    if (!window.confirm(`Delete ${count} ${count === 1 ? 'measurement' : 'measurements'}?`)) return
    for (const id of bulkSelected) removeMeasurement.mutate({ id })
    clearSelection()
  }

  // Real duplicate (was a no-op): copy the geometry shifted a few board units
  // so the clone is visibly offset, keeping the same item/unit + sheet.
  const onDuplicateSelected = async () => {
    if (!selectedMeasurement) return
    const geo = selectedMeasurement.geometry as MeasurementGeometry
    const points = geo.points?.map((p) => ({ x: round2(clamp(p.x + 3, 0, 100)), y: round2(clamp(p.y + 3, 0, 100)) }))
    if (!points) return
    await create.mutateAsync({
      blueprint_document_id: activeBlueprint?.id ?? null,
      page_id: activePage?.id ?? null,
      service_item_code: selectedMeasurement.service_item_code,
      unit: selectedMeasurement.unit,
      geometry: { ...geo, points } as MeasurementGeometry,
      draft_id: activeDraftId,
    })
    clearSelection()
  }

  // --- Copy / array / mirror (deep-dive H6) --------------------------------
  // The measurements a copy plan acts on: the marquee bulk set when several are
  // selected, otherwise the single selected measurement. Only point-based
  // geometries (polygon / lineal / count) are copyable in board space; the
  // toolbar is suppressed when none of the selection qualifies.
  const copyTargets = useMemo<TakeoffMeasurement[]>(() => {
    if (bulkRows.length > 0) return bulkRows
    return selectedMeasurement ? [selectedMeasurement] : []
  }, [bulkRows, selectedMeasurement])
  const copyableTargets = useMemo(
    () => copyTargets.filter((m) => Array.isArray((m.geometry as MeasurementGeometry).points)),
    [copyTargets],
  )

  // Build the chosen CopyPlan from the panel inputs. Mirror/rotate ride along
  // as per-copy modifiers; an array of count>1 lays the copies along the row,
  // otherwise it is a single offset copy.
  const buildCopyPlan = (mode: CopyPlan['mode']): CopyPlan => {
    const dx = Number(copyDx)
    const dy = Number(copyDy)
    const count = Math.max(1, Math.floor(Number(copyCount) || 1))
    const rotateDeg = Number(copyRotate) || 0
    return {
      mode,
      delta: { dx: Number.isFinite(dx) ? dx : 0, dy: Number.isFinite(dy) ? dy : 0 },
      count,
      ...(copyMirror === 'none' ? {} : { mirror: copyMirror }),
      rotateDeg,
    }
  }

  // Run a copy plan: for each copyable selected measurement, generate the
  // duplicate geometries (board-space transforms) and save each as a NEW
  // measurement via the existing create path — same scope/unit/sheet/deduct, so
  // quantities recompute server-side. Sequential to keep the optimistic-queue
  // and 30-req/min API budget calm; the selection is cleared on completion.
  const runCopyPlan = async (mode: CopyPlan['mode']) => {
    if (copyableTargets.length === 0 || copyBusy) return
    const plan = buildCopyPlan(mode)
    setError(null)
    setCopyBusy(true)
    let made = 0
    try {
      for (const m of copyableTargets) {
        const geo = m.geometry as MeasurementGeometry
        const dupes = buildDuplicateGeometries(geo, plan)
        for (const dupe of dupes) {
          await create.mutateAsync({
            blueprint_document_id: m.blueprint_document_id ?? activeBlueprint?.id ?? null,
            page_id: m.page_id ?? activePage?.id ?? null,
            service_item_code: m.service_item_code,
            unit: m.unit,
            elevation: m.elevation ?? null,
            geometry: dupe as MeasurementGeometry,
            is_deduction: m.is_deduction ?? false,
            draft_id: activeDraftId,
          })
          made += 1
        }
      }
      setSavedToast(made > 0 ? `Copied ${made} measurement${made === 1 ? '' : 's'}.` : 'Nothing to copy.')
      setCopyOpen(false)
      clearSelection()
    } catch (e) {
      setError(e instanceof ApiError ? e.message_for_user() : e instanceof Error ? e.message : 'Copy failed')
    } finally {
      setCopyBusy(false)
    }
  }

  // Interactive "edit geometry" (dsg__48): engage in-place vertex drag on the
  // selected measurement. Its existing vertices become draggable handles; the
  // shape is edited live and re-priced on drop (see commitEditGeom). Stays in
  // SELECT mode so the contextual bar remains anchored to this measurement.
  const onEditGeom = () => {
    if (!selectedMeasurement) return
    const geo = selectedMeasurement.geometry as MeasurementGeometry
    const pts = geo.points
    if (!pts || pts.length === 0) return
    // START_EDIT_GEOM seeds the working edit point set; while in `selecting`
    // the scoped handler also drives the editingVertex sub-state.
    sdispatch({
      type: 'START_EDIT_GEOM',
      measurementId: selectedMeasurement.id,
      points: pts.map((p) => ({ x: p.x, y: p.y })),
    })
  }

  const cancelEditGeom = () => {
    // APPLY_EDIT clears the working edit slice (editGeomId/editPoints). The
    // actual persist is the component's job (hybrid), so cancel and apply both
    // reduce to "drop the working edit set" at the machine level.
    sdispatch({ type: 'APPLY_EDIT' })
    editDragIdxRef.current = null
  }

  // Persist the dragged geometry. The PATCH route re-normalizes the points and
  // recomputes the quantity server-side, so the running total + price update
  // off the new shape. Carries the row's optimistic version (409 → bounce).
  const commitEditGeom = async () => {
    const target = editGeomId ? blueprintMeasurements.find((m) => m.id === editGeomId) : null
    if (!target || editPoints.length === 0) {
      cancelEditGeom()
      return
    }
    const geo = target.geometry as MeasurementGeometry
    const nextPoints = editPoints.map((p) => ({ x: round2(p.x), y: round2(p.y) }))
    setError(null)
    try {
      await patchMeasurement.mutateAsync({
        id: target.id,
        geometry: { ...geo, points: nextPoints },
        expected_version: target.version,
      })
      setSavedToast('Geometry updated — quantity re-priced.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message_for_user() : e instanceof Error ? e.message : 'Edit failed')
    } finally {
      cancelEditGeom()
    }
  }

  // Item-palette pick: if a REASSIGN is pending, re-tag those committed
  // measurements; otherwise set the draft item for new geometry.
  const applyItemPick = (code: string) => {
    if (reassignIds && reassignIds.length > 0) {
      for (const id of reassignIds) {
        const m = blueprintMeasurements.find((mm) => mm.id === id)
        if (!m) continue
        patchMeasurement.mutate({ id, service_item_code: code, expected_version: m.version })
      }
      // clearSelection resets the whole selection slice, reassignIds included.
      clearSelection()
    } else {
      setServiceItemCode(code)
    }
    setItemPaletteOpen(false)
    setItemQuery('')
  }

  const loading = drafts.isLoading || blueprints.isLoading

  // ---- Loading state -------------------------------------------------------
  if (loading) {
    return <EstCanvasDesktopLoading />
  }

  const sheetLabel = activeBlueprint
    ? `${activeBlueprint.file_name}${activePage ? ` · pg ${activePage.page_number}` : ''}`
    : 'No drawing — grid only'

  const canvasCursor = panning ? 'grabbing' : handMode || spaceHeld ? 'grab' : 'crosshair'

  return (
    <div className="d-content-full" style={{ position: 'relative' }}>
      {/* Hidden blueprint file input — shared by the palette + empty-state
          upload buttons. Accepts PDF + images; the browser sets the
          multipart boundary on the FormData POST. */}
      {canUploadBlueprint ? (
        <input
          ref={fileInputRef}
          type="file"
          accept={BLUEPRINT_UPLOAD_ACCEPT}
          style={{ display: 'none' }}
          onChange={onPickBlueprintFile}
        />
      ) : null}

      {/* ---- Full-bleed SVG drawing surface (same board space as mobile) ----
          The container clips + owns the wheel/zoom listener; the inner wrapper
          carries the zoom/pan CSS transform so the blueprint image and the SVG
          overlay scale + pan together and stay mutually aligned. */}
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0, background: 'var(--m-ink-2)', overflow: 'hidden' }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transformOrigin: '0 0',
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            willChange: 'transform',
          }}
        >
          {pdfEngineOn && blueprintIsPdf ? (
            pdfDocState.doc ? (
              <PdfPageCanvas
                doc={pdfDocState.doc}
                pageNumber={activePage?.page_number ?? 1}
                // Render resolution tracks the canvas zoom so the page stays crisp
                // as you zoom in (vs a fixed raster). Quantized to integer steps to
                // avoid re-rendering on every wheel tick, and capped to bound memory.
                scale={Math.min(6, Math.max(2, Math.ceil(zoom) * 2))}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  opacity: 0.7,
                }}
              />
            ) : null
          ) : sourceImage.url ? (
            <img
              src={sourceImage.url}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                opacity: 0.7,
              }}
            />
          ) : null}
          <svg
            ref={svgRef}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            onPointerDown={onPointerDownCanvas}
            onPointerMove={onPointerMoveCanvas}
            onPointerUp={onPointerUpCanvas}
            onPointerCancel={onPointerUpCanvas}
            onContextMenu={(e) => e.preventDefault()}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              touchAction: 'none',
              cursor: canvasCursor,
            }}
          >
            <g aria-hidden="true">
              {/* Fine grid every 2 units */}
              {Array.from({ length: 51 }, (_, i) => (
                <line key={`fh${i}`} x1={0} x2={100} y1={i * 2} y2={i * 2} stroke="var(--m-ink-3)" strokeWidth={0.1} />
              ))}
              {Array.from({ length: 51 }, (_, i) => (
                <line key={`fv${i}`} x1={i * 2} x2={i * 2} y1={0} y2={100} stroke="var(--m-ink-3)" strokeWidth={0.1} />
              ))}
              {/* Coarse grid every 10 units */}
              {Array.from({ length: 11 }, (_, i) => (
                <line
                  key={`h${i}`}
                  x1={0}
                  x2={100}
                  y1={i * 10}
                  y2={i * 10}
                  stroke="var(--m-ink-4)"
                  strokeWidth={0.25}
                />
              ))}
              {Array.from({ length: 11 }, (_, i) => (
                <line
                  key={`v${i}`}
                  x1={i * 10}
                  x2={i * 10}
                  y1={0}
                  y2={100}
                  stroke="var(--m-ink-4)"
                  strokeWidth={0.25}
                />
              ))}
            </g>

            {/* Saved measurements on this blueprint (same render as mobile) */}
            {blueprintMeasurements.map((m) => {
              // The measurement under EDIT GEOM is replaced by the draggable
              // overlay below — skip its static render so the two don't fight.
              if (m.id === editGeomId) return null
              const geo = m.geometry as MeasurementGeometry
              // Selection state drives the highlight (edit popover = single,
              // bulk-select = many). Ported from DCanvasEditMeasure /
              // DCanvasBulkSelect; clickable only outside draw mode.
              const isSelected = m.id === selectedMeasurementId || bulkSelected.has(m.id)
              const interactive = mode !== 'draw'
              const onClick = interactive ? () => onMeasurementClick(m.id) : undefined
              const fillSel = isSelected ? 'rgba(255,212,0,0.45)' : 'rgba(217,144,74,0.18)'
              const strokeSel = isSelected ? 'var(--m-ink)' : 'var(--m-accent)'
              const strokeWSel = isSelected ? 0.7 : 0.4
              if (geo.kind === 'polygon' && geo.points && geo.points.length >= 3) {
                const c = calculatePolygonCentroid(geo.points)
                // Cutout/deduct measurements render in red with a "−" prefix on
                // the quantity so a deducted opening reads as a subtraction.
                const isDed = m.is_deduction === true
                const polyFill = isDed ? (isSelected ? 'rgba(214,69,69,0.4)' : 'rgba(214,69,69,0.16)') : fillSel
                const polyStroke = isDed ? 'var(--m-red)' : strokeSel
                const labelFill = isDed ? 'var(--m-red)' : 'var(--m-accent)'
                return (
                  <g
                    key={m.id}
                    onClick={onClick}
                    onPointerDown={onShapePointerDown}
                    style={{ cursor: interactive ? 'pointer' : undefined }}
                  >
                    <polygon
                      points={geo.points.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill={polyFill}
                      stroke={polyStroke}
                      strokeWidth={strokeWSel}
                      strokeDasharray={isDed ? '1.2 0.8' : undefined}
                    />
                    {c ? (
                      <text x={c.x} y={c.y} fontSize={3} textAnchor="middle" fill={labelFill} fontWeight={700}>
                        {isDed ? '−' : ''}
                        {formatQty(Number(m.quantity))}
                      </text>
                    ) : null}
                  </g>
                )
              }
              if (geo.kind === 'lineal' && geo.points && geo.points.length >= 2) {
                return (
                  <polyline
                    key={m.id}
                    onClick={onClick}
                    onPointerDown={onShapePointerDown}
                    style={{ cursor: interactive ? 'pointer' : undefined }}
                    points={geo.points.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke={strokeSel}
                    strokeWidth={isSelected ? 0.8 : 0.5}
                  />
                )
              }
              if (geo.kind === 'count' && geo.points) {
                return (
                  <g
                    key={m.id}
                    onClick={onClick}
                    onPointerDown={onShapePointerDown}
                    style={{ cursor: interactive ? 'pointer' : undefined }}
                  >
                    {geo.points.map((p, i) => (
                      <circle
                        key={i}
                        cx={p.x}
                        cy={p.y}
                        r={isSelected ? 1.1 : 0.8}
                        fill="var(--m-accent)"
                        stroke={isSelected ? 'var(--m-ink)' : undefined}
                        strokeWidth={isSelected ? 0.3 : undefined}
                      />
                    ))}
                  </g>
                )
              }
              return null
            })}

            {/* EDIT GEOM (dsg__48): live edited shape + draggable vertex handles
                for the measurement under edit. Drag a square handle to move that
                vertex; the dashed outline + live quantity track the drag, and the
                action bar's APPLY persists the new geometry (server re-prices). */}
            {editGeomId && editPoints.length > 0
              ? (() => {
                  const target = blueprintMeasurements.find((m) => m.id === editGeomId)
                  const geo = target?.geometry as MeasurementGeometry | undefined
                  const isLineal = geo?.kind === 'lineal'
                  const c = !isLineal && editPoints.length >= 3 ? calculatePolygonCentroid(editPoints) : null
                  const liveQty = isLineal
                    ? round2(calculateLinealLengthScaled(editPoints, worldScale?.wx ?? 1, worldScale?.wy ?? 1))
                    : round2(calculatePolygonAreaScaled(editPoints, worldScale?.wx ?? 1, worldScale?.wy ?? 1))
                  return (
                    <g>
                      {isLineal ? (
                        <polyline
                          points={editPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                          fill="none"
                          stroke="var(--m-accent)"
                          strokeWidth={0.6}
                          strokeDasharray="1.2 0.8"
                          pointerEvents="none"
                        />
                      ) : editPoints.length >= 3 ? (
                        <polygon
                          points={editPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                          fill="rgba(255,212,0,0.22)"
                          stroke="var(--m-ink)"
                          strokeWidth={0.6}
                          strokeDasharray="1.2 0.8"
                          pointerEvents="none"
                        />
                      ) : null}
                      {editPoints.map((p, i) => (
                        <rect
                          key={`eh${i}`}
                          x={p.x - 1.3}
                          y={p.y - 1.3}
                          width={2.6}
                          height={2.6}
                          fill="var(--m-accent)"
                          stroke="var(--m-ink)"
                          strokeWidth={0.4}
                          style={{ cursor: 'grab' }}
                          onPointerDown={(ev) => {
                            ev.stopPropagation()
                            editDragIdxRef.current = i
                            ev.currentTarget.ownerSVGElement?.setPointerCapture?.(ev.pointerId)
                            // Pointer capture must be on the element receiving the
                            // move events (the SVG root handles move/up), so capture
                            // there via the svg ref.
                            svgRef.current?.setPointerCapture?.(ev.pointerId)
                          }}
                        />
                      ))}
                      {c ? (
                        <text
                          x={c.x}
                          y={c.y}
                          fontSize={3}
                          textAnchor="middle"
                          fill="var(--m-ink)"
                          fontWeight={700}
                          pointerEvents="none"
                        >
                          {formatQty(liveQty)}
                        </text>
                      ) : null}
                    </g>
                  )
                })()
              : null}
            {/* Live box/marquee preview while dragging the RECT tool. */}
            {boxRect
              ? (() => {
                  const x0 = Math.min(boxRect.x0, boxRect.x1)
                  const y0 = Math.min(boxRect.y0, boxRect.y1)
                  const w = Math.abs(boxRect.x1 - boxRect.x0)
                  const h = Math.abs(boxRect.y1 - boxRect.y0)
                  return (
                    <rect
                      x={x0}
                      y={y0}
                      width={w}
                      height={h}
                      fill={deduct ? 'rgba(214,69,69,0.18)' : 'rgba(201,138,46,0.2)'}
                      stroke={deduct ? 'var(--m-red)' : 'var(--m-amber)'}
                      strokeWidth={0.4}
                      strokeDasharray="0.8 0.8"
                      pointerEvents="none"
                    />
                  )
                })()
              : null}
            {/* Live marquee rubber-band while dragging in SELECT mode (dsg__49):
                a dashed yellow rectangle that lassos enclosed measurements. */}
            {marqueeRect
              ? (() => {
                  const x0 = Math.min(marqueeRect.x0, marqueeRect.x1)
                  const y0 = Math.min(marqueeRect.y0, marqueeRect.y1)
                  const w = Math.abs(marqueeRect.x1 - marqueeRect.x0)
                  const h = Math.abs(marqueeRect.y1 - marqueeRect.y0)
                  return (
                    <rect
                      x={x0}
                      y={y0}
                      width={w}
                      height={h}
                      fill="rgba(255,212,0,0.08)"
                      stroke="var(--m-accent)"
                      strokeWidth={0.4}
                      strokeDasharray="1.2 0.8"
                      pointerEvents="none"
                    />
                  )
                })()
              : null}
            {/* Draft-in-progress (same render as mobile). In cutout/deduct mode
                the polygon draws in red to signal it will subtract. */}
            {isAreaTool && draftPoints.length >= 3 ? (
              <polygon
                points={draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                fill={deduct ? 'rgba(214,69,69,0.18)' : 'rgba(201,138,46,0.2)'}
                stroke={deduct ? 'var(--m-red)' : 'var(--m-amber)'}
                strokeWidth={0.4}
                strokeDasharray="0.8 0.8"
              />
            ) : null}
            {(tool === 'polygon' || tool === 'lineal') && draftPoints.length >= 2 ? (
              <polyline
                points={draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="var(--m-amber)"
                strokeWidth={0.5}
                strokeDasharray="0.8 0.8"
              />
            ) : null}
            {/* ARC preview: tessellated curve once 3 control points are set, a
                dashed straight hint before that. */}
            {tool === 'arc' && draftPoints.length >= 2 ? (
              <polyline
                points={(arcCurve ?? draftPoints).map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="var(--m-amber)"
                strokeWidth={0.5}
                strokeDasharray={arcCurve ? undefined : '0.8 0.8'}
              />
            ) : null}
            {draftPoints.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={tool === 'count' ? 1 : 0.8} fill="var(--m-amber)" />
            ))}
            {/* Cross-sheet callout markers (dsg__50): tappable detail-reference
                circles overlaid on the sheet. Only in draw mode, only when
                toggled on, only for a multi-page set (single sheets have no
                cross-references). Clicking jumps to the referenced page. */}
            {showCallouts && mode === 'draw' && pages.length > 1
              ? SHEET_CALLOUTS.map((c) => (
                  <g
                    key={`callout-${c.tag}`}
                    onClick={() => jumpToCallout(c)}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{ cursor: 'pointer' }}
                  >
                    <title>{`Jump to ${calloutTargetLabel(c)} · ${c.detail}`}</title>
                    <circle cx={c.x} cy={c.y} r={2.6} fill="var(--m-accent)" stroke="var(--m-ink)" strokeWidth={0.5} />
                    <text
                      x={c.x}
                      y={c.y + 0.9}
                      textAnchor="middle"
                      fontFamily="var(--m-num)"
                      fontSize={2.2}
                      fontWeight={800}
                      fill="var(--m-accent-ink)"
                      pointerEvents="none"
                    >
                      {c.tag}
                    </text>
                  </g>
                ))
              : null}
            {/* SCALE-mode reference line: the two known-dimension points. */}
            {mode === 'scale' && scalePoints.length >= 1 ? (
              <g pointerEvents="none">
                {scalePoints.length === 2 ? (
                  <line
                    x1={scalePoints[0]!.x}
                    y1={scalePoints[0]!.y}
                    x2={scalePoints[1]!.x}
                    y2={scalePoints[1]!.y}
                    stroke="var(--m-ink)"
                    strokeWidth={0.6}
                  />
                ) : null}
                {scalePoints.map((p, i) => (
                  <circle
                    key={`s${i}`}
                    cx={p.x}
                    cy={p.y}
                    r={1}
                    fill="var(--m-ink)"
                    stroke="var(--m-paper)"
                    strokeWidth={0.3}
                  />
                ))}
              </g>
            ) : null}
            {/* Live on-canvas dimension label — the running quantity rendered on
                the shape as you draw, same style as committed measurements. */}
            {isAreaTool && draftPoints.length >= 3
              ? (() => {
                  const c = calculatePolygonCentroid(draftPoints)
                  return c ? (
                    <text
                      x={c.x}
                      y={c.y}
                      fontSize={3}
                      textAnchor="middle"
                      fill={deduct ? 'var(--m-red)' : 'var(--m-amber)'}
                      fontWeight={700}
                      pointerEvents="none"
                    >
                      {deduct ? '−' : ''}
                      {formatQty(draftQuantity)} {unitForItem}
                      {pitchLabel}
                    </text>
                  ) : null
                })()
              : null}
            {tool === 'lineal' && draftPoints.length >= 2
              ? (() => {
                  const last = draftPoints[draftPoints.length - 1]
                  return last ? (
                    <text
                      x={last.x}
                      y={last.y - 1.6}
                      fontSize={3}
                      textAnchor="middle"
                      fill="var(--m-amber)"
                      fontWeight={700}
                      pointerEvents="none"
                    >
                      {formatQty(draftQuantity)} {unitForItem}
                      {pitchLabel}
                    </text>
                  ) : null
                })()
              : null}
            {tool === 'arc' && arcCurve
              ? (() => {
                  const mid = arcCurve[Math.floor(arcCurve.length / 2)]
                  return mid ? (
                    <text
                      x={mid.x}
                      y={mid.y - 1.6}
                      fontSize={3}
                      textAnchor="middle"
                      fill="var(--m-amber)"
                      fontWeight={700}
                      pointerEvents="none"
                    >
                      {formatQty(draftQuantity)} {unitForItem}
                      {pitchLabel}
                    </text>
                  ) : null
                })()
              : null}
            {/* On-canvas AI-review markers (capturing.reviewing/promoting only).
                Shares the board <svg> transform with the underlay + committed
                measurements; proposals with no geometry render nothing here
                (list-only). */}
            {isReviewing || isPromoting ? (
              <AiReviewMarkers
                model={reviewModel}
                selectedId={reviewSelectedId}
                onSelect={(id) => setReviewSelectedId((cur) => (cur === id ? null : id))}
              />
            ) : null}
          </svg>
        </div>
      </div>

      {/* ---- Top strip: sheet name + DONE / total ---- */}
      <TopStrip
        draftName={activeDraft?.name ?? 'Untitled'}
        sheetLabel={sheetLabel}
        detectedScale={detectedScale}
        grandTotal={grandTotal}
        onDone={() => navigate(`/desktop/estimate/${projectId}`)}
      />

      {/* ---- DCanvasCrossRef · "JUMPED FROM …" panel (dsg__50) ----
          Shown after a cross-sheet callout jump: explains which callout was
          clicked and offers a one-click RETURN to the source sheet. Floats
          top-right under the strip, clear of the AI/Item palettes. */}
      {jumpedFrom ? (
        <div style={floatBox({ top: 232, right: 312, width: 240 })}>
          <div style={floatHead}>● Jumped from {jumpedFrom.label}</div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--m-ink)', lineHeight: 1.5 }}>
              You followed a detail callout. This is the referenced sheet
              {activePage ? ` (pg ${activePage.page_number})` : ''}.
            </div>
            <MButton variant="primary" onClick={returnFromJump}>
              ← Return to {jumpedFrom.label}
            </MButton>
          </div>
        </div>
      ) : null}

      {/* ---- TOOL palette (top-left, below the strip) ---- */}
      <ToolPalette
        mode={mode}
        tool={tool}
        draftPoints={draftPoints}
        setMode={setMode}
        setTool={setTool}
        setDraftPoints={setDraftPoints}
        clearSelection={clearSelection}
      />

      {/* ---- VIEW palette (zoom + pan), below the TOOL palette ---- */}
      <ViewPalette
        zoom={zoom}
        zoomBy={zoomBy}
        resetView={resetView}
        handMode={handMode}
        setHandMode={setHandMode}
        showCallouts={showCallouts}
        setShowCallouts={setShowCallouts}
      />

      {/* ---- AI ASSIST palette (top-right, left of the item palette) ----
          Launcher for the AI setup flows. The setup routes
          (/desktop/ai-count/:projectId, /desktop/ai-takeoff/:projectId)
          already exist in desktop-workspace.tsx; this palette is what makes
          them reachable from the working takeoff canvas. (DEstTakeoffCanvas
          top-right "● AI ASSIST" palette in Steve's Desktop v2 mockup.) */}
      <AiAssistPalette projectId={projectId} draftPoints={draftPoints} setMode={setMode} />

      {/* ---- ITEM / quantities palette (right) ---- */}
      <div style={floatBox({ top: 92, right: 16, width: 280, maxHeight: 'calc(100% - 108px)', overflow: 'auto' })}>
        <div style={floatHead}>Item · Quantities</div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Blueprint / page pickers — change what underlays the canvas. */}
          {blueprintList.length > 0 ? (
            <MSelect
              value={activeBlueprint?.id ?? ''}
              onChange={(e) => {
                setBlueprintId(e.target.value || null)
                setPageId(null)
              }}
            >
              {blueprintList.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.file_name}
                </option>
              ))}
            </MSelect>
          ) : null}

          {/* Upload blueprint — admin/foreman/office only (hidden for worker). */}
          {canUploadBlueprint ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <MButton
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadBlueprint.isPending}
              >
                {uploadBlueprint.isPending ? 'Uploading…' : '↑ Upload blueprint'}
              </MButton>
              {uploadError ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{uploadError}</div> : null}
            </div>
          ) : null}
          {activeBlueprint && pages.length > 1 ? (
            <MSelect value={activePage?.id ?? ''} onChange={(e) => setPageId(e.target.value)}>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  pg {p.page_number}
                </option>
              ))}
            </MSelect>
          ) : null}
          {/* Auto-Bookmark: jump to a sheet by its embedded PDF bookmark. */}
          {bookmarks.length > 0 ? (
            <MSelect
              value=""
              onChange={(e) => {
                const pn = Number(e.target.value)
                if (!Number.isFinite(pn)) return
                const pg = pages.find((p) => p.page_number === pn)
                if (pg) setPageId(pg.id)
              }}
            >
              <option value="">Bookmarks…</option>
              {bookmarks.map((b, i) => (
                <option key={i} value={b.pageNumber}>
                  {b.title} · pg {b.pageNumber}
                </option>
              ))}
            </MSelect>
          ) : null}

          {/* Condition picker (Takeoff Deep Dive H1) — pick a reusable typed
              template the next draw is tagged against, or create one inline.
              "None" keeps the legacy shape-first flow (condition_id null), so
              the existing tag/service-item path below is always the fallback. */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
              }}
            >
              Condition
            </span>
            <MSelect
              value={activeConditionId ?? ''}
              onChange={(e) => setActiveConditionId(e.target.value ? e.target.value : null)}
            >
              <option value="">None (legacy)</option>
              {conditions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.measurement_kind}
                </option>
              ))}
            </MSelect>
            <MButton variant="ghost" size="sm" onClick={() => setConditionFormOpen((v) => !v)}>
              {conditionFormOpen ? 'Close' : '+ New'}
            </MButton>
            {activeCondition ? (
              <span
                aria-hidden
                title={activeCondition.name}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: activeCondition.color,
                  border: '1px solid var(--m-line)',
                  flex: '0 0 auto',
                }}
              />
            ) : null}
          </label>

          {/* Inline create-condition form (minimal: name + color + kind). The
              deeper condition-first draw flow — driver-derived multi-result
              emission, default-assembly auto-attach — is a flagged follow-up. */}
          {conditionFormOpen ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                value={newConditionName}
                onChange={(e) => setNewConditionName(e.target.value)}
                placeholder="Condition name"
                maxLength={120}
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 12,
                  padding: '4px 8px',
                  border: '1px solid var(--m-line)',
                  borderRadius: 6,
                  background: 'var(--m-surface)',
                  color: 'var(--m-ink-1)',
                }}
              />
              <input
                type="color"
                value={newConditionColor}
                onChange={(e) => setNewConditionColor(e.target.value)}
                title="Condition color"
                style={{ width: 32, height: 28, padding: 0, border: '1px solid var(--m-line)', borderRadius: 6 }}
              />
              <MSelect
                value={newConditionKind}
                onChange={(e) => setNewConditionKind(e.target.value as ConditionMeasurementKind)}
              >
                <option value="area">area</option>
                <option value="linear">linear</option>
                <option value="count">count</option>
                <option value="volume">volume</option>
              </MSelect>
              <MButton size="sm" onClick={onCreateCondition} disabled={createCondition.isPending}>
                {createCondition.isPending ? 'Saving…' : 'Create'}
              </MButton>
            </div>
          ) : null}

          {/* Scope item selector */}
          <MSelect value={serviceItemCode} onChange={(e) => setServiceItemCode(e.target.value)}>
            {items.length === 0 ? <option value="">Loading…</option> : null}
            {items.map((it: ServiceItem) => (
              <option key={it.code} value={it.code}>
                {it.code} — {it.name}
                {it.divisions && it.divisions.length > 0 ? ` · ${it.divisions.join('/')}` : ''}
              </option>
            ))}
          </MSelect>

          {/* Division for this scope item (Cavy, WhatsApp:227-229) — choose
              which division performs it when the item spans more than one. */}
          {(selectedItem?.divisions?.length ?? 0) > 0 ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--m-ink-3)',
                }}
              >
                Division
              </span>
              <MSelect
                value={divisionCode}
                onChange={(e) => setDivisionCode(e.target.value)}
                disabled={(selectedItem?.divisions?.length ?? 0) < 2}
              >
                {(selectedItem?.divisions ?? []).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </MSelect>
            </label>
          ) : null}

          {/* Live measurement readout (big-number) */}
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--m-ink)',
              color: 'var(--m-sand)',
              border: '2px solid var(--m-ink)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-accent)',
              }}
            >
              {tool === 'polygon'
                ? `POLY · ${draftPoints.length} PTS`
                : tool === 'rect'
                  ? `RECT · ${draftPoints.length ? 'DRAWN' : 'DRAG'}`
                  : tool === 'arc'
                    ? `ARC · ${draftPoints.length}/3`
                    : tool === 'lineal'
                      ? `LIN · ${draftPoints.length} PTS`
                      : `PT · ${draftPoints.length}`}
            </div>
            <div
              style={{
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 32,
                lineHeight: 1,
                marginTop: 4,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {tool === 'count' ? `${draftPoints.length}` : formatQty(draftQuantity)}
              <span style={{ fontSize: 13, color: 'var(--m-ink-4)', marginLeft: 6 }}>
                {tool === 'polygon'
                  ? unitForItem
                  : tool === 'lineal'
                    ? unitForItem
                    : draftPoints.length === 1
                      ? 'CT'
                      : 'CTS'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={undoPoint}
              disabled={draftPoints.length === 0}
              style={ghostChip(draftPoints.length === 0)}
            >
              UNDO
            </button>
            <button
              type="button"
              onClick={redoPoint}
              disabled={redoStack.length === 0}
              style={ghostChip(redoStack.length === 0)}
            >
              REDO
            </button>
            <button
              type="button"
              onClick={() => {
                // CANCEL→START_DRAW (empty path) drops the draft points + redo.
                setDraftPoints([])
              }}
              disabled={draftPoints.length === 0}
              style={ghostChip(draftPoints.length === 0)}
            >
              CLEAR
            </button>
            <button
              type="button"
              onClick={() =>
                setSnapEnabled((on) => {
                  const next = !on
                  try {
                    localStorage.setItem('sitelayer.snap', next ? 'on' : 'off')
                  } catch {
                    /* private mode */
                  }
                  return next
                })
              }
              title="Snap new points to nearby vertices and to horizontal/vertical"
              style={{
                ...ghostChip(false),
                ...(snapEnabled
                  ? { background: 'var(--m-ink)', color: 'var(--m-paper)', borderColor: 'var(--m-ink)' }
                  : {}),
              }}
            >
              SNAP {snapEnabled ? 'ON' : 'OFF'}
            </button>
            {isAreaTool ? (
              <button
                type="button"
                onClick={() => setDeduct((on) => !on)}
                title="Cutout: subtract this area from the net (e.g. a window or door opening)"
                style={{
                  ...ghostChip(false),
                  ...(deduct
                    ? { background: 'var(--m-red)', color: 'var(--m-paper)', borderColor: 'var(--m-red)' }
                    : {}),
                }}
              >
                DEDUCT {deduct ? 'ON' : 'OFF'}
              </button>
            ) : null}
          </div>

          {/* Pitch / slope driver (H2). Rise:run drives the slope factor
              √(rise²+run²)/run applied to the scaled area/length so sloped
              cladding/gables read true surface area. Blank/0 ⇒ flat ⇒ ×1.0. */}
          {pitchAppliesToTool ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
              }}
            >
              <span title="Roof/slope pitch — rise in run (e.g. 6 in 12). Blank = flat.">PITCH</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={pitchRise}
                onChange={(e) => setPitchRise(e.target.value)}
                placeholder="rise"
                aria-label="Pitch rise"
                style={pitchInputStyle}
              />
              <span style={{ color: 'var(--m-ink)' }}>:</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={pitchRun}
                onChange={(e) => setPitchRun(e.target.value)}
                placeholder="run"
                aria-label="Pitch run"
                style={pitchInputStyle}
              />
              <span style={{ color: activePitch && pitchFactor > 1 ? 'var(--m-amber)' : 'var(--m-ink-3)' }}>
                ×{round2(pitchFactor)}
              </span>
            </div>
          ) : null}

          <MButton variant="primary" onClick={() => void onSave()} disabled={!canSave}>
            {create.isPending
              ? 'Saving…'
              : `Add ${draftQuantity > 0 ? formatQty(draftQuantity) : ''} ${unitForItem}`.trim()}
          </MButton>

          {error ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{error}</div> : null}
          {savedToast ? <div style={{ fontSize: 12, color: 'var(--m-green)' }}>{savedToast}</div> : null}

          {/* Running totals by scope item */}
          <div
            style={{
              borderTop: '2px solid var(--m-ink)',
              paddingTop: 10,
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            Running quantities
          </div>
          {totals.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--m-ink-3)', lineHeight: 1.5 }}>
              No measurements yet. Draw on the canvas to add one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {totals.map((t) => (
                <div
                  key={t.code}
                  style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t.code}</span>
                  <span className="num" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                    {formatQty(t.quantity)} {t.mixedUnits ? 'mixed' : t.unit}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Condition legend (Takeoff Deep Dive H1) — per-condition drawn
              count + quantity, color-keyed to the canvas. Only shows when at
              least one measurement was drawn against a condition. */}
          {conditionLegend.length > 0 ? (
            <>
              <div
                style={{
                  borderTop: '2px solid var(--m-ink)',
                  paddingTop: 10,
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--m-ink-3)',
                }}
              >
                Conditions
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {conditionLegend.map((row) => (
                  <div
                    key={row.condition.id}
                    style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 3,
                          background: row.condition.color,
                          border: '1px solid var(--m-line)',
                          flex: '0 0 auto',
                        }}
                      />
                      {row.condition.name}
                    </span>
                    <span className="num" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                      {row.count}× · {formatQty(row.quantity)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* ---- DCanvasSheetRef · sheet-reference chip (bottom-left) ---- */}
      <div
        style={floatBox({
          bottom: 16,
          left: 16,
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        })}
      >
        <span
          style={{
            width: 8,
            height: 8,
            background: activeBlueprint ? 'var(--m-green)' : 'var(--m-ink-3)',
            flexShrink: 0,
          }}
          aria-hidden
        />
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink)',
          }}
        >
          {activeBlueprint
            ? `Sheet · ${activeBlueprint.file_name}${activePage ? ` · pg ${activePage.page_number}` : ''}`
            : 'No sheet · grid only'}
        </span>
        {activeBlueprint?.sheet_scale ? (
          <span style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700, color: 'var(--m-ink-3)' }}>
            {activeBlueprint.sheet_scale}
          </span>
        ) : null}
      </div>

      {/* ---- DCanvasEmpty · no-drawing dropzone (uses DEmptyState) ---- */}
      {!activeBlueprint && mode === 'draw' ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              background: 'var(--m-card)',
              border: '3px dashed var(--m-ink)',
              maxWidth: 520,
            }}
          >
            <DEmptyState
              mark="↓"
              title="Drop the plan set"
              body="Plan set, drawings, or architect's PDF — up to 200MB, multi-page OK. Sheets, cross-references, and scales read automatically. Or pick a blueprint from the Item palette."
              action={
                canUploadBlueprint ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
                    <MButton
                      variant="primary"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadBlueprint.isPending}
                    >
                      {uploadBlueprint.isPending ? 'Uploading…' : '↑ Upload blueprint'}
                    </MButton>
                    {uploadError ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{uploadError}</div> : null}
                  </div>
                ) : undefined
              }
            />
          </div>
        </div>
      ) : null}

      {/* ---- DCanvasScale · scale-calibration overlay (center) ---- */}
      {mode === 'scale' ? (
        <ScaleOverlay
          activeBlueprint={activeBlueprint}
          scalePoints={scalePoints}
          scaleLength={scaleLength}
          setScaleLength={setScaleLength}
          provisionalRatio={provisionalRatio}
          scaleError={scaleError}
          applyScale={applyScale}
          calibratePending={calibratePage.isPending}
          onAiVerify={() => navigate(`/desktop/scale/${projectId}`)}
        />
      ) : null}

      {/* ---- AI Count / AI Takeoff SETUP overlays (canvas stays visible behind;
          Escape or ✕ dismisses; RUN routes to the heavy review screen) ---- */}
      {mode === 'ai-count' ? (
        <EstAiCountSetupPanel
          projectId={projectId}
          onClose={() => setMode('draw')}
          onReviewDraft={(id) => navigate(`/desktop/ai-count/${projectId}/review`, { state: { draftId: id } })}
        />
      ) : null}
      {mode === 'ai-takeoff' ? (
        <EstAiTakeoffSetupPanel
          projectId={projectId}
          onClose={() => setMode('draw')}
          onReviewDraft={(id, captureMode) =>
            navigate(`/desktop/ai-takeoff/${projectId}/review`, { state: { draftId: id, mode: captureMode } })
          }
        />
      ) : null}

      {/* ---- On-canvas AI review (capturing.reviewing) ----
          The synced LIST half of the review surface. Strictly gated to the
          machine's reviewing state, so the draw / scale / select surfaces are
          behavior-preserving. Accept/Reject record `capture.decisions` via
          REVIEW_DECISION; "Promote accepted" dispatches PROMOTE with the
          accepted ids (persistence stays on the existing hybrid path — the
          machine's promoteCaptured actor is unwired, so PROMOTE simply lands the
          UI in `promoting`); the show-low toggle filters by `capture.showLow`. */}
      {isReviewing || isPromoting ? (
        <AiReviewOverlay
          result={sctx.capture.result}
          decisions={sctx.capture.decisions}
          showLow={sctx.capture.showLow}
          selectedId={reviewSelectedId}
          onSelect={setReviewSelectedId}
          dispatch={sdispatch}
          promoting={isPromoting}
        />
      ) : null}

      {/* ---- DCanvasItemPalette · "/"-style scope-item command palette ---- */}
      {itemPaletteOpen ? (
        <ItemPalette
          itemQuery={itemQuery}
          setItemQuery={setItemQuery}
          paletteItems={paletteItems}
          serviceItemCode={serviceItemCode}
          applyItemPick={applyItemPick}
          closePalette={() => {
            setItemPaletteOpen(false)
            setReassignIds(null)
          }}
        />
      ) : null}

      {/* ---- PlanSwift Phase 2 · attach an assembly recipe to the selected
           measurement. Floats just above the single-selection action bar so
           the estimator can "apply assembly" then see the exploded preview. -- */}
      {mode === 'select' && selectedMeasurement && bulkSelected.size === 1 && editGeomId !== selectedMeasurement.id ? (
        <div
          style={floatBox({
            bottom: 92,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '12px 16px',
            maxWidth: 420,
          })}
        >
          <AssemblyAttachPanel measurement={selectedMeasurement} />
        </div>
      ) : null}

      {/* ---- DCanvasEditMeasure · single-selection contextual action bar ---- */}
      {mode === 'select' && selectedMeasurement && bulkSelected.size === 1 ? (
        <div
          style={floatBox({
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'stretch',
          })}
        >
          <div style={{ padding: '14px 20px', borderRight: '2px solid var(--m-ink)' }}>
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--m-accent-ink)',
                background: 'var(--m-accent)',
                display: 'inline-block',
                padding: '2px 6px',
              }}
            >
              {editGeomId === selectedMeasurement.id
                ? 'EDIT GEOM · DRAG A HANDLE'
                : `SELECTED · ${selectedIndex >= 0 ? selectedIndex + 1 : '—'} OF ${blueprintMeasurements.length}`}
            </span>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 24, marginTop: 6 }}>
              {formatQty(Number(selectedMeasurement.quantity))} {selectedMeasurement.unit} ·{' '}
              {selectedMeasurement.service_item_code}
            </div>
          </div>
          {(editGeomId === selectedMeasurement.id
            ? ([
                { l: patchMeasurement.isPending ? 'SAVING…' : 'APPLY', action: () => void commitEditGeom() },
                { l: 'CANCEL', action: cancelEditGeom },
              ] as const)
            : ([
                {
                  l: 'REASSIGN',
                  action: () => {
                    if (selectedMeasurement) setReassignIds([selectedMeasurement.id])
                    setItemPaletteOpen(true)
                  },
                },
                { l: 'EDIT GEOM', action: onEditGeom },
                { l: 'DUPLICATE', action: () => void onDuplicateSelected() },
                { l: copyOpen ? 'COPY ✕' : 'COPY…', action: () => setCopyOpen((v) => !v) },
                { l: 'DELETE', danger: true, action: onDeleteSelected },
              ] as const)
          ).map((b, i, arr) => (
            <button
              key={b.l}
              type="button"
              onClick={b.action}
              disabled={patchMeasurement.isPending && editGeomId === selectedMeasurement.id}
              style={{
                padding: '0 22px',
                background: 'var(--m-card)',
                color: 'danger' in b && b.danger ? 'var(--m-red)' : 'var(--m-ink)',
                border: 'none',
                borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                cursor: 'pointer',
              }}
            >
              {b.l}
            </button>
          ))}
        </div>
      ) : null}

      {/* ---- Floating SHEETS panel (bottom-right) ----
          Quick sheet/page switcher mirroring the design's "SHEETS · 22" panel
          (dsg__06). In SCALE mode it becomes the "SHEETS · SCALE" status panel
          (dsg__46), surfacing each page's calibration state. Only shown when the
          active blueprint actually has pages. */}
      {activeBlueprint && pages.length > 0 ? (
        <SheetsPanel pages={pages} activePage={activePage} mode={mode} setPageId={setPageId} />
      ) : null}

      {/* ---- DCanvasBulkSelect · marquee multi-selection toolbar (2+) ---- */}
      {mode === 'select' && bulkSelected.size >= 2 ? (
        <div
          style={floatBox({
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'stretch',
          })}
        >
          <div style={{ padding: '14px 24px', borderRight: '2px solid var(--m-ink)' }}>
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700, color: 'var(--m-ink-3)' }}>
              MARQUEE SELECTION · {bulkSelected.size} {bulkSelected.size === 1 ? 'ITEM' : 'ITEMS'}
            </div>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 28, marginTop: 6 }}>
              {formatQty(bulkTotal)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setReassignIds(Array.from(bulkSelected))
              setItemPaletteOpen(true)
            }}
            style={{
              padding: '0 24px',
              background: 'var(--m-card)',
              border: 'none',
              borderRight: '2px solid var(--m-ink)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: 'pointer',
            }}
          >
            REASSIGN ITEM
          </button>
          <button
            type="button"
            onClick={() => setCopyOpen((v) => !v)}
            style={{
              padding: '0 24px',
              background: copyOpen ? 'var(--m-accent)' : 'var(--m-card)',
              color: copyOpen ? 'var(--m-accent-ink)' : 'var(--m-ink)',
              border: 'none',
              borderRight: '2px solid var(--m-ink)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: 'pointer',
            }}
          >
            {copyOpen ? 'COPY ✕' : 'COPY…'}
          </button>
          <button
            type="button"
            onClick={onBulkDelete}
            style={{
              padding: '0 24px',
              background: 'var(--m-card)',
              color: 'var(--m-red)',
              border: 'none',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: 'pointer',
            }}
          >
            DELETE {bulkSelected.size}
          </button>
        </div>
      ) : null}

      {/* ---- Copy / array / mirror panel (deep-dive H6) ----
          Additive toolbar group: when a selection exists in SELECT mode and the
          COPY… button is toggled on, offer copy-with-offset, array-paste (N along
          a row), and mirror/rotate of the duplicated geometry. Each action saves
          NEW measurements through `useCreateMeasurement` (same scope/unit/sheet),
          so quantities recompute server-side. Only point-based geometries copy. */}
      {mode === 'select' && copyOpen && copyableTargets.length > 0 ? (
        <CopyPanel
          targetCount={copyableTargets.length}
          copyDx={copyDx}
          setCopyDx={setCopyDx}
          copyDy={copyDy}
          setCopyDy={setCopyDy}
          copyCount={copyCount}
          setCopyCount={setCopyCount}
          copyMirror={copyMirror}
          setCopyMirror={setCopyMirror}
          copyRotate={copyRotate}
          setCopyRotate={setCopyRotate}
          copyBusy={copyBusy}
          runCopyPlan={runCopyPlan}
        />
      ) : null}

      {/* ---- "/" affordance to open the item palette while drawing ---- */}
      {mode === 'draw' && !itemPaletteOpen ? (
        <button
          type="button"
          onClick={() => {
            setReassignIds(null)
            setItemPaletteOpen(true)
          }}
          aria-label="Assign item (command palette)"
          style={floatBox({
            bottom: 16,
            right: 16,
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
          })}
        >
          <span
            style={{
              fontFamily: 'var(--m-num)',
              fontWeight: 800,
              fontSize: 12,
              color: 'var(--m-accent-ink)',
              background: 'var(--m-accent)',
              padding: '1px 6px',
            }}
            aria-hidden
          >
            /
          </span>
          <span
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              color: 'var(--m-ink)',
            }}
          >
            ASSIGN ITEM
          </span>
          {selectedItem ? <MPill tone="accent">{selectedItem.code}</MPill> : null}
        </button>
      ) : null}
    </div>
  )
}
