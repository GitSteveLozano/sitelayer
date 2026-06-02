/**
 * Estimator desktop takeoff canvas — Desktop v2 · EST 02 ·
 * "TAKEOFF CANVAS · FULL-BLEED + FLOATING PALETTES".
 *
 * This is the desktop re-layout of the working mobile takeoff surface
 * (`screens/mobile/takeoff-mobile.tsx`). The takeoff DATA + GEOMETRY are
 * reused verbatim — same hooks (`useTakeoffDrafts`, `useProjectBlueprints`,
 * `useBlueprintPages`, `useProjectMeasurements`, `useCreateMeasurement`,
 * `useServiceItems`), the same `@sitelayer/domain` geometry helpers
 * (`calculatePolygonArea` / `calculateLinealLength` / `calculatePolygonCentroid`),
 * the same `tool` state, the same 0–100 board-space `viewBox="0 0 100 100"`,
 * and the same `onCanvasTap` getScreenCTM/inverse math. Rows written here are
 * interchangeable with the mobile surface.
 *
 * Only the CHROME changes: instead of a stacked phone column, the SVG fills
 * the full-bleed `.d-content-full` area on a dark grid, and the controls
 * become floating palettes positioned absolutely over it — (1) a TOOL palette
 * top-left, (2) an ITEM / quantities palette on the right with the live
 * readout + running grand total, and (3) a top strip with the sheet name and
 * a DONE/total action. No takeoff logic is reinvented.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  calculateLinealLengthScaled,
  calculatePolygonAreaScaled,
  calculatePolygonCentroid,
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
import { useAuthenticatedObjectUrl } from '@/lib/api/blob-url'
import { currentCaptureRoutePath } from '@/lib/capture-session'
import { registerCaptureArtifactProvider } from '@/lib/capture-artifact-providers'
import { useAssemblies, useAttachAssemblyToMeasurement, useExplodeAssembly, type Assembly } from '@/lib/api/assemblies'
import { formatMoney } from '../mobile/format.js'
import { EstAiCountSetupPanel } from './est-ai-count'
import { EstAiTakeoffSetupPanel } from './est-ai-takeoff'
import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { buildCanvasGeometryArtifact, uploadCanvasGeometryArtifact } from '@/lib/takeoff/canvas-geometry-artifact'
import { arcPolyline } from '@/lib/takeoff/arc'
import { clamp, round2, screenToBoardPoint } from '@/lib/takeoff/canvas-math'
import { buildScopeTotals, formatQty } from '@/lib/takeoff/canvas-totals'
import { detectSheetScale, type DetectedScale } from '@/lib/takeoff/sheet-scale'
import { solveWorldScale, type WorldScale } from '@/lib/takeoff/world-scale'
import { PdfPageCanvas, usePdfDocument } from '@/lib/pdf/pdf-page-canvas'
import { useRole } from '@/lib/role'
import { MButton, MPill, MSelect } from '@/components/m'
import { DEmptyState } from '@/components/d'

/** Accept filter for the blueprint file input — PDF plan sets + images.
 * The upload control itself is gated to admin/foreman/office (owner/foreman
 * personas), matching the API role gate on POST /api/projects/:id/blueprints. */
const BLUEPRINT_UPLOAD_ACCEPT = 'application/pdf,image/*'

type Tool = 'polygon' | 'rect' | 'lineal' | 'arc' | 'count'

// Canvas interaction modes layered over the drawing surface (ported from
// Steve's Desktop v2 mockup `DCanvasScale` / `DCanvasItemPalette` /
// `DCanvasEditMeasure` / `DCanvasBulkSelect` in /tmp/steve3/04_app.js).
//   draw   — default; tap to add points to a draft measurement.
//   scale  — calibrate the sheet scale from a drawn reference line.
//   select — marquee / multi-select committed measurements for bulk actions.
type CanvasMode = 'draw' | 'scale' | 'select' | 'ai-count' | 'ai-takeoff'

const MAX_POLYGON_POINTS = 64

// Canvas zoom bounds (PlanSwift-style navigation).
const MIN_ZOOM = 0.4
const MAX_ZOOM = 12

// Cross-sheet callout (dsg__50 "EST CANVAS · CROSS-SHEET REF JUMP"). A detail
// callout (e.g. "B3") drawn on one sheet references a detail on another. The
// extraction pipeline that would emit { page_id, tag, target_page_idx, x, y }
// rows does not exist yet, so the callout POSITIONS + targets are
// presentational — but the sheet list they jump BETWEEN is the REAL page list,
// so clicking one genuinely opens the referenced page (same honest GAP as the
// shipped mobile cross-link `takeoff-cross-link.tsx`).
type SheetCallout = {
  tag: string
  /** board-space (0–100) position of the callout circle on the source sheet */
  x: number
  y: number
  detail: string
  /** index into the real page list this callout jumps to (clamped at render) */
  targetPageIdx: number
}
const SHEET_CALLOUTS: SheetCallout[] = [
  { tag: 'A1', x: 22, y: 30, detail: 'Wall section A1', targetPageIdx: 1 },
  { tag: 'B3', x: 58, y: 48, detail: 'Detail B3 · parapet flashing', targetPageIdx: 2 },
]

export function EstCanvas() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

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

  // --- Entry state (identical semantics to mobile draw mode) ----------------
  const [tool, setTool] = useState<Tool>('polygon')
  const [serviceItemCode, setServiceItemCode] = useState('')
  // Which division performs this scope item (Cavy, WhatsApp:227-229). An item
  // can be curated to several divisions (e.g. EPS under EIFS, or under a
  // different division on a non-EIFS job); the picker below lets the estimator
  // choose. Defaults to the item's first curated division.
  const [divisionCode, setDivisionCode] = useState('')
  const [draftPoints, setDraftPoints] = useState<TakeoffPoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savedToast, setSavedToast] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // --- Zoom + pan (canvas navigation) --------------------------------------
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [handMode, setHandMode] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)

  // --- Canvas interaction states (Desktop v2 mockup ports) -----------------
  const [mode, setMode] = useState<CanvasMode>('draw')
  // Scale-calibration overlay (DCanvasScale): the real-world length the user
  // types for the reference line they drew. Provisional until applied.
  const [scaleLength, setScaleLength] = useState('24')
  // The two board-space points of the reference line clicked in SCALE mode.
  const [scalePoints, setScalePoints] = useState<TakeoffPoint[]>([])
  const [scaleError, setScaleError] = useState<string | null>(null)
  const calibratePage = useCalibratePage()
  // Item command-palette (DCanvasItemPalette): "/"-triggered scope-item picker.
  const [itemPaletteOpen, setItemPaletteOpen] = useState(false)
  const [itemQuery, setItemQuery] = useState('')
  // When set, the next item picked in the palette REASSIGNS these committed
  // measurements instead of setting the draft item (REASSIGN actions).
  const [reassignIds, setReassignIds] = useState<string[] | null>(null)
  // Edit popover (DCanvasEditMeasure): the single committed measurement that
  // is currently selected for reassign / duplicate / delete.
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null)
  // Bulk-select toolbar (DCanvasBulkSelect): the set of measurements picked
  // while in marquee/select mode.
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(() => new Set())
  // Interactive vertex-drag edit (dsg__48 "EDIT MEASUREMENT"). When EDIT GEOM
  // is engaged on a single selected measurement, its committed vertices become
  // draggable handles. `editGeomId` is the measurement under edit; `editPoints`
  // is the working (unsaved) point set; `editDragIdx` is the vertex currently
  // being dragged. Dropping a vertex PATCHes the new geometry (server recomputes
  // the quantity) — no redraw-from-scratch round trip.
  const [editGeomId, setEditGeomId] = useState<string | null>(null)
  const [editPoints, setEditPoints] = useState<TakeoffPoint[]>([])
  const editDragIdxRef = useRef<number | null>(null)
  // Redo stack for draft points (PlanSwift-style undo/redo): UNDO pushes the
  // popped vertex here, REDO pops it back. Any new vertex / tool change / save
  // clears it (you can't redo into a diverged draft).
  const [redoStack, setRedoStack] = useState<TakeoffPoint[]>([])
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

  // Cross-sheet callout jump (dsg__50). `showCallouts` toggles the callout
  // markers over the sheet; `jumpedFrom` remembers the sheet we jumped FROM so
  // the "JUMPED FROM …" panel can offer a one-click RETURN. The callouts are
  // only meaningful in draw mode (they overlay the takeoff surface).
  const [showCallouts, setShowCallouts] = useState(false)
  const [jumpedFrom, setJumpedFrom] = useState<{ pageId: string; label: string } | null>(null)

  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

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

  // --- Geometry (unchanged from mobile) ------------------------------------
  const draftQuantity = useMemo(() => {
    // Mirror the server's quantity math: when the page is calibrated, the live
    // running quantity reads in real sqft/lf, not board-space units.
    const wx = worldScale?.wx ?? 1
    const wy = worldScale?.wy ?? 1
    if (tool === 'polygon' || tool === 'rect') return round2(calculatePolygonAreaScaled(draftPoints, wx, wy))
    if (tool === 'lineal') return round2(calculateLinealLengthScaled(draftPoints, wx, wy))
    if (tool === 'arc') return arcCurve ? round2(calculateLinealLengthScaled(arcCurve, wx, wy)) : 0
    return draftPoints.length
  }, [tool, draftPoints, arcCurve, worldScale])

  // Screen→board mapping uses the shared `screenToBoardPoint` CTM transform
  // (`@/lib/takeoff/canvas-math`), the same one the mobile + projects canvases use.
  const onCanvasTap = (e: ReactPointerEvent<SVGSVGElement>) => {
    // In select/scale mode the canvas tap is not a draft-point append: select
    // mode tapping empty space clears the marquee selection; scale mode lets
    // the calibration overlay drive instead. Only draw mode appends points.
    if (mode !== 'draw') {
      if (mode === 'select') {
        setBulkSelected(new Set())
        setSelectedMeasurementId(null)
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
    setRedoStack([])
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
      setScalePoints([])
      setMode('draw')
    } catch (err) {
      setScaleError(err instanceof Error ? err.message : 'Could not save the scale.')
    }
  }

  // --- Zoom + pan (PlanSwift-style canvas navigation) ----------------------
  // The drawing math above relies on svg.getScreenCTM(), which already folds
  // in the CSS transform on the zoom wrapper below — so a click still maps to
  // the correct 0–100 board point at any zoom/pan. No change to onCanvasTap.
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])
  useEffect(() => {
    panRef.current = pan
  }, [pan])

  // Zoom by `factor` around a point (cx, cy) given in container pixels so the
  // content under that point stays put (cursor- or center-anchored).
  const applyZoom = (factor: number, cx: number, cy: number) => {
    const z = zoomRef.current
    const nz = clamp(z * factor, MIN_ZOOM, MAX_ZOOM)
    if (nz === z) return
    const p = panRef.current
    const ux = (cx - p.x) / z
    const uy = (cy - p.y) / z
    setZoom(nz)
    setPan({ x: cx - ux * nz, y: cy - uy * nz })
  }
  const zoomBy = (factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    applyZoom(factor, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2)
  }
  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Non-passive wheel listener: preventDefault stops the PAGE from scrolling
  // (Steve's "scrolling issues") and zooms toward the cursor instead.
  useEffect(() => {
    const cont = containerRef.current
    if (!cont) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = cont.getBoundingClientRect()
      applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top)
    }
    cont.addEventListener('wheel', onWheel, { passive: false })
    return () => cont.removeEventListener('wheel', onWheel)
    // Re-run when loading flips: the container ref is null during the loading
    // early-return, so the listener must (re)attach once the canvas mounts.
    // applyZoom reads live zoom/pan via refs, so those aren't deps.
  }, [drafts.isLoading, blueprints.isLoading])

  // Hold Space to pan (Figma-style), but never while typing in an input.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && /^(input|textarea|select)$/i.test(t.tagName)
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault()
        setSpaceHeld(true)
      }
    }
    const ku = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => {
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
    }
  }, [])

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

  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
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
    if (e.button === 1 || e.button === 2 || spaceHeld || handMode) {
      e.preventDefault()
      e.currentTarget.setPointerCapture?.(e.pointerId)
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: panRef.current.x, panY: panRef.current.y }
      setPanning(true)
      return
    }
    if (mode === 'draw' && tool === 'rect') {
      const p = clientToBoard(e.clientX, e.clientY)
      if (p) {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        boxStartRef.current = p
        setBoxRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
        setDraftPoints([])
        setRedoStack([])
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
      if (p) setEditPoints((prev) => prev.map((pt, i) => (i === dragIdx ? { x: p.x, y: p.y } : pt)))
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
    const start = panStartRef.current
    if (!start) return
    setPan({ x: start.panX + (e.clientX - start.x), y: start.panY + (e.clientY - start.y) })
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
          setBulkSelected(inside)
          setSelectedMeasurementId(inside.size === 1 ? (Array.from(inside)[0] ?? null) : null)
        } else {
          setBulkSelected(new Set())
          setSelectedMeasurementId(null)
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
    if (panStartRef.current) {
      panStartRef.current = null
      setPanning(false)
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    }
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
      // RECT produces a polygon; ARC tessellates its 3 control points into a
      // lineal polyline. Both reuse the existing geometry kinds — no new model.
      if (tool === 'polygon' || tool === 'rect') geometry = { kind: 'polygon', points: draftPoints, ...scale }
      else if (tool === 'arc') geometry = { kind: 'lineal', points: arcCurve ?? draftPoints, ...scale }
      else if (tool === 'lineal') geometry = { kind: 'lineal', points: draftPoints, ...scale }
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
      })
      setDraftPoints([])
      setRedoStack([])
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

  // All committed vertices on this sheet — snap targets so a new measurement
  // can latch onto the corner of an existing one (PlanSwift vertex snapping).
  const committedVertices = useMemo<TakeoffPoint[]>(() => {
    const out: TakeoffPoint[] = []
    for (const m of blueprintMeasurements) {
      const geo = m.geometry as MeasurementGeometry
      if (geo.points) for (const p of geo.points) out.push({ x: p.x, y: p.y })
    }
    return out
  }, [blueprintMeasurements])

  // Snap a raw board-space point: first to a nearby existing vertex, else lock
  // to horizontal/vertical from the previous draft point when within a small
  // angular threshold. Pure — returns the raw point unchanged when snap is off
  // or nothing is in range.
  const snapPoint = (raw: TakeoffPoint): TakeoffPoint => {
    if (!snapEnabled) return raw
    const SNAP_VERTEX_DIST = 1.4 // board units (0–100 space)
    let best: TakeoffPoint | null = null
    let bestD = SNAP_VERTEX_DIST
    for (const p of draftPoints) {
      const d = Math.hypot(p.x - raw.x, p.y - raw.y)
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    for (const p of committedVertices) {
      const d = Math.hypot(p.x - raw.x, p.y - raw.y)
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    if (best) return { x: best.x, y: best.y }
    const prev = draftPoints[draftPoints.length - 1]
    if (prev) {
      const dx = raw.x - prev.x
      const dy = raw.y - prev.y
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)
      const tanThreshold = Math.tan((6 * Math.PI) / 180) // ~6°
      if (adx > 0.01 || ady > 0.01) {
        if (ady <= adx * tanThreshold) return { x: raw.x, y: prev.y } // horizontal lock
        if (adx <= ady * tanThreshold) return { x: prev.x, y: raw.y } // vertical lock
      }
    }
    return raw
  }

  // Undo/redo over draft vertices. UNDO pops the last point and stashes it so
  // REDO can replay it; REDO pulls the most-recent stashed point back on.
  const undoPoint = () => {
    const last = draftPoints[draftPoints.length - 1]
    if (!last) return
    setRedoStack((r) => [...r, last])
    setDraftPoints((p) => p.slice(0, -1))
  }
  const redoPoint = () => {
    const next = redoStack[redoStack.length - 1]
    if (!next) return
    setRedoStack((r) => r.slice(0, -1))
    setDraftPoints((p) => [...p, next])
  }
  const totals = useMemo(() => buildScopeTotals(draftMeasurements), [draftMeasurements])
  const grandTotal = totals.reduce((s, t) => s + t.quantity, 0)

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

  // Per-page calibration status for the floating SHEETS panel (design dsg__06 /
  // dsg__46). A page is VERIFIED once it carries a saved calibration; the page
  // actively being calibrated reads SETTING; the rest are UNCAL.
  const pageScaleStatus = (p: BlueprintPage): { label: string; tone: 'green' | 'amber' | 'ink' } => {
    if (mode === 'scale' && p.id === activePage?.id) return { label: 'SETTING…', tone: 'amber' }
    return p.calibration_set_at ? { label: '✓ VERIFIED', tone: 'green' } : { label: 'UNCAL', tone: 'ink' }
  }

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
    setBulkSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelectedMeasurementId(next.size === 1 ? (Array.from(next)[0] ?? null) : null)
      return next
    })
  }

  // In SELECT mode a pointer-down that lands on a measurement must NOT start a
  // canvas marquee — let the shape's own click toggle it instead. Stopping
  // propagation here keeps click-to-toggle and drag-to-marquee from colliding.
  const onShapePointerDown = (e: ReactPointerEvent<SVGElement>) => {
    if (mode === 'select') e.stopPropagation()
  }

  const clearSelection = () => {
    setSelectedMeasurementId(null)
    setBulkSelected(new Set())
    setEditGeomId(null)
    setEditPoints([])
    editDragIdxRef.current = null
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

  // Interactive "edit geometry" (dsg__48): engage in-place vertex drag on the
  // selected measurement. Its existing vertices become draggable handles; the
  // shape is edited live and re-priced on drop (see commitEditGeom). Stays in
  // SELECT mode so the contextual bar remains anchored to this measurement.
  const onEditGeom = () => {
    if (!selectedMeasurement) return
    const geo = selectedMeasurement.geometry as MeasurementGeometry
    const pts = geo.points
    if (!pts || pts.length === 0) return
    setEditGeomId(selectedMeasurement.id)
    setEditPoints(pts.map((p) => ({ x: p.x, y: p.y })))
  }

  const cancelEditGeom = () => {
    setEditGeomId(null)
    setEditPoints([])
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
      setReassignIds(null)
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
    return (
      <div className="d-content-full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          Loading takeoff…
        </span>
      </div>
    )
  }

  const sheetLabel = activeBlueprint
    ? `${activeBlueprint.file_name}${activePage ? ` · pg ${activePage.page_number}` : ''}`
    : 'No drawing — grid only'

  const canvasCursor = panning ? 'grabbing' : handMode || spaceHeld ? 'grab' : 'crosshair'

  // Floating-palette shared chrome (translated from template .dt-float / .dt-float-head).
  const floatBox = (extra: React.CSSProperties): React.CSSProperties => ({
    position: 'absolute',
    background: 'var(--m-sand)',
    border: '2px solid var(--m-ink)',
    boxShadow: '6px 6px 0 var(--m-ink)',
    ...extra,
  })
  const floatHead: React.CSSProperties = {
    padding: '10px 14px',
    borderBottom: '2px solid var(--m-ink)',
    background: 'var(--m-ink)',
    color: 'var(--m-accent)',
    fontFamily: 'var(--m-num)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  }

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
                    </text>
                  ) : null
                })()
              : null}
          </svg>
        </div>
      </div>

      {/* ---- Top strip: sheet name + DONE / total ---- */}
      <div
        style={floatBox({
          top: 16,
          left: 16,
          right: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '12px 16px',
          boxShadow: '6px 6px 0 var(--m-ink)',
        })}
      >
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
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
            Takeoff · {activeDraft?.name ?? 'Untitled'}
          </span>
          <span
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 18,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {sheetLabel}
          </span>
          {detectedScale ? (
            <span
              title={
                detectedScale.labeled
                  ? 'Drawing scale detected from the title block'
                  : 'Possible drawing scale found on this sheet'
              }
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.04em',
                color: 'var(--m-accent)',
                whiteSpace: 'nowrap',
              }}
            >
              SCALE {detectedScale.label}
              {detectedScale.labeled ? '' : ' (?)'}
            </span>
          ) : null}
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
          <span style={{ textAlign: 'right' }}>
            <span
              style={{
                display: 'block',
                fontFamily: 'var(--m-num)',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
              }}
            >
              Total qty
            </span>
            <span
              style={{
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 22,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatQty(grandTotal)}
            </span>
          </span>
          <MButton variant="primary" onClick={() => navigate(`/desktop/estimate/${projectId}`)}>
            Done →
          </MButton>
        </span>
      </div>

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
      <div style={floatBox({ top: 92, left: 16, width: 56 })}>
        <div style={{ ...floatHead, padding: '8px 0', textAlign: 'center' }}>TOOL</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {(
            [
              { kind: 'draw', tool: 'polygon', label: 'POLY' },
              { kind: 'draw', tool: 'rect', label: 'RECT' },
              { kind: 'draw', tool: 'lineal', label: 'LIN' },
              { kind: 'draw', tool: 'arc', label: 'ARC' },
              { kind: 'draw', tool: 'count', label: 'PT' },
              { kind: 'draw', tool: 'tap', label: 'TAP' },
              // SCALE / SEL are interaction modes (DCanvasScale / DCanvasBulkSelect),
              // not new geometry tools — they layer overlays over the same canvas.
              { kind: 'mode', mode: 'scale', label: 'SCALE' },
              { kind: 'mode', mode: 'select', label: 'SEL' },
            ] as const
          ).map((t, i, arr) => {
            const isDraw = t.kind === 'draw'
            // RECT is a real drag-rectangle area tool; TAP is an alias for the
            // count tool (mobile-surface naming). All other draw buttons map
            // 1:1 to their geometry tool.
            const value: Tool = isDraw ? (t.tool === 'tap' ? 'count' : (t.tool as Tool)) : 'polygon'
            const on = isDraw
              ? mode === 'draw' &&
                ((t.tool === 'polygon' && tool === 'polygon') ||
                  (t.tool === 'rect' && tool === 'rect') ||
                  (t.tool === 'lineal' && tool === 'lineal') ||
                  (t.tool === 'arc' && tool === 'arc') ||
                  (t.tool === 'count' && tool === 'count') ||
                  // TAP highlights when the count tool is active.
                  (t.tool === 'tap' && tool === 'count'))
              : mode === t.mode
            return (
              <button
                key={t.label}
                type="button"
                onClick={() => {
                  // Don't silently discard a drawn-but-unsaved measurement when
                  // switching tools/modes (e.g. after a failed save, clicking
                  // SEL used to wipe the polygon with no warning).
                  if (draftPoints.length > 0 && !window.confirm('Discard the unsaved measurement you are drawing?'))
                    return
                  if (isDraw) {
                    setMode('draw')
                    setTool(value)
                  } else {
                    setMode(t.mode)
                  }
                  setDraftPoints([])
                  setRedoStack([])
                  setSelectedMeasurementId(null)
                  setBulkSelected(new Set())
                  cancelEditGeom()
                }}
                style={{
                  width: 56,
                  height: 48,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: on ? 'var(--m-accent)' : 'var(--m-sand)',
                  color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  border: 'none',
                  borderTop: t.kind === 'mode' && arr[i - 1]?.kind === 'draw' ? '2px solid var(--m-ink)' : 'none',
                  borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: '0.04em',
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ---- VIEW palette (zoom + pan), below the TOOL palette ---- */}
      <div style={floatBox({ top: 456, left: 16, width: 56 })}>
        <div style={{ ...floatHead, padding: '8px 0', textAlign: 'center' }}>VIEW</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {(
            [
              { label: '＋', title: 'Zoom in', onClick: () => zoomBy(1.25) },
              { label: `${Math.round(zoom * 100)}%`, title: 'Reset view', onClick: resetView, small: true },
              { label: '－', title: 'Zoom out', onClick: () => zoomBy(0.8) },
              { label: '⤢', title: 'Fit to screen', onClick: resetView },
              {
                label: '✋',
                title: 'Pan (or hold Space / middle-drag)',
                onClick: () => setHandMode((h) => !h),
                toggle: 'hand' as const,
              },
              {
                // Cross-sheet callout overlay (dsg__50): show the detail-reference
                // circles so a click jumps to the referenced sheet.
                label: 'REF',
                title: 'Cross-sheet detail callouts — click a circle to jump',
                onClick: () => setShowCallouts((s) => !s),
                toggle: 'refs' as const,
              },
            ] as const
          ).map((b, i, arr) => {
            const active =
              'toggle' in b ? (b.toggle === 'hand' ? handMode : b.toggle === 'refs' ? showCallouts : false) : false
            return (
              <button
                key={b.title}
                type="button"
                title={b.title}
                aria-label={b.title}
                aria-pressed={'toggle' in b ? active : undefined}
                onClick={b.onClick}
                style={{
                  width: 56,
                  height: 40,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: active ? 'var(--m-accent)' : 'var(--m-sand)',
                  color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                  border: 'none',
                  borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                  fontFamily: 'var(--m-num)',
                  fontSize: 'small' in b && b.small ? 10 : 16,
                  fontWeight: 800,
                  letterSpacing: '0.02em',
                  cursor: 'pointer',
                }}
              >
                {b.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ---- AI ASSIST palette (top-right, left of the item palette) ----
          Launcher for the AI setup flows. The setup routes
          (/desktop/ai-count/:projectId, /desktop/ai-takeoff/:projectId)
          already exist in desktop-workspace.tsx; this palette is what makes
          them reachable from the working takeoff canvas. (DEstTakeoffCanvas
          top-right "● AI ASSIST" palette in Steve's Desktop v2 mockup.) */}
      <div style={floatBox({ top: 92, right: 312, width: 220 })}>
        <div style={floatHead}>● AI Assist</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {(
            [
              { label: 'AUTO-COUNT A SYMBOL', mode: 'ai-count' as const },
              { label: 'AUTO-TAKEOFF JOB', mode: 'ai-takeoff' as const },
            ] as const
          ).map((b, i, arr) => (
            <button
              key={b.label}
              type="button"
              onClick={() => {
                // Don't silently discard an in-progress (drawn but unsaved) measurement.
                if (draftPoints.length > 0 && !window.confirm('Discard the unsaved measurement you are drawing?'))
                  return
                setMode(b.mode)
              }}
              disabled={!projectId}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '12px 14px',
                background: 'var(--m-sand)',
                color: 'var(--m-ink)',
                border: 'none',
                borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.04em',
                cursor: projectId ? 'pointer' : 'default',
                opacity: projectId ? 1 : 0.4,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--m-num)',
                  fontWeight: 800,
                  fontSize: 11,
                  color: 'var(--m-accent-ink)',
                  background: 'var(--m-accent)',
                  padding: '1px 6px',
                  flexShrink: 0,
                }}
                aria-hidden
              >
                AI
              </span>
              {b.label}
            </button>
          ))}
        </div>
      </div>

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
                setDraftPoints([])
                setRedoStack([])
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
        <div
          style={floatBox({
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 420,
          })}
        >
          <div style={floatHead}>● Set scale · {activeBlueprint?.file_name ?? 'sheet'}</div>
          <div style={{ padding: 24 }}>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                color: 'var(--m-ink-3)',
                fontWeight: 600,
                lineHeight: 1.5,
              }}
            >
              {scalePoints.length < 2
                ? `CLICK TWO POINTS OF A KNOWN DIMENSION ON THE SHEET (${scalePoints.length}/2), THEN ENTER ITS LENGTH:`
                : 'ENTER THE REAL-WORLD LENGTH OF THE LINE YOU DREW:'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 6,
                  padding: '12px 14px',
                  background: 'var(--m-card-soft)',
                  border: '2px solid var(--m-ink)',
                }}
              >
                <input
                  value={scaleLength}
                  onChange={(e) => setScaleLength(e.target.value.replace(/[^\d.]/g, ''))}
                  inputMode="decimal"
                  aria-label="Real-world length"
                  style={{
                    width: 80,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 800,
                    fontSize: 32,
                    color: 'var(--m-ink)',
                  }}
                />
                <span style={{ fontSize: 16, color: 'var(--m-ink-3)', fontWeight: 700 }}>FT</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                {/* Provisional drawing-scale ratio (= 1:N · PROVISIONAL), shown
                    once a line + length are present — matches design dsg__46. */}
                {provisionalRatio != null ? (
                  <div
                    style={{
                      fontFamily: 'var(--m-font-display)',
                      fontSize: 16,
                      fontWeight: 800,
                      color: 'var(--m-ink)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    = 1:{provisionalRatio}
                  </div>
                ) : (
                  <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, color: 'var(--m-ink-3)', fontWeight: 600 }}>
                    {scalePoints.length}/2 PTS
                  </div>
                )}
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    color: scalePoints.length >= 2 ? 'var(--m-amber)' : 'var(--m-ink-3)',
                    fontWeight: 700,
                    marginTop: 3,
                  }}
                >
                  {scalePoints.length >= 2 ? '● PROVISIONAL' : '○ DRAW LINE'}
                </div>
              </div>
            </div>
            {scaleError ? (
              <div style={{ color: 'var(--m-red)', fontSize: 12, fontWeight: 600, marginTop: 10 }}>{scaleError}</div>
            ) : null}
            <div
              style={{
                padding: '12px 14px',
                background: 'var(--m-accent)',
                color: 'var(--m-accent-ink)',
                marginTop: 16,
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 600,
                lineHeight: 1.5,
              }}
            >
              AI can detect + verify scale on all sheets at once.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <MButton
                variant="ghost"
                onClick={applyScale}
                disabled={scalePoints.length < 2 || calibratePage.isPending}
              >
                {calibratePage.isPending ? 'Saving…' : 'Apply to sheet'}
              </MButton>
              <MButton variant="primary" onClick={() => navigate(`/desktop/scale/${projectId}`)}>
                AI verify all
              </MButton>
            </div>
          </div>
        </div>
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
          onReviewDraft={(id) => navigate(`/desktop/ai-takeoff/${projectId}/review`, { state: { draftId: id } })}
        />
      ) : null}

      {/* ---- DCanvasItemPalette · "/"-style scope-item command palette ---- */}
      {itemPaletteOpen ? (
        <div
          style={floatBox({
            top: 120,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 520,
          })}
        >
          <div
            style={{
              padding: '14px 18px',
              borderBottom: '2px solid var(--m-ink)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--m-card)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontWeight: 800,
                fontSize: 14,
                color: 'var(--m-accent-ink)',
                background: 'var(--m-accent)',
                padding: '2px 8px',
              }}
              aria-hidden
            >
              /
            </span>
            <input
              autoFocus
              value={itemQuery}
              onChange={(e) => setItemQuery(e.target.value)}
              placeholder="Assign item…"
              aria-label="Assign scope item"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 700,
                fontSize: 18,
                color: 'var(--m-ink)',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && paletteItems[0]) {
                  applyItemPick(paletteItems[0].code)
                } else if (e.key === 'Escape') {
                  setItemPaletteOpen(false)
                  setReassignIds(null)
                }
              }}
            />
            <span style={{ fontFamily: 'var(--m-num)', fontSize: 10, color: 'var(--m-ink-3)', fontWeight: 600 }}>
              ↑↓ NAVIGATE · ⏎ SELECT
            </span>
          </div>
          {paletteItems.length === 0 ? (
            <div style={{ padding: '14px 18px', fontSize: 13, color: 'var(--m-ink-3)' }}>No matching items.</div>
          ) : (
            paletteItems.map((it, i) => {
              const hot = it.code === serviceItemCode || (serviceItemCode === '' && i === 0)
              return (
                <button
                  key={it.code}
                  type="button"
                  onClick={() => applyItemPick(it.code)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px 18px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    background: hot ? 'var(--m-accent)' : 'var(--m-card)',
                    color: hot ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                    border: 'none',
                    borderBottom: '1px solid var(--m-line-2)',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--m-num)',
                      fontSize: 9,
                      fontWeight: 700,
                      width: 54,
                      color: hot ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                    }}
                  >
                    {it.code}
                  </span>
                  <span style={{ flex: 1, fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 15 }}>
                    {it.name}
                  </span>
                  <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>
                    {(it.unit ?? '').toUpperCase()}
                  </span>
                </button>
              )
            })
          )}
        </div>
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
        <div style={floatBox({ bottom: 110, right: 16, width: 200, maxHeight: 240, overflow: 'auto' })}>
          <div style={floatHead}>Sheets · {mode === 'scale' ? 'Scale' : pages.length}</div>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pages.map((p) => {
              const isActive = p.id === activePage?.id
              const st = pageScaleStatus(p)
              const statusColor =
                st.tone === 'green' ? 'var(--m-green)' : st.tone === 'amber' ? 'var(--m-amber)' : 'var(--m-ink-3)'
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPageId(p.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '6px 10px',
                    border: '2px solid var(--m-ink)',
                    background: isActive ? 'var(--m-accent)' : 'var(--m-card)',
                    color: isActive ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    cursor: 'pointer',
                  }}
                >
                  <span>{`pg ${p.page_number}`}</span>
                  {mode === 'scale' ? (
                    <span style={{ fontSize: 9, color: isActive ? 'var(--m-accent-ink)' : statusColor }}>
                      {st.label}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
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

// Ghost-chip button style for UNDO / CLEAR (mono, ink-bordered).
function ghostChip(disabled: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '8px 0',
    background: 'transparent',
    color: 'var(--m-ink)',
    border: '2px solid var(--m-ink)',
    fontFamily: 'var(--m-num)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  }
}

/**
 * PlanSwift Phase 2 — attach an assembly recipe to a committed measurement
 * (the "drop assembly onto a takeoff" moment). Selecting an assembly PATCHes
 * the measurement's `assembly_id`, which makes the next estimate recompute
 * explode it into N priced material/labor/sub/freight lines. We also run the
 * preview-only `/explode` endpoint at the measurement's real quantity so the
 * estimator sees the resulting per-kind cost breakdown inline before leaving
 * the canvas. Unit mismatch between the assembly and the measurement is a soft
 * warning, never a block (pilot estimators know their units).
 */
function AssemblyAttachPanel({ measurement }: { measurement: TakeoffMeasurement }) {
  const assembliesQuery = useAssemblies()
  const attach = useAttachAssemblyToMeasurement()
  const explode = useExplodeAssembly()
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ assemblyId: string; total: number; byKind: Record<string, number> } | null>(
    null,
  )

  const attachedId = measurement.assembly_id ?? ''
  const assemblies = useMemo<Assembly[]>(() => assembliesQuery.data?.assemblies ?? [], [assembliesQuery.data])
  // Surface assemblies whose scope matches this measurement's item first.
  const sorted = useMemo(() => {
    const code = measurement.service_item_code
    return [...assemblies].sort((a, b) => {
      const am = a.service_item_code === code ? 0 : 1
      const bm = b.service_item_code === code ? 0 : 1
      return am - bm || a.name.localeCompare(b.name)
    })
  }, [assemblies, measurement.service_item_code])

  const attachedAssembly = assemblies.find((a) => a.id === attachedId) ?? null
  const measurementQty = Number(measurement.quantity) || 0
  const unitMismatch = attachedAssembly != null && attachedAssembly.unit !== measurement.unit

  // Run the explode preview whenever the attached assembly (or qty) changes.
  useEffect(() => {
    if (!attachedId) {
      setPreview(null)
      return
    }
    let cancelled = false
    explode
      .mutateAsync({
        id: attachedId,
        measurement_quantity: measurementQty,
        measurement_unit: measurement.unit,
        is_deduction: measurement.is_deduction === true,
      })
      .then((res) => {
        if (cancelled) return
        setPreview({ assemblyId: attachedId, total: res.markup.total, byKind: res.resolution.by_kind })
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setPreview(null)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
    // Re-run only when the attached assembly or the measurement's
    // quantity/unit/deduction changes. `explode` is intentionally NOT a dep:
    // the react-query mutation object gets a new reference each render
    // (isPending toggles), so depending on it would loop. (The
    // react-hooks/exhaustive-deps rule is not enabled in this project.)
  }, [attachedId, measurementQty, measurement.unit, measurement.is_deduction])

  const onSelect = (value: string) => {
    setError(null)
    attach.mutate(
      { measurementId: measurement.id, assemblyId: value || null, expectedVersion: measurement.version },
      { onError: (err) => setError(err instanceof Error ? err.message : String(err)) },
    )
  }

  const KIND_LABEL: Record<string, string> = { material: 'Mat', labor: 'Labor', sub: 'Sub', freight: 'Freight' }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--m-ink-3)',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          Assembly
        </span>
        <MSelect
          value={attachedId}
          onChange={(e) => onSelect(e.target.value)}
          disabled={attach.isPending || assembliesQuery.isLoading}
          aria-label="Apply assembly to measurement"
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">{assembliesQuery.isLoading ? 'Loading…' : 'None (flat line)'}</option>
          {sorted.map((a) => (
            <option key={a.id} value={a.id}>
              {a.service_item_code === measurement.service_item_code ? '★ ' : ''}
              {a.name} ({a.unit})
            </option>
          ))}
        </MSelect>
      </div>

      {unitMismatch ? (
        <MPill tone="amber">
          Unit differs: assembly {attachedAssembly?.unit} vs measurement {measurement.unit}
        </MPill>
      ) : null}

      {error ? <span style={{ fontSize: 12, color: 'var(--m-red)' }}>{error}</span> : null}

      {attachedId && preview && preview.assemblyId === attachedId ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
              Explodes at {formatQty(measurementQty)} {measurement.unit}
              {measurement.is_deduction ? ' (deduction)' : ''}
            </span>
            <span className="num" style={{ fontWeight: 800, fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(preview.total)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['material', 'labor', 'sub', 'freight'] as const).map((k) => {
              const v = preview.byKind[k] ?? 0
              if (!v) return null
              return (
                <MPill key={k} tone={k === 'material' ? 'accent' : k === 'labor' ? 'green' : 'amber'}>
                  {KIND_LABEL[k]} {formatMoney(Math.abs(v))}
                </MPill>
              )
            })}
          </div>
        </div>
      ) : attachedId && explode.isPending ? (
        <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>Computing explosion…</span>
      ) : null}
    </div>
  )
}
