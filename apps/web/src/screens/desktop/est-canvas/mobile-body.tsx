import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  calculateLinealLength,
  calculateLinealLengthScaled,
  calculatePolygonAreaScaled,
  slopeFactor,
  type PitchDriver,
} from '@sitelayer/domain'
import {
  useBlueprintPages,
  useCalibratePage,
  useCreateMeasurement,
  useCreateTakeoffDraft,
  useDeleteMeasurement,
  usePatchMeasurement,
  useProjectBlueprints,
  useProjectMeasurements,
  useServiceItems,
  useTakeoffDrafts,
  type BlueprintDocument,
  type BlueprintPage,
  type MeasurementGeometry,
  type ServiceItem,
  type TakeoffDraft,
  type TakeoffMeasurement,
} from '@/lib/api'

import { useAuthenticatedObjectUrl } from '@/lib/api/blob-url'
import { currentCaptureRoutePath } from '@/lib/capture-session'
import { registerCaptureArtifactProvider } from '@/lib/capture-artifact-providers'
import { registerCaptureStateProvider } from '@/lib/capture-state-providers'
// Phase B responsive consolidation: the AI setup panels moved into the merged
// responsive screens (former desktop twins est-ai-count.tsx / est-ai-takeoff.tsx
// were deleted). The standalone float-palette exports are unchanged.

import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { solveWorldScale, type WorldScale } from '@/lib/takeoff/world-scale'
import { worldScaleStamp, pitchStamp } from '@/lib/takeoff/measurement-geometry'
import { buildCanvasGeometryArtifact, uploadCanvasGeometryArtifact } from '@/lib/takeoff/canvas-geometry-artifact'
import { buildTakeoffCanvasStateSnapshot } from '@/lib/takeoff/canvas-state-snapshot'

import { arcPolyline } from '@/lib/takeoff/arc'
import { clamp, round2, screenToBoardPoint } from '@/lib/takeoff/canvas-math'
import { useSnapping, resolveDraftPoint } from '@/lib/takeoff/snapping'
import { PdfPageCanvas, usePdfDocument } from '@/lib/pdf/pdf-page-canvas'

import { buildDuplicateGeometries, type CopyPlan, type MirrorAxis } from '@/lib/takeoff/copy-transform'
import { buildScopeTotals, formatQty } from '@/lib/takeoff/canvas-totals'

import { MBody, MButton, MChip, MChipRow, MI, MInput, MSectionH, MSelect, MTopBar, Spark } from '@/components/m'
import { MEmptyState, MSkeletonList } from '@/components/m-states'

import { TakeoffImportSheet } from '../../mobile/takeoff-import-sheet'
import { TakeoffTagSheet } from '../../projects/takeoff-tag-sheet'
import { AgentSuggestionsPanel } from './agent-suggestions-panel'
import { AssemblyAttachPanel } from './assembly-panel'
import { CapturePanel } from './capture-panel'
import { ConditionPicker } from './condition-picker'
import { ElevationPicker } from './elevation-picker'
import { useConditions, useCreateCondition, type ConditionMeasurementKind } from '@/lib/api/conditions'

import { type MobileTool, type MobileMode } from './types'
import { MAX_POLYGON_POINTS } from './constants'

import { useQueryClient } from '@tanstack/react-query'
import { useTakeoffSession, type TakeoffTool } from '@/machines/takeoff-session'
import { createTakeoffSessionApiDeps } from '@/machines/takeoff-session-deps'
import { resolveTakeoffSeed, TAKEOFF_SEED_NAMES } from '@/machines/takeoff-session-seeds'

import {
  SegmentedControl,
  WallHeightPanel,
  PitchPanel,
  MobileScalePanel,
  MobileCanvasSurface,
} from './mobile-components'
import {
  MobileAiLaunch,
  MobileToolToolbar,
  MobileDeductToggle,
  MobileBulkSelectToggle,
  MobileBulkFooter,
  MobileCopyPanel,
  MobileMeasurementStrip,
  MobileRunningTotals,
} from './mobile-panels'

// The phone canvas surfaces four of the machine's six drawing tools (POLY/RECT
// both map to the `polygon` value, plus `lineal`, `arc`, and `count`). Narrow
// the machine's `TakeoffTool` down to the `MobileTool` the surface understands
// so the rest of the body keeps its exhaustive switches without a stray
// `volume` branch.
function toMobileTool(tool: TakeoffTool): MobileTool {
  if (tool === 'arc') return 'arc'
  if (tool === 'lineal') return 'lineal'
  if (tool === 'count') return 'count'
  return 'polygon' // polygon | rect | volume → the polygon draw surface
}

// Desktop capability body — the full-bleed floating-palette command-center
// takeoff editor. Phase C: rendered by the responsive `TakeoffCanvas` wrapper
// (bottom of file) at the lg: / desktop capability; the phone form factor
// renders `TakeoffCanvasMobileBody` instead. Both share the 0–100 board space,
// the `@sitelayer/domain` geometry, and the data hooks, so rows are
// interchangeable across form factors.

// Phone-form-factor takeoff body — extracted verbatim from est-canvas.tsx
// (behavior preserved). Mounted by TakeoffCanvas below the 1024px gate.

// Phone-form-factor body — manual-qty / draw / wall-height→area / CSV import /
// AI launch / per-item running quantities. Folded in from the former
// `screens/mobile/takeoff-mobile.tsx` (deleted in Phase C); behavior preserved
// verbatim. Uses its own lightweight viewBox canvas (no pan/zoom capability).
export function TakeoffCanvasMobileBody({ companySlug }: { companySlug: string }) {
  void companySlug // resource hooks resolve the company from the request layer; kept for shell-prop parity.
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = params.projectId ?? ''

  // --- Drafts ---------------------------------------------------------------
  const drafts = useTakeoffDrafts(projectId)
  const createDraft = useCreateTakeoffDraft(projectId)
  const draftList = useMemo(() => drafts.data?.drafts ?? [], [drafts.data])
  const draftParam = searchParams.get('draft')
  const activeDraft: TakeoffDraft | null =
    draftList.find((d) => d.id === draftParam) ?? draftList.find((d) => d.status === 'active') ?? draftList[0] ?? null
  const activeDraftId = activeDraft?.id ?? null

  const setActiveDraft = (id: string) => {
    const sp = new URLSearchParams(searchParams)
    sp.set('draft', id)
    setSearchParams(sp, { replace: true })
  }

  const onCreateDraft = () => {
    const name = typeof window !== 'undefined' ? window.prompt('New takeoff name', 'Mobile takeoff')?.trim() : ''
    if (!name) return
    createDraft.mutate({ name }, { onSuccess: (res) => setActiveDraft(res.draft.id) })
  }

  // --- Blueprints + pages ---------------------------------------------------
  const blueprints = useProjectBlueprints(projectId)
  const blueprintList = useMemo(
    () => (blueprints.data?.blueprints ?? []).filter((b) => !b.deleted_at),
    [blueprints.data],
  )
  const blueprintParam = searchParams.get('blueprint')
  const activeBlueprint: BlueprintDocument | null = blueprintList.find((b) => b.id === blueprintParam) ?? null

  const setActiveBlueprint = (id: string | null) => {
    const sp = new URLSearchParams(searchParams)
    if (id) sp.set('blueprint', id)
    else sp.delete('blueprint')
    sp.delete('page')
    setSearchParams(sp, { replace: true })
  }

  const blueprintPages = useBlueprintPages(activeBlueprint?.id)
  const pages = useMemo(() => blueprintPages.data?.pages ?? [], [blueprintPages.data])
  const pageParam = searchParams.get('page')
  const activePage: BlueprintPage | null = pages.find((p) => p.id === pageParam) ?? pages[0] ?? null

  const setActivePage = (id: string) => {
    const sp = new URLSearchParams(searchParams)
    sp.set('page', id)
    setSearchParams(sp, { replace: true })
  }

  const blueprintReference = useMemo(
    () => buildBlueprintReference(activeBlueprint, activePage),
    [activeBlueprint, activePage],
  )
  const sourceImage = useAuthenticatedObjectUrl(blueprintReference?.texturePath)
  // Phone underlay: render the ORIGINAL PDF via PDFium (the same engine the
  // desktop body uses) so the phone draws over the real sheet instead of a blank
  // grid. Falls back to the server-rasterized page image for non-PDF blueprints,
  // or when the engine is disabled via localStorage['sitelayer.pdf_engine']='image'.
  const pdfEngineOn = typeof window !== 'undefined' && window.localStorage?.getItem('sitelayer.pdf_engine') !== 'image'
  const blueprintIsPdf = (activeBlueprint?.file_name ?? '').toLowerCase().endsWith('.pdf')
  const pdfDocUrl = useAuthenticatedObjectUrl(
    pdfEngineOn && blueprintIsPdf && activeBlueprint
      ? `/api/blueprints/${encodeURIComponent(activeBlueprint.id)}/file`
      : null,
  )
  const pdfDocState = usePdfDocument(pdfDocUrl.url ?? null)

  // --- World scale (sheet calibration) --------------------------------------
  // Parity with the desktop body: a page calibrated on EITHER surface persists
  // its two-point reference on the blueprint_page row, so the phone reads the
  // same per-axis real-world scale and saves true sqft/lf instead of board-space
  // units. The page's isotropic PDF point size turns the anisotropic 0–100 board
  // into a per-axis scale; null page size (non-PDF / image engine) or an
  // uncalibrated page ⇒ board space, exactly as on desktop.
  const activePageNumber = activePage?.page_number ?? 1
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
  const worldScale: WorldScale | null = useMemo(
    () => solveWorldScale(activePage, pageSize?.width, pageSize?.height),
    [activePage, pageSize],
  )
  const calibratePage = useCalibratePage()

  // --- Measurements ---------------------------------------------------------
  const measurements = useProjectMeasurements(projectId, { draftId: activeDraftId })
  const create = useCreateMeasurement(projectId)
  const patchMeasurement = usePatchMeasurement()
  const deleteMeasurement = useDeleteMeasurement()
  const serviceItems = useServiceItems()
  const items = useMemo(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])

  // --- Session machine (CORE canvas state owner) ----------------------------
  // The `takeoff-session` statechart is the single source of truth for the
  // CORE drawing slices on the phone: the active `tool`, the in-progress draft
  // `points`, and the committed-measurement `selection` (single / bulk / edit).
  // Reads come off `session.context.draft` / `.selection`; writes dispatch
  // machine events. Everything else below (manual qty, wall height, deduct,
  // CSV import, copy panel, toasts) has no machine equivalent and stays local
  // (hybrid by design). The CAPTURE actors (runCapture / promoteCaptured) are
  // WIRED to the real async capture + promote endpoints via
  // `createTakeoffSessionApiDeps` (wave-3 review convergence); the remaining
  // actors (COMMIT/edit/etc.) persist via the EXISTING TanStack-Query mutation
  // hooks, then dispatch the matching machine event to reset the UI slice.
  //
  // `?seed=<name>` (dev/test only) boots the machine straight into a named
  // state via resolveTakeoffSeed — a tester lands mid-polygon-draw with no
  // clicks. Never honored in production.
  const seedName = searchParams.get('seed')
  const initialSeed = useMemo(() => {
    if (!seedName || import.meta.env.MODE === 'production') return null
    if (!(TAKEOFF_SEED_NAMES as readonly string[]).includes(seedName)) return null
    return resolveTakeoffSeed(seedName, { projectId, companySlug, blueprintId: null, pageId: null, draftId: null })
    // Captured ONCE at mount (empty deps); the live blueprint/page/draft picker
    // re-syncs ids below. (react-hooks/exhaustive-deps is not enabled here.)
  }, [])

  const queryClient = useQueryClient()
  const sessionDeps = useMemo(() => createTakeoffSessionApiDeps({ queryClient }), [queryClient])
  const session = useTakeoffSession({ projectId, companySlug, seed: initialSeed, deps: sessionDeps })
  const { context: sctx, dispatch: sdispatch } = session

  // CORE slices now read from the machine.
  const tool = toMobileTool(sctx.draft.tool)
  const draftPoints = sctx.draft.points
  const selectedId = sctx.selection.selectedId
  const bulkIds = useMemo(() => new Set(sctx.selection.bulkIds), [sctx.selection.bulkIds])
  const editId = sctx.selection.editGeomId
  const editPoints = sctx.selection.editPoints ?? []

  // --- Entry state ----------------------------------------------------------
  // `mode` ('manual' | 'draw') has no clean 1:1 with the machine's exclusive
  // modes (the phone draws AND selects on one surface), so it stays a thin
  // local notion: 'draw' parks the machine in `drawing`, 'manual' in `idle`.
  // Lazy-initialised from the boot snapshot so a `?seed=drawing-*` lands the
  // phone on the draw tab WITHOUT the mode-sync effect cancelling the seeded
  // draft on mount.
  const [mode, setMode] = useState<MobileMode>(() => (session.matches('drawing') ? 'draw' : 'manual'))
  // The tool *label* the user picked (POLY/RECT/LIN/ARC/PT). RECT shares the
  // `polygon` tool value, so we track the label separately to highlight the
  // right chip without changing the draw behavior.
  const [toolLabel, setToolLabel] = useState<'POLY' | 'RECT' | 'LIN' | 'PT' | 'ARC'>(() => {
    const t = toMobileTool(sctx.draft.tool)
    return t === 'lineal' ? 'LIN' : t === 'arc' ? 'ARC' : t === 'count' ? 'PT' : 'POLY'
  })
  const [serviceItemCode, setServiceItemCode] = useState('')
  const [manualQty, setManualQty] = useState('')
  // LIN → area: optional wall height applied to a lineal trace (msg21). When
  // > 0 with the LIN tool, the committed measurement is an AREA (length ×
  // height) rather than raw length.
  const [wallHeight, setWallHeight] = useState<number>(0)
  // Pitch / slope driver (parity with desktop H2). A rise:run turns plan
  // area/length into true sloped-surface area/length — critical for exterior
  // envelope (roof / sloped wall). Empty or non-positive ⇒ flat (factor 1.0).
  // The driver is stamped into the saved geometry; the server applies the slope.
  const [pitchRise, setPitchRise] = useState('')
  const [pitchRun, setPitchRun] = useState('12')
  // Deduct/cutout (msg19 "WIN"): when on, a drawn polygon is saved as a
  // deduction (its area subtracts from the net for its scope item) via the
  // real `is_deduction` field.
  const [deduct, setDeduct] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedToast, setSavedToast] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  // Multi-condition tag sheet (parity with v1) — a bottom sheet to add/remove
  // per-measurement condition tags on a committed measurement. `null` = closed.
  const [tagSheetMeasurementId, setTagSheetMeasurementId] = useState<string | null>(null)
  // Scale calibration (parity with desktop SCALE mode). The two board-space
  // reference points + the typed real-world length live in the machine's
  // calibration slice; `applyScale` persists them to the page via the same
  // `calibratePage` mutation the desktop overlay uses, after which `worldScale`
  // recomputes and new measurements carry true sqft/lf.
  const scalePoints = sctx.calibration.points
  const scaleLength = sctx.calibration.lengthText || '24'
  const setScaleLength = (next: string) => sdispatch({ type: 'SET_SCALE_LENGTH', lengthText: next })
  const [scaleError, setScaleError] = useState<string | null>(null)
  // Conditions (Takeoff Deep Dive H1) — parity with desktop. A condition is the
  // reusable typed/named/colored template the next draw is tagged against;
  // `condition_id` is stamped on save. "None" keeps the legacy shape-first flow.
  const conditionsQuery = useConditions()
  const conditions = useMemo(() => conditionsQuery.data?.conditions ?? [], [conditionsQuery.data])
  const createCondition = useCreateCondition()
  const [activeConditionId, setActiveConditionId] = useState<string | null>(null)
  const activeCondition = useMemo(
    () => conditions.find((c) => c.id === activeConditionId) ?? null,
    [conditions, activeConditionId],
  )
  const [conditionFormOpen, setConditionFormOpen] = useState(false)
  const [newConditionName, setNewConditionName] = useState('')
  const [newConditionColor, setNewConditionColor] = useState('#2f7d32')
  const [newConditionKind, setNewConditionKind] = useState<ConditionMeasurementKind>('area')
  // Bulk multi-select (msg23). When on, canvas taps toggle membership in a set
  // (instead of drawing), exposing SELECT ALL + a bulk reassign/delete footer.
  // `bulkMode` is the phone-only toggle (no machine equivalent); the bulk *set*
  // itself lives in the machine's selection slice.
  const [bulkMode, setBulkMode] = useState(false)
  // Copy / array / mirror tools (deep-dive gap H6). When a measurement is
  // selected (single or bulk), a small COPY panel offers copy-with-offset,
  // array-paste (N along a row), and mirror/rotate of the copies. Each copy is
  // saved as a NEW measurement via the existing create path; quantities
  // recompute server-side. `copyOpen` toggles the panel.
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyDx, setCopyDx] = useState('6')
  const [copyDy, setCopyDy] = useState('0')
  const [copyCount, setCopyCount] = useState('3')
  const [copyMirror, setCopyMirror] = useState<MirrorAxis | 'none'>('none')
  const [copyRotate, setCopyRotate] = useState('0')
  const [copyBusy, setCopyBusy] = useState(false)
  // EDIT GEOM (msg22 vertex drag). When a saved polygon/lineal is selected, the
  // EDIT GEOM action turns its committed vertices into draggable handles; the
  // working point set lives in the machine's `selection.editPoints` (read above
  // as `editPoints`, with `editId` = `selection.editGeomId`) until APPLY
  // PATCHes the new geometry (server recomputes the quantity).
  const editDragIdxRef = useRef<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Snap-to-content toggle. Shares the same `localStorage['sitelayer.snap']`
  // key the desktop canvas reads, so disabling snap on one surface disables it
  // on the other. Default ON. When ON, a tapped draft point latches onto
  // existing committed geometry (endpoint / midpoint / on-segment) and locks to
  // horizontal / vertical / 45° from the previous point.
  const snapEnabled = typeof localStorage !== 'undefined' ? localStorage.getItem('sitelayer.snap') !== 'off' : true

  // Default the scope item once the catalog loads.
  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

  // Park the machine in the mode that matches the phone surface: 'draw' →
  // `drawing` (so PLACE_POINT lands), 'scale' → `calibrating` (so PLACE_SCALE_POINT
  // lands), 'manual' → `idle`. Selection/edit drive their own machine sub-states
  // from the canvas handlers. The START_* entries are valid only from `idle`, so
  // a cross-mode flip CANCELs back to idle first (xstate runs both this tick).
  useEffect(() => {
    const target = mode === 'draw' ? 'drawing' : mode === 'scale' ? 'calibrating' : 'idle'
    if (session.matches(target)) return
    if (!session.matches('idle')) sdispatch({ type: 'CANCEL' })
    if (target === 'drawing') sdispatch({ type: 'START_DRAW' })
    else if (target === 'calibrating') sdispatch({ type: 'START_CALIBRATION' })
    // target === 'idle' → the CANCEL above already landed us there.
    // Re-runs only on a mode flip; `session`/`sdispatch` are stable for the
    // machine's lifetime. (react-hooks/exhaustive-deps is not enabled here.)
  }, [mode])

  // Mirror the scope item into the machine draft so its commit guard + future
  // wired actors see the same scope the UI persists with.
  useEffect(() => {
    if (serviceItemCode && sctx.draft.serviceItemCode !== serviceItemCode) {
      sdispatch({ type: 'SET_SERVICE_ITEM', serviceItemCode })
    }
    // Mirror on scope change only. (react-hooks/exhaustive-deps is not enabled here.)
  }, [serviceItemCode])

  const selectedItem = items.find((i) => i.code === serviceItemCode) ?? null
  // LIN trace length (board-space) reused by the wall-height → area step.
  const linealLength = useMemo(() => round2(calculateLinealLength(draftPoints)), [draftPoints])
  // ARC tool: tessellate the 3 control points (start, through, end) into a
  // lineal polyline for length/render/save once all three are placed.
  const arcCurve = useMemo(() => {
    if (tool !== 'arc' || draftPoints.length !== 3) return null
    const [a, b, c] = draftPoints
    return a && b && c ? arcPolyline(a, b, c) : null
  }, [tool, draftPoints])
  // The LIN tool yields an AREA once a wall height is set (msg21).
  const linHasHeight = tool === 'lineal' && wallHeight > 0
  const unitForItem = linHasHeight
    ? 'sqft'
    : (selectedItem?.unit ??
      (mode === 'draw' && tool === 'polygon' ? 'sqft' : tool === 'lineal' || tool === 'arc' ? 'lf' : 'ea'))

  // Pitch driver + slope factor (parity with desktop). Pitch only multiplies
  // sloped-surface tools (polygon area, plain lineal run, arc) — never counts,
  // and not the wall-height→area path (which carries its own explicit quantity).
  const activePitch = useMemo<PitchDriver | null>(() => {
    const rise = Number(pitchRise)
    const run = Number(pitchRun)
    if (!Number.isFinite(rise) || !Number.isFinite(run)) return null
    if (rise <= 0 || run <= 0) return null
    return { rise, run }
  }, [pitchRise, pitchRun])
  const pitchAppliesToTool = (tool === 'polygon' || tool === 'lineal' || tool === 'arc') && !linHasHeight
  const pitchFactor = pitchAppliesToTool ? slopeFactor(activePitch) : 1
  // Scale stamps applied to polygon + plain-lineal + arc geometry (never count,
  // never the wall-height path). `appliesScale` matches the same tool set.
  const appliesScale = tool === 'polygon' || tool === 'arc' || (tool === 'lineal' && !linHasHeight)

  const draftQuantity = useMemo(() => {
    if (mode === 'manual') return Number(manualQty) || 0
    // Mirror the server's quantity math: a calibrated page reads true sqft/lf,
    // and pitch multiplies the sloped surface. Uncalibrated ⇒ wx=wy=1 ⇒
    // board-space, the legacy behavior.
    const wx = worldScale?.wx ?? 1
    const wy = worldScale?.wy ?? 1
    if (tool === 'polygon') return round2(calculatePolygonAreaScaled(draftPoints, wx, wy, pitchFactor))
    if (tool === 'arc') return arcCurve ? round2(calculateLinealLengthScaled(arcCurve, wx, wy, pitchFactor)) : 0
    if (tool === 'lineal') {
      // Wall-height→area keeps its explicit board-length × height preview
      // (unchanged); a plain lineal run reads scaled, pitch-corrected length.
      return linHasHeight
        ? round2(linealLength * wallHeight)
        : round2(calculateLinealLengthScaled(draftPoints, wx, wy, pitchFactor))
    }
    return draftPoints.length
  }, [mode, tool, manualQty, draftPoints, arcCurve, linHasHeight, linealLength, wallHeight, worldScale, pitchFactor])

  // Clear the in-progress draft via the machine while staying on the draw
  // surface (CANCEL drops points and lands in idle; START_DRAW re-enters
  // drawing so the next PLACE_POINT is accepted).
  const resetDraftPoints = () => {
    sdispatch({ type: 'CANCEL' })
    sdispatch({ type: 'START_DRAW' })
  }

  const onCanvasTap = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    // SCALE mode: tap two points of a known dimension to define the reference
    // line. The machine's PLACE_SCALE_POINT models the two-max / third-tap-
    // restarts behavior; `applyScale` persists the line + typed length.
    if (mode === 'scale') {
      const local = screenToBoardPoint(svg, e.clientX, e.clientY)
      if (!local) return
      const p = { x: round2(clamp(local.x, 0, 100)), y: round2(clamp(local.y, 0, 100)) }
      setScaleError(null)
      if (!session.matches('calibrating')) sdispatch({ type: 'START_CALIBRATION' })
      sdispatch({ type: 'PLACE_SCALE_POINT', point: p })
      return
    }
    // In bulk-select mode an empty-grid tap does nothing (taps land on polys).
    if (bulkMode) return
    // While editing geometry, a background tap is inert — the vertex handles
    // own the gestures, and a stray tap must not deselect or drop a point.
    if (editId) return
    // A tap on the empty grid deselects any committed measurement and starts
    // a fresh draft point.
    if (selectedId) sdispatch({ type: 'CLEAR_SELECTION' })
    if (tool === 'polygon' && draftPoints.length >= MAX_POLYGON_POINTS) return
    if (tool === 'arc' && draftPoints.length >= 3) return // arc = exactly 3 control points
    const local = screenToBoardPoint(svg, e.clientX, e.clientY)
    if (!local) return
    // Snap to existing committed geometry (+ ortho) before committing the
    // vertex; `snapDraftPoint` is a no-op when the snap toggle is off.
    const snapped = snapDraftPoint({ x: clamp(local.x, 0, 100), y: clamp(local.y, 0, 100) })
    sdispatch({
      type: 'PLACE_POINT',
      point: { x: round2(snapped.x), y: round2(snapped.y) },
    })
  }

  const minPoints = tool === 'polygon' ? 3 : tool === 'arc' ? 3 : tool === 'lineal' ? 2 : 1
  const canSave =
    !create.isPending &&
    Boolean(serviceItemCode) &&
    draftQuantity > 0 &&
    (mode === 'manual' || draftPoints.length >= minPoints)

  const onSave = async () => {
    if (!canSave) return
    setError(null)
    setSavedToast(null)
    try {
      let geometry: MeasurementGeometry
      let quantity: number | undefined
      if (mode === 'manual') {
        // Manual entry has no drawn geometry. We still persist a valid
        // measurement: a single synthetic count point keeps the row inside
        // the API's geometry normalizer, and `quantity` carries the typed
        // value (the server trusts an explicit quantity over the geometry
        // for count rows).
        geometry = { kind: 'count', points: [{ x: 50, y: 50 }] }
        quantity = round2(Number(manualQty))
      } else if (tool === 'polygon') {
        // Stamp the per-axis page scale + pitch so the server computes true
        // sqft (board-space stays the fallback when uncalibrated/flat).
        geometry = {
          kind: 'polygon',
          points: draftPoints,
          ...worldScaleStamp(worldScale, appliesScale),
          ...pitchStamp(activePitch, pitchAppliesToTool),
        }
      } else if (tool === 'lineal') {
        if (linHasHeight) {
          // LIN → area: persist the explicit length × height area so the row
          // contributes square footage, not raw length (msg21). No scale/pitch
          // stamp — the explicit quantity drives this path.
          geometry = { kind: 'lineal', points: draftPoints }
          quantity = round2(linealLength * wallHeight)
        } else {
          geometry = {
            kind: 'lineal',
            points: draftPoints,
            ...worldScaleStamp(worldScale, appliesScale),
            ...pitchStamp(activePitch, pitchAppliesToTool),
          }
        }
      } else if (tool === 'arc') {
        // ARC tessellates its 3 control points into a lineal polyline (same
        // geometry kind, no new model) carrying the scale + pitch stamps.
        geometry = {
          kind: 'lineal',
          points: arcCurve ?? draftPoints,
          ...worldScaleStamp(worldScale, appliesScale),
          ...pitchStamp(activePitch, pitchAppliesToTool),
        }
      } else {
        geometry = { kind: 'count', points: draftPoints }
      }
      const isDeduction = mode === 'draw' && tool === 'polygon' && deduct
      const res = await create.mutateAsync({
        blueprint_document_id: activeBlueprint?.id ?? null,
        page_id: activePage?.id ?? null,
        service_item_code: serviceItemCode,
        unit: unitForItem,
        ...(quantity !== undefined ? { quantity } : {}),
        geometry,
        ...(isDeduction ? { is_deduction: true } : {}),
        // Land on the selected draft; null falls back to the project default.
        draft_id: activeDraftId,
        // Tag the active condition when one is picked (null = legacy flow).
        condition_id: activeConditionId,
        // Tag the building face (N/S/E/W/roof) from the machine draft slice.
        elevation: sctx.draft.elevation,
      })
      // COMMIT-equivalent UI reset through the machine (persistence already
      // happened above via the existing create hook — hybrid dep wiring).
      if (mode !== 'manual') resetDraftPoints()
      setWallHeight(0)
      setDeduct(false)
      if (mode === 'manual') setManualQty('')
      setSavedToast(
        'queued' in res && res.queued
          ? 'Saved offline — will sync when you reconnect.'
          : `Added ${formatQty(draftQuantity)} ${unitForItem} of ${serviceItemCode}.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  // Persist the drawn reference line as the page calibration (parity with the
  // desktop SCALE overlay). The two board points + typed real-world length flow
  // through the shared `calibratePage` mutation; once saved, `worldScale`
  // recomputes and new measurements carry true sqft/lf. Returns to draw mode.
  const applyScale = async () => {
    setScaleError(null)
    if (!activePage) {
      setScaleError('Open a sheet page first.')
      return
    }
    if (scalePoints.length < 2) {
      setScaleError('Tap two points of a known dimension on the sheet.')
      return
    }
    const [a, b] = scalePoints as [{ x: number; y: number }, { x: number; y: number }]
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
      setSavedToast('Sheet scale saved — new measurements read in real units.')
      setMode('draw')
    } catch (err) {
      setScaleError(err instanceof Error ? err.message : 'Could not save the scale.')
    }
  }

  // Create a condition inline (name + color + kind) and make it active so the
  // next draw tags it. Mirrors the desktop create-condition flow.
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
      setError(e instanceof Error ? e.message : 'Create condition failed')
    }
  }

  // Measurements scoped to what we're currently looking at: the whole draft
  // when no page is focused, or the active page when one is.
  const draftMeasurements = measurements.data?.measurements ?? []

  // --- Committed-measurement edit actions (msg22) ---------------------------
  const selected = draftMeasurements.find((m) => m.id === selectedId) ?? null
  const selectedIndex = selected
    ? draftMeasurements
        .filter((m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id)
        .indexOf(selected)
    : -1
  const canvasPolyCount = draftMeasurements.filter(
    (m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id,
  ).length

  const reassignSelected = async () => {
    if (!selected) return
    const next =
      typeof window !== 'undefined'
        ? window.prompt('Reassign to scope item code', selected.service_item_code)?.trim()
        : ''
    if (!next || next === selected.service_item_code) return
    setError(null)
    try {
      await patchMeasurement.mutateAsync({
        id: selected.id,
        service_item_code: next,
        expected_version: selected.version,
      })
      setSavedToast(`Reassigned to ${next}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reassign failed')
    }
  }

  const duplicateSelected = async () => {
    if (!selected) return
    setError(null)
    try {
      await create.mutateAsync({
        blueprint_document_id: selected.blueprint_document_id,
        page_id: selected.page_id,
        service_item_code: selected.service_item_code,
        unit: selected.unit,
        quantity: Number(selected.quantity),
        geometry: selected.geometry as MeasurementGeometry,
        draft_id: activeDraftId,
      })
      setSavedToast('Duplicated measurement.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Duplicate failed')
    }
  }

  const deleteSelected = async () => {
    if (!selected) return
    if (typeof window !== 'undefined' && !window.confirm('Delete this measurement?')) return
    setError(null)
    try {
      await deleteMeasurement.mutateAsync({ id: selected.id, expected_version: selected.version })
      sdispatch({ type: 'CLEAR_SELECTION' })
      setSavedToast('Measurement deleted.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  // --- Edit geometry (msg22 vertex drag) ------------------------------------
  const startEditGeom = () => {
    if (!selected) return
    const geo = selected.geometry as MeasurementGeometry
    const pts = geo.points
    if (!pts || pts.length === 0) return
    sdispatch({ type: 'START_EDIT_GEOM', measurementId: selected.id, points: pts.map((p) => ({ x: p.x, y: p.y })) })
  }
  const cancelEditGeom = () => {
    // APPLY_EDIT clears the working edit slice (editGeomId/editPoints). The
    // actual persist is the component's job (hybrid), so cancel and apply both
    // reduce to "drop the working edit set" at the machine level.
    sdispatch({ type: 'APPLY_EDIT' })
    editDragIdxRef.current = null
  }
  const commitEditGeom = async () => {
    const target = editId ? draftMeasurements.find((m) => m.id === editId) : null
    if (!target || editPoints.length === 0) {
      cancelEditGeom()
      return
    }
    const geo = target.geometry as MeasurementGeometry
    setError(null)
    try {
      await patchMeasurement.mutateAsync({
        id: target.id,
        geometry: { ...geo, points: editPoints.map((p) => ({ x: round2(p.x), y: round2(p.y) })) },
        expected_version: target.version,
      })
      setSavedToast('Geometry updated — quantity re-priced.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Edit failed')
    } finally {
      cancelEditGeom()
    }
  }

  // --- Bulk multi-select actions (msg23) ------------------------------------
  const canvasMeasurements = draftMeasurements.filter(
    (m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id,
  )

  // Snap-to-content index over the committed measurements visible on this
  // sheet. The shared engine (`@/lib/takeoff/snapping`) supplies endpoint /
  // midpoint / on-segment latching; `onCanvasTap` runs raw board points through
  // `snapDraftPoint` before dispatching PLACE_POINT so a new vertex closes onto
  // existing geometry instead of landing a fraction of a unit off.
  const snapIndex = useSnapping(canvasMeasurements)
  // Board-unit tolerance (0–100 space) and ortho ("straight wall") threshold,
  // matching the desktop canvas.
  const SNAP_TOLERANCE_BOARD = 1.8
  const ORTHO_THRESHOLD_DEG = 7

  // Resolve a raw board point for placement via the shared resolver: latch onto
  // committed geometry (endpoint > midpoint > on-segment), else a nearby
  // in-progress draft vertex (so a polygon can close onto its own start — the
  // engine only sees committed measurements), else lock to H / V / 45° from the
  // last draft point. With snap OFF the raw point passes through unchanged.
  const snapDraftPoint = (raw: { x: number; y: number }): { x: number; y: number } => {
    if (!snapEnabled) return raw
    return resolveDraftPoint(raw, snapIndex, {
      toleranceBoard: SNAP_TOLERANCE_BOARD,
      orthoThresholdDeg: ORTHO_THRESHOLD_DEG,
      draftPoints,
    })
  }
  const bulkSelected = canvasMeasurements.filter((m) => bulkIds.has(m.id))
  const bulkPolys = bulkSelected.filter((m) => (m.geometry as { kind?: string }).kind === 'polygon').length
  const bulkTotal = round2(bulkSelected.reduce((s, m) => s + (Number(m.quantity) || 0), 0))
  const bulkUnit = new Set(bulkSelected.map((m) => m.unit)).size === 1 ? (bulkSelected[0]?.unit ?? '') : 'mixed'

  // --- Copy / array / mirror (deep-dive H6) --------------------------------
  // The measurements a copy plan acts on: the bulk set when bulk-selecting,
  // otherwise the single selected measurement. Only point-based geometries
  // (polygon / lineal / count) are copyable in board space.
  const copyTargets: TakeoffMeasurement[] =
    bulkMode && bulkSelected.length > 0 ? bulkSelected : selected ? [selected] : []
  const copyableTargets = copyTargets.filter((m) => Array.isArray((m.geometry as MeasurementGeometry).points))

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

  // Run a copy plan: generate the duplicate geometries for each copyable target
  // and save each as a NEW measurement (same scope/unit/sheet/deduct) — server
  // recomputes quantities. Sequential to stay within the offline-queue + API
  // budget. Clears the selection + panel on success.
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
            blueprint_document_id: m.blueprint_document_id,
            page_id: m.page_id,
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
      sdispatch({ type: 'CLEAR_SELECTION' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Copy failed')
    } finally {
      setCopyBusy(false)
    }
  }
  useEffect(() => {
    if (!projectId) return
    const shouldCapture = () => activeBlueprint || canvasMeasurements.length > 0 || draftPoints.length > 0
    const unregisterArtifact = registerCaptureArtifactProvider(
      `takeoff:mobile:${projectId}`,
      async ({ captureSessionId, metadata }) => {
        if (!shouldCapture()) return null
        const payload = buildCanvasGeometryArtifact({
          project_id: projectId,
          route_path: currentCaptureRoutePath(),
          active_draft_id: activeDraftId,
          active_blueprint_id: activeBlueprint?.id ?? null,
          active_page_id: activePage?.id ?? null,
          blueprint: activeBlueprint,
          page: activePage,
          viewport: { mode, tool },
          draft: {
            points: draftPoints,
            quantity: draftQuantity,
            manual_qty: manualQty,
            edit_id: editId,
            edit_points: editPoints,
          },
          selection: {
            selected_id: selectedId,
            bulk_selected_ids: Array.from(bulkIds),
          },
          measurements: canvasMeasurements,
        })
        return uploadCanvasGeometryArtifact(captureSessionId, payload, {
          ...metadata,
          surface: 'mobile_takeoff',
        })
      },
    )
    const unregisterState = registerCaptureStateProvider(`takeoff:mobile:${projectId}`, ({ reason }) => {
      if (!shouldCapture()) return null
      return buildTakeoffCanvasStateSnapshot({
        surface: 'mobile_takeoff',
        project_id: projectId,
        route_path: currentCaptureRoutePath(),
        reason,
        active_draft: activeDraft,
        active_blueprint: activeBlueprint,
        active_page: activePage,
        viewport: {
          mode,
          tool,
          pdf_engine: pdfEngineOn && blueprintIsPdf ? 'pdf' : 'image',
        },
        session: {
          xstate_value: session.value,
          xstate_mode: session.mode,
          machine_tool: sctx.draft.tool,
          overlay: sctx.overlay,
          error: sctx.error,
          draft_point_count: sctx.draft.points.length,
          calibration_point_count: sctx.calibration.points.length,
          selected_id: sctx.selection.selectedId,
          bulk_selected_count: sctx.selection.bulkIds.length,
          edit_geom_id: sctx.selection.editGeomId,
          capture_kind: sctx.capture.kind,
          capture_mode: sctx.capture.mode,
        },
        draft: {
          points: draftPoints,
          quantity: draftQuantity,
          manual_qty: manualQty,
          edit_id: editId,
          edit_points: editPoints,
        },
        selection: {
          selected_id: selectedId,
          bulk_selected_count: bulkIds.size,
        },
        measurements: canvasMeasurements,
      })
    })
    return () => {
      unregisterArtifact()
      unregisterState()
    }
  }, [
    activeBlueprint,
    activeDraft,
    activeDraftId,
    activePage,
    blueprintIsPdf,
    bulkIds,
    canvasMeasurements,
    draftPoints,
    draftQuantity,
    editId,
    editPoints,
    manualQty,
    mode,
    pdfEngineOn,
    projectId,
    sctx,
    selectedId,
    session.mode,
    session.value,
    tool,
  ])

  const toggleBulk = (id: string) => {
    const next = new Set(sctx.selection.bulkIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    sdispatch({ type: 'BULK_SELECT', ids: Array.from(next) })
  }
  const selectAllBulk = () => sdispatch({ type: 'BULK_SELECT', ids: canvasMeasurements.map((m) => m.id) })
  const clearBulk = () => sdispatch({ type: 'BULK_SELECT', ids: [] })

  const bulkReassign = async () => {
    if (bulkSelected.length === 0) return
    const next = typeof window !== 'undefined' ? window.prompt('Reassign all selected to scope item code')?.trim() : ''
    if (!next) return
    setError(null)
    try {
      for (const m of bulkSelected) {
        await patchMeasurement.mutateAsync({ id: m.id, service_item_code: next, expected_version: m.version })
      }
      setSavedToast(`Reassigned ${bulkSelected.length} to ${next}.`)
      clearBulk()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk reassign failed')
    }
  }

  const bulkDelete = async () => {
    if (bulkSelected.length === 0) return
    if (typeof window !== 'undefined' && !window.confirm(`Delete ${bulkSelected.length} measurements?`)) return
    setError(null)
    try {
      for (const m of bulkSelected) {
        await deleteMeasurement.mutateAsync({ id: m.id, expected_version: m.version })
      }
      setSavedToast(`Deleted ${bulkSelected.length} measurements.`)
      clearBulk()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk delete failed')
    }
  }

  // Canonical signed totals (cutouts subtract) — was a drifted mobile copy that
  // ignored is_deduction and overcounted net quantity.
  const totals = useMemo(() => buildScopeTotals(draftMeasurements), [draftMeasurements])
  const grandTotal = totals.reduce((s, t) => s + t.quantity, 0)

  // --- Render ---------------------------------------------------------------
  const loading = drafts.isLoading || blueprints.isLoading

  // Shared page underlay (PDFium for PDFs, server raster otherwise) reused by
  // the draw + scale canvases so the calibration surface draws over the real
  // sheet, not a blank grid.
  const canvasUnderlay =
    pdfEngineOn && blueprintIsPdf ? (
      pdfDocState.doc ? (
        <PdfPageCanvas
          doc={pdfDocState.doc}
          pageNumber={activePage?.page_number ?? 1}
          scale={3}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', opacity: 0.7 }}
        />
      ) : null
    ) : sourceImage.url ? (
      <img
        src={sourceImage.url}
        alt=""
        draggable={false}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', opacity: 0.7 }}
      />
    ) : null

  return (
    <>
      <MTopBar
        back
        eyebrow="Takeoff"
        title={activeDraft?.name ?? 'Mobile takeoff'}
        sub={
          activeBlueprint
            ? `${activeBlueprint.file_name}${activePage ? ` · pg ${activePage.page_number}` : ''}`
            : undefined
        }
        onBack={() => navigate(`/projects/${projectId}`)}
      />
      <MBody>
        {loading ? (
          <>
            <MSectionH>Loading…</MSectionH>
            <MSkeletonList count={3} />
          </>
        ) : (
          <>
            {/* --- Draft picker --- */}
            <MSectionH link="New takeoff" onLinkClick={onCreateDraft}>
              Takeoff drafts
            </MSectionH>
            {draftList.length === 0 ? (
              <MEmptyState
                title="No takeoff yet"
                body="Create a takeoff draft to start measuring. You can keep multiple drafts (e.g. base bid vs. alternate) per project."
                primaryLabel={createDraft.isPending ? 'Creating…' : 'Start a takeoff'}
                onPrimary={onCreateDraft}
              />
            ) : (
              <>
                <div style={{ padding: '0 16px 4px' }}>
                  <MChipRow>
                    {draftList.map((d) => (
                      <MChip key={d.id} active={d.id === activeDraftId} onClick={() => setActiveDraft(d.id)}>
                        {d.name}
                        {d.status === 'archived' ? ' (archived)' : ''}
                      </MChip>
                    ))}
                  </MChipRow>
                </div>
                {activeDraftId ? (
                  <div style={{ padding: '4px 16px 0' }}>
                    <MButton variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
                      <MI.FileText size={15} /> Import CSV / TSV
                    </MButton>
                  </div>
                ) : null}
                {/* Capture pipelines (migrated from v1) — RoomPlan / photogrammetry
                    / drone JSON upload + dry-run blueprint, each landing a new
                    AI-proposed draft the estimator reviews on the canvas. */}
                {activeDraftId ? (
                  <div style={{ padding: '8px 16px 0' }}>
                    <CapturePanel projectId={projectId} onCaptured={(id) => setActiveDraft(id)} />
                  </div>
                ) : null}
                {/* AI-captured quantity review/promote (closes the capture→
                    review→promote loop migrated from v1). Shown when the active
                    draft has un-promoted AI proposals. */}
                {activeDraft && activeDraft.review_required ? (
                  <div style={{ padding: '8px 16px 0' }}>
                    <AgentSuggestionsPanel projectId={projectId} draft={activeDraft} />
                  </div>
                ) : null}
              </>
            )}

            {draftList.length > 0 ? (
              <>
                {/* --- Blueprint / page picker --- */}
                <MSectionH>Blueprint</MSectionH>
                {blueprintList.length === 0 ? (
                  <div style={{ padding: '0 16px 8px', fontSize: 13, color: 'var(--m-ink-3)', lineHeight: 1.5 }}>
                    No drawings uploaded. You can still enter manual quantities per scope item below.
                  </div>
                ) : (
                  <>
                    <div style={{ padding: '0 16px 4px' }}>
                      <MChipRow>
                        <MChip active={!activeBlueprint} onClick={() => setActiveBlueprint(null)}>
                          No drawing
                        </MChip>
                        {blueprintList.map((b) => (
                          <MChip
                            key={b.id}
                            active={b.id === activeBlueprint?.id}
                            onClick={() => setActiveBlueprint(b.id)}
                          >
                            {b.file_name}
                          </MChip>
                        ))}
                      </MChipRow>
                    </div>
                    {activeBlueprint && pages.length > 1 ? (
                      <div style={{ padding: '0 16px 4px' }}>
                        <MChipRow>
                          {pages.map((p) => (
                            <MChip key={p.id} active={p.id === activePage?.id} onClick={() => setActivePage(p.id)}>
                              pg {p.page_number}
                            </MChip>
                          ))}
                        </MChipRow>
                      </div>
                    ) : null}
                    {activeBlueprint && pages.length > 1 ? (
                      <div style={{ padding: '4px 16px 0' }}>
                        <MButton
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            navigate(`/projects/${projectId}/takeoff-ai/cross-link?blueprint=${activeBlueprint.id}`)
                          }
                        >
                          <Spark size={13} state="strong" /> Cross-sheet callouts
                        </MButton>
                      </div>
                    ) : null}
                  </>
                )}

                {/* --- MobileMode toggle: manual / draw / (set scale) --- */}
                <div style={{ padding: '8px 16px 0' }}>
                  <SegmentedControl
                    options={[
                      { value: 'manual', label: 'Manual qty' },
                      { value: 'draw', label: 'Draw on page' },
                      // Set-scale needs a sheet page to calibrate against.
                      ...(activeBlueprint && activePage ? [{ value: 'scale', label: 'Set scale' }] : []),
                    ]}
                    value={mode}
                    onChange={(v) => {
                      // The machine syncs to the new mode in an effect (START_DRAW
                      // on 'draw', START_CALIBRATION on 'scale', CANCEL — which
                      // clears the draft — on 'manual'), so no explicit clearing here.
                      setMode(v as MobileMode)
                      setError(null)
                      setScaleError(null)
                    }}
                  />
                </div>

                {/* --- AI launch button (hidden while calibrating) --- */}
                {mode !== 'scale' ? (
                  <MobileAiLaunch onLaunch={() => navigate(`/projects/${projectId}/takeoff-ai`)} />
                ) : null}

                {/* --- Scale calibration surface --- */}
                {mode === 'scale' ? (
                  <div style={{ padding: '10px 16px 0' }}>
                    <MobileCanvasSurface
                      svgRef={svgRef}
                      tool={tool}
                      deduct={false}
                      onTap={onCanvasTap}
                      draftPoints={[]}
                      measurements={canvasMeasurements}
                      selectedId={null}
                      bulkIds={null}
                      onSelectMeasurement={() => {}}
                      underlay={canvasUnderlay}
                      editId={null}
                      editPoints={[]}
                      editDragIdxRef={editDragIdxRef}
                      onEditPoint={() => {}}
                      scalePoints={scalePoints}
                    />
                    <MobileScalePanel
                      scalePoints={scalePoints}
                      scaleLength={scaleLength}
                      onScaleLength={setScaleLength}
                      scaleError={scaleError}
                      onApply={() => void applyScale()}
                      onCancel={() => {
                        setScaleError(null)
                        setMode('draw')
                      }}
                      applyPending={calibratePage.isPending}
                    />
                  </div>
                ) : null}

                {/* --- Canvas (draw mode) --- */}
                {mode === 'draw' ? (
                  <div style={{ padding: '10px 16px 0' }}>
                    <MobileToolToolbar
                      toolLabel={toolLabel}
                      onPickTool={(pickedTool, label) => {
                        // SET_TOOL resets the in-progress draft points in
                        // the machine (the old setDraftPoints([]) is now
                        // implicit), and we make sure we're on the draw
                        // surface so the next tap places a point.
                        sdispatch({ type: 'SET_TOOL', tool: pickedTool })
                        if (session.matches('idle')) sdispatch({ type: 'START_DRAW' })
                        setToolLabel(label)
                        setWallHeight(0)
                        cancelEditGeom()
                      }}
                    />
                    {/* Deduct/cutout toggle (msg19 "WIN") — only meaningful for
                        an area (polygon/rect) tool. */}
                    {tool === 'polygon' ? (
                      <MobileDeductToggle deduct={deduct} onToggle={() => setDeduct((d) => !d)} />
                    ) : null}
                    {/* Pitch → slope-corrected area (parity with desktop). Shown
                        for the sloped-surface tools (polygon area, plain lineal
                        run); hidden once a wall height drives the lineal area. */}
                    {pitchAppliesToTool ? (
                      <PitchPanel
                        rise={pitchRise}
                        run={pitchRun}
                        onRise={setPitchRise}
                        onRun={setPitchRun}
                        factor={pitchFactor}
                      />
                    ) : null}
                    {/* Bulk-select toggle (msg23) — switches canvas taps from
                        draw to multi-select. */}
                    {canvasMeasurements.length > 0 ? (
                      <MobileBulkSelectToggle
                        bulkMode={bulkMode}
                        bulkSelectedCount={bulkSelected.length}
                        canvasMeasurementCount={canvasMeasurements.length}
                        onToggle={() => {
                          setBulkMode((b) => !b)
                          // CLEAR_SELECTION resets selectedId + bulkIds + the edit
                          // slice in one go; resetDraftPoints drops any in-progress
                          // draft while keeping the draw surface live.
                          sdispatch({ type: 'CLEAR_SELECTION' })
                          resetDraftPoints()
                          editDragIdxRef.current = null
                        }}
                        onSelectAll={selectAllBulk}
                      />
                    ) : null}
                    <MobileCanvasSurface
                      svgRef={svgRef}
                      tool={tool}
                      deduct={deduct}
                      onTap={onCanvasTap}
                      draftPoints={bulkMode ? [] : draftPoints}
                      measurements={canvasMeasurements}
                      selectedId={bulkMode ? null : selectedId}
                      bulkIds={bulkMode ? bulkIds : null}
                      onSelectMeasurement={(id) => {
                        if (editId) return // handles own the gestures while editing
                        if (bulkMode) toggleBulk(id)
                        // Toggle single selection through the machine: tapping the
                        // already-selected row clears it.
                        else sdispatch({ type: 'SELECT_MEASUREMENT', measurementId: selectedId === id ? null : id })
                      }}
                      underlay={canvasUnderlay}
                      editId={editId}
                      editPoints={editPoints}
                      editDragIdxRef={editDragIdxRef}
                      onEditPoint={(idx, p) =>
                        sdispatch({ type: 'DRAG_VERTEX', index: idx, point: { x: p.x, y: p.y } })
                      }
                      arcPreview={tool === 'arc' ? arcCurve : null}
                    />
                    {/* Bulk selection footer (msg23). */}
                    {bulkMode && bulkSelected.length > 0 ? (
                      <MobileBulkFooter
                        bulkPolys={bulkPolys}
                        bulkTotal={bulkTotal}
                        bulkUnit={bulkUnit}
                        bulkSelectedCount={bulkSelected.length}
                        copyOpen={copyOpen}
                        reassignPending={patchMeasurement.isPending}
                        deletePending={deleteMeasurement.isPending}
                        onReassign={() => void bulkReassign()}
                        onToggleCopy={() => setCopyOpen((v) => !v)}
                        onDelete={() => void bulkDelete()}
                      />
                    ) : null}
                    {/* Copy / array / mirror panel (deep-dive H6). Renders when the
                        COPY… toggle is on and a copyable measurement is selected
                        (single or bulk). Saves NEW measurements via the create
                        path — same item/unit/sheet — so quantities recompute. */}
                    {copyOpen && copyableTargets.length > 0 ? (
                      <MobileCopyPanel
                        copyableCount={copyableTargets.length}
                        copyDx={copyDx}
                        copyDy={copyDy}
                        copyCount={copyCount}
                        copyMirror={copyMirror}
                        copyRotate={copyRotate}
                        copyBusy={copyBusy}
                        onCopyDx={setCopyDx}
                        onCopyDy={setCopyDy}
                        onCopyCount={setCopyCount}
                        onCopyMirror={setCopyMirror}
                        onCopyRotate={setCopyRotate}
                        onRun={(mode) => void runCopyPlan(mode)}
                      />
                    ) : null}
                    {/* Edit-committed-measurement action bar (msg22). Appears when a
                        saved polygon on the canvas is tapped. Hidden in bulk mode:
                        the machine's BULK_SELECT sets `selectedId` when exactly one
                        row is in the set, but the single-select bar must not show
                        while multi-selecting (the canvas masks selection the same
                        way via `bulkMode ? null : selectedId`). */}
                    {selected && !bulkMode ? (
                      <>
                        <div style={{ marginTop: 8, background: 'var(--m-ink)', border: '2px solid var(--m-ink)' }}>
                          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--m-ink-2)' }}>
                            <div
                              style={{
                                fontFamily: 'var(--m-num)',
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: '0.06em',
                                color: 'var(--m-accent)',
                              }}
                            >
                              {editId === selected.id
                                ? 'EDIT GEOM · DRAG A HANDLE'
                                : `SELECTED · POLY ${selectedIndex >= 0 ? selectedIndex + 1 : 1} OF ${canvasPolyCount} · ${selected.service_item_code}`}
                            </div>
                            <div
                              style={{
                                fontFamily: 'var(--m-font-display)',
                                fontWeight: 800,
                                fontSize: 26,
                                lineHeight: 1,
                                marginTop: 4,
                                color: 'var(--m-sand)',
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              {formatQty(Number(selected.quantity))}
                              <span style={{ fontSize: 13, color: 'var(--m-ink-4)', marginLeft: 6 }}>
                                {selected.unit?.toUpperCase()}
                              </span>
                            </div>
                          </div>
                          <div style={{ display: 'flex' }}>
                            {(editId === selected.id
                              ? ([
                                  {
                                    label: patchMeasurement.isPending ? 'SAVING…' : 'APPLY',
                                    sub: 'SAVE SHAPE',
                                    on: () => void commitEditGeom(),
                                    danger: false,
                                  },
                                  { label: 'CANCEL', sub: 'DISCARD', on: cancelEditGeom, danger: false },
                                ] as const)
                              : ([
                                  {
                                    label: 'EDIT GEOM',
                                    sub: 'DRAG PTS',
                                    on: startEditGeom,
                                    danger: false,
                                  },
                                  {
                                    label: 'REASSIGN',
                                    sub: 'CHANGE ITEM',
                                    on: () => void reassignSelected(),
                                    danger: false,
                                  },
                                  {
                                    label: 'DUPLICATE',
                                    sub: 'NEW POLY',
                                    on: () => void duplicateSelected(),
                                    danger: false,
                                  },
                                  {
                                    label: copyOpen ? 'COPY ✕' : 'COPY…',
                                    sub: 'ARRAY / MIRROR',
                                    on: () => setCopyOpen((v) => !v),
                                    danger: false,
                                  },
                                  { label: 'DELETE', sub: 'REMOVE', on: () => void deleteSelected(), danger: true },
                                ] as const)
                            ).map((a, i, arr) => (
                              <button
                                key={a.label}
                                type="button"
                                onClick={a.on}
                                disabled={patchMeasurement.isPending || deleteMeasurement.isPending || create.isPending}
                                style={{
                                  flex: 1,
                                  padding: '12px 6px',
                                  background: 'transparent',
                                  color: a.danger ? 'var(--m-red)' : 'var(--m-sand)',
                                  border: 'none',
                                  borderRight: i < arr.length - 1 ? '1px solid var(--m-ink-2)' : 'none',
                                  fontFamily: 'var(--m-num)',
                                  cursor: 'pointer',
                                  textAlign: 'center',
                                }}
                              >
                                <span
                                  style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' }}
                                >
                                  {a.label}
                                </span>
                                <span
                                  style={{
                                    display: 'block',
                                    fontSize: 9,
                                    fontWeight: 600,
                                    marginTop: 2,
                                    color: 'var(--m-ink-4)',
                                  }}
                                >
                                  {a.sub}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                        {/* Assembly attach (PlanSwift "drop assembly onto a takeoff")
                          — parity with desktop. Hidden during geometry edit. The
                          panel is form-factor-agnostic (mobile primitives). */}
                        {editId !== selected.id ? (
                          <div
                            style={{
                              marginTop: 8,
                              padding: '12px 14px',
                              background: 'var(--m-bg)',
                              border: '2px solid var(--m-ink)',
                            }}
                          >
                            <AssemblyAttachPanel measurement={selected} />
                          </div>
                        ) : null}
                        {/* Multi-condition tag sheet trigger (parity with v1's
                            long-press → tag sheet). Below the action bar to avoid
                            crowding the button row. */}
                        {editId !== selected.id ? (
                          <MButton variant="ghost" size="sm" onClick={() => setTagSheetMeasurementId(selected.id)}>
                            <MI.Layers size={14} /> Tags / conditions
                          </MButton>
                        ) : null}
                      </>
                    ) : null}
                    {/* Live measurement strip — brutalist eyebrow + big-number readout
                        on an ink slab; Undo/Clear as mono chips. */}
                    <MobileMeasurementStrip
                      tool={tool}
                      pointCount={draftPoints.length}
                      draftQuantity={draftQuantity}
                      onUndo={() => sdispatch({ type: 'UNDO_POINT' })}
                      onClear={() => resetDraftPoints()}
                    />
                    {/* LIN → area: wall-height step (msg21). Once a lineal trace
                        exists, set a wall height to convert length into area. */}
                    {tool === 'lineal' && draftPoints.length >= 2 ? (
                      <WallHeightPanel
                        lengthLabel={`${formatQty(linealLength)} LF`}
                        height={wallHeight}
                        onHeight={setWallHeight}
                        areaLabel={linHasHeight ? formatQty(round2(linealLength * wallHeight)) : null}
                        lengthValue={linealLength}
                      />
                    ) : null}
                    {/* The phone now renders the real PDF page underlay (PDFium) —
                        no more blank-grid fallback. */}
                  </div>
                ) : null}

                {/* Scope entry + running totals are hidden while calibrating. */}
                {mode !== 'scale' ? (
                  <>
                    {/* --- Scope item + quantity entry --- */}
                    <MSectionH>Scope item</MSectionH>
                    <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {/* Condition picker (parity with desktop) — pick/create the
                          reusable typed template the next draw is tagged against. */}
                      <ConditionPicker
                        conditions={conditions}
                        activeConditionId={activeConditionId}
                        setActiveConditionId={setActiveConditionId}
                        activeCondition={activeCondition}
                        conditionFormOpen={conditionFormOpen}
                        setConditionFormOpen={setConditionFormOpen}
                        newConditionName={newConditionName}
                        setNewConditionName={setNewConditionName}
                        newConditionColor={newConditionColor}
                        setNewConditionColor={setNewConditionColor}
                        newConditionKind={newConditionKind}
                        setNewConditionKind={setNewConditionKind}
                        onCreateCondition={() => void onCreateCondition()}
                        createPending={createCondition.isPending}
                      />
                      {/* Elevation tag (parity with v1) — tags the next draw with
                          a building face for the per-elevation rollup. */}
                      <ElevationPicker
                        value={sctx.draft.elevation}
                        onChange={(next) => sdispatch({ type: 'SET_ELEVATION', elevation: next })}
                      />
                      <MSelect value={serviceItemCode} onChange={(e) => setServiceItemCode(e.target.value)}>
                        {items.length === 0 ? <option value="">Loading…</option> : null}
                        {items.map((it: ServiceItem) => (
                          <option key={it.code} value={it.code}>
                            {it.code} — {it.name}
                          </option>
                        ))}
                      </MSelect>

                      {mode === 'manual' ? (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.06em',
                              color: 'var(--m-ink-3)',
                            }}
                          >
                            Quantity ({unitForItem})
                          </span>
                          <MInput
                            type="number"
                            inputMode="decimal"
                            min={0}
                            step="any"
                            placeholder={`0 ${unitForItem}`}
                            value={manualQty}
                            onChange={(e) => setManualQty(e.target.value)}
                          />
                        </label>
                      ) : null}

                      <MButton variant="primary" onClick={() => void onSave()} disabled={!canSave}>
                        {create.isPending
                          ? 'Saving…'
                          : `Add ${draftQuantity > 0 ? formatQty(draftQuantity) : ''} ${unitForItem}`.trim()}
                      </MButton>

                      {error ? <div style={{ fontSize: 13, color: 'var(--m-red)' }}>{error}</div> : null}
                      {savedToast ? <div style={{ fontSize: 13, color: 'var(--m-green)' }}>{savedToast}</div> : null}
                    </div>

                    {/* --- Running totals by scope item --- */}
                    <MobileRunningTotals
                      totals={totals}
                      measurementCount={draftMeasurements.length}
                      grandTotal={grandTotal}
                      onItemTap={(code) =>
                        navigate(
                          `/projects/${projectId}/takeoff-item/${encodeURIComponent(code)}${
                            activeDraftId ? `?draft=${activeDraftId}` : ''
                          }`,
                        )
                      }
                      /* M05 msg__30: DONE lands on the quantities summary,
                         which forwards to Price&Send — not straight to
                         pricing (design-fidelity audit #13). */
                      onDone={() => navigate(`/projects/${projectId}/quantities`)}
                    />
                  </>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </MBody>
      {activeDraftId ? (
        <TakeoffImportSheet
          open={importOpen}
          projectId={projectId}
          pageId={activePage?.id ?? null}
          sourceLabel={activeDraft?.name ?? 'csv'}
          onClose={() => setImportOpen(false)}
          onImported={(count) => setSavedToast(`Imported ${count} measurement${count === 1 ? '' : 's'}.`)}
        />
      ) : null}
      <TakeoffTagSheet
        open={tagSheetMeasurementId !== null}
        onClose={() => setTagSheetMeasurementId(null)}
        measurementId={tagSheetMeasurementId}
        defaultQuantity={selected ? Number(selected.quantity) || undefined : undefined}
        defaultUnit={selected?.unit}
      />
    </>
  )
}
