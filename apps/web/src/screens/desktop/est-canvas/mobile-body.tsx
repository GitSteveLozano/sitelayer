import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { calculateLinealLength, calculatePolygonArea } from '@sitelayer/domain'
import {
  useBlueprintPages,
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
// Phase B responsive consolidation: the AI setup panels moved into the merged
// responsive screens (former desktop twins est-ai-count.tsx / est-ai-takeoff.tsx
// were deleted). The standalone float-palette exports are unchanged.

import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { buildCanvasGeometryArtifact, uploadCanvasGeometryArtifact } from '@/lib/takeoff/canvas-geometry-artifact'

import { clamp, round2, screenToBoardPoint } from '@/lib/takeoff/canvas-math'
import { PdfPageCanvas, usePdfDocument } from '@/lib/pdf/pdf-page-canvas'

import { buildDuplicateGeometries, type CopyPlan, type MirrorAxis } from '@/lib/takeoff/copy-transform'
import { buildScopeTotals, formatQty } from '@/lib/takeoff/canvas-totals'

import {
  MBody,
  MButton,
  MChip,
  MChipRow,
  MI,
  MInput,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MSelect,
  MTopBar,
  Spark,
} from '@/components/m'
import { MEmptyState, MSkeletonList } from '@/components/m-states'

import { TakeoffImportSheet } from '../../mobile/takeoff-import-sheet'

import { type MobileTool, type MobileMode } from './types'
import { MAX_POLYGON_POINTS } from './constants'

import { useTakeoffSession, type TakeoffTool } from '@/machines/takeoff-session'
import { resolveTakeoffSeed, TAKEOFF_SEED_NAMES } from '@/machines/takeoff-session-seeds'

import { SegmentedControl, WallHeightPanel, MobileCanvasSurface } from './mobile-components'

// The phone canvas only surfaces three of the machine's six drawing tools
// (POLY/RECT both map to the `polygon` value, plus `lineal` and `count`).
// Narrow the machine's `TakeoffTool` down to the `MobileTool` the surface
// understands so the rest of the body keeps its original, exhaustive
// `polygon | lineal | count` switches without a stray arc/volume/rect branch.
function toMobileTool(tool: TakeoffTool): MobileTool {
  if (tool === 'lineal' || tool === 'arc') return 'lineal'
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
  // (hybrid by design). The dep actors stay unwired here — COMMIT/edit/etc.
  // persist via the EXISTING TanStack-Query mutation hooks, then dispatch the
  // matching machine event to reset the UI slice (so behavior is identical and
  // the async actor wiring is a clean follow-up rather than a risky rewrite).
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

  const session = useTakeoffSession({ projectId, companySlug, seed: initialSeed })
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
  // The tool *label* the user picked (POLY/RECT/LIN/PT). RECT shares the
  // `polygon` tool value, so we track the label separately to highlight the
  // right chip without changing the draw behavior.
  const [toolLabel, setToolLabel] = useState<'POLY' | 'RECT' | 'LIN' | 'PT'>(() => {
    const t = toMobileTool(sctx.draft.tool)
    return t === 'lineal' ? 'LIN' : t === 'count' ? 'PT' : 'POLY'
  })
  const [serviceItemCode, setServiceItemCode] = useState('')
  const [manualQty, setManualQty] = useState('')
  // LIN → area: optional wall height applied to a lineal trace (msg21). When
  // > 0 with the LIN tool, the committed measurement is an AREA (length ×
  // height) rather than raw length.
  const [wallHeight, setWallHeight] = useState<number>(0)
  // Deduct/cutout (msg19 "WIN"): when on, a drawn polygon is saved as a
  // deduction (its area subtracts from the net for its scope item) via the
  // real `is_deduction` field.
  const [deduct, setDeduct] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedToast, setSavedToast] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
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

  // Default the scope item once the catalog loads.
  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

  // Park the machine in the mode that matches the phone surface: 'draw' →
  // `drawing` (so PLACE_POINT lands), 'manual' → `idle`. Selection/edit drive
  // their own machine sub-states from the canvas handlers and are left alone
  // here (only flip when actually entering/leaving the manual↔draw surfaces).
  useEffect(() => {
    if (mode === 'draw') {
      // Land on the draw surface from idle (selecting cancels to idle first).
      if (session.matches('selecting')) sdispatch({ type: 'CANCEL' })
      if (!session.matches('drawing')) sdispatch({ type: 'START_DRAW' })
    } else if (!session.matches('idle')) {
      sdispatch({ type: 'CANCEL' })
    }
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
  // The LIN tool yields an AREA once a wall height is set (msg21).
  const linHasHeight = tool === 'lineal' && wallHeight > 0
  const unitForItem = linHasHeight
    ? 'sqft'
    : (selectedItem?.unit ?? (mode === 'draw' && tool === 'polygon' ? 'sqft' : tool === 'lineal' ? 'lf' : 'ea'))

  const draftQuantity = useMemo(() => {
    if (mode === 'manual') return Number(manualQty) || 0
    if (tool === 'polygon') return round2(calculatePolygonArea(draftPoints))
    if (tool === 'lineal') return linHasHeight ? round2(linealLength * wallHeight) : linealLength
    return draftPoints.length
  }, [mode, tool, manualQty, draftPoints, linHasHeight, linealLength, wallHeight])

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
    // In bulk-select mode an empty-grid tap does nothing (taps land on polys).
    if (bulkMode) return
    // While editing geometry, a background tap is inert — the vertex handles
    // own the gestures, and a stray tap must not deselect or drop a point.
    if (editId) return
    // A tap on the empty grid deselects any committed measurement and starts
    // a fresh draft point.
    if (selectedId) sdispatch({ type: 'CLEAR_SELECTION' })
    if (tool === 'polygon' && draftPoints.length >= MAX_POLYGON_POINTS) return
    const local = screenToBoardPoint(svg, e.clientX, e.clientY)
    if (!local) return
    sdispatch({
      type: 'PLACE_POINT',
      point: { x: round2(clamp(local.x, 0, 100)), y: round2(clamp(local.y, 0, 100)) },
    })
  }

  const minPoints = tool === 'polygon' ? 3 : tool === 'lineal' ? 2 : 1
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
        geometry = { kind: 'polygon', points: draftPoints }
      } else if (tool === 'lineal') {
        geometry = { kind: 'lineal', points: draftPoints }
        // LIN → area: persist the explicit length × height area so the row
        // contributes square footage, not raw length (msg21).
        if (linHasHeight) quantity = round2(linealLength * wallHeight)
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
  // Field + action styling for the mobile copy panel (H6).
  const mCopyLabelStyle: React.CSSProperties = {
    flex: 1,
    fontFamily: 'var(--m-num)',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.04em',
    color: 'var(--m-ink-4)',
  }
  const mCopyInputStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    marginTop: 4,
    padding: '8px 8px',
    border: '2px solid var(--m-ink-2)',
    background: 'var(--m-sand)',
    fontFamily: 'var(--m-num)',
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--m-ink)',
  }
  const mCopyActionStyle: React.CSSProperties = {
    flex: 1,
    padding: '12px 8px',
    border: 'none',
    background: 'var(--m-accent)',
    color: 'var(--m-accent-ink)',
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    cursor: copyBusy ? 'not-allowed' : 'pointer',
    opacity: copyBusy ? 0.6 : 1,
  }

  useEffect(() => {
    if (!projectId) return
    return registerCaptureArtifactProvider(`takeoff:mobile:${projectId}`, async ({ captureSessionId, metadata }) => {
      if (!activeBlueprint && canvasMeasurements.length === 0 && draftPoints.length === 0) return null
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
    })
  }, [
    activeBlueprint,
    activeDraftId,
    activePage,
    bulkIds,
    canvasMeasurements,
    draftPoints,
    draftQuantity,
    editId,
    editPoints,
    manualQty,
    mode,
    projectId,
    selectedId,
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

                {/* --- MobileMode toggle: manual vs draw --- */}
                <div style={{ padding: '8px 16px 0' }}>
                  <SegmentedControl
                    options={[
                      { value: 'manual', label: 'Manual qty' },
                      { value: 'draw', label: 'Draw on page' },
                    ]}
                    value={mode}
                    onChange={(v) => {
                      // The machine syncs to the new mode in an effect (START_DRAW
                      // on 'draw', CANCEL — which clears the draft — on 'manual'),
                      // so no explicit point clearing is needed here.
                      setMode(v as MobileMode)
                      setError(null)
                    }}
                  />
                </div>

                {/* --- AI launch button --- */}
                <div style={{ padding: '10px 16px 0' }}>
                  {/* "● AI" — launches the mobile AI-takeoff flow (chooser → count /
                      auto-takeoff lanes). Brutalist ink slab with the Spark marker. */}
                  <button
                    type="button"
                    onClick={() => navigate(`/projects/${projectId}/takeoff-ai`)}
                    style={{
                      width: '100%',
                      minHeight: 52,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '0 16px',
                      background: 'var(--m-ink)',
                      color: 'var(--m-sand)',
                      border: '2px solid var(--m-ink)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <Spark size={16} state="strong" />
                      <span style={{ minWidth: 0 }}>
                        <span
                          style={{
                            display: 'block',
                            fontFamily: 'var(--m-num)',
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.08em',
                            color: 'var(--m-accent)',
                          }}
                        >
                          AI
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontFamily: 'var(--m-font-display)',
                            fontSize: 16,
                            fontWeight: 800,
                            letterSpacing: '-0.01em',
                            marginTop: 1,
                          }}
                        >
                          Count or draft with AI
                        </span>
                      </span>
                    </span>
                    <MI.ChevRight size={20} />
                  </button>
                </div>

                {/* --- Canvas (draw mode) --- */}
                {mode === 'draw' ? (
                  <div style={{ padding: '10px 16px 0' }}>
                    {/* Mono tool toolbar — square brutalist chips (POLY/RECT/LIN/PT/TAP).
                        POLY/LIN/PT drive the existing draw handlers unchanged. RECT is a
                        polygon alias (tap the 4 corners). TAP hands off to the AI tap-to-
                        detect canvas. */}
                    <div
                      style={{
                        display: 'flex',
                        marginBottom: 8,
                        border: '2px solid var(--m-ink)',
                        background: 'var(--m-card-soft)',
                      }}
                    >
                      {(
                        [
                          { tool: 'polygon', label: 'POLY' },
                          { tool: 'polygon', label: 'RECT' },
                          { tool: 'lineal', label: 'LIN' },
                          { tool: 'count', label: 'PT' },
                          { tool: null, label: 'TAP' },
                        ] as const
                      ).map((t, i, arr) => {
                        // TAP is the AI hand-off (tool: null); never an active draw tool.
                        // RECT shares the polygon tool value, so highlight it only when
                        // its label is the user's pick (tracked alongside the tool).
                        const isTap = t.tool === null
                        const on = isTap ? false : t.label === toolLabel
                        return (
                          <button
                            key={t.label}
                            type="button"
                            onClick={() => {
                              if (t.tool === null) {
                                navigate(`/projects/${projectId}/takeoff-ai/detect`)
                                return
                              }
                              // SET_TOOL resets the in-progress draft points in
                              // the machine (the old setDraftPoints([]) is now
                              // implicit), and we make sure we're on the draw
                              // surface so the next tap places a point.
                              sdispatch({ type: 'SET_TOOL', tool: t.tool })
                              if (session.matches('idle')) sdispatch({ type: 'START_DRAW' })
                              setToolLabel(t.label)
                              setWallHeight(0)
                              cancelEditGeom()
                            }}
                            style={{
                              flex: 1,
                              padding: '14px 0',
                              background: on ? 'var(--m-accent)' : 'transparent',
                              color: isTap ? 'var(--m-accent)' : on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                              border: 'none',
                              borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                              fontFamily: 'var(--m-num)',
                              fontSize: 11,
                              fontWeight: on ? 700 : 600,
                              letterSpacing: '0.06em',
                              cursor: 'pointer',
                            }}
                          >
                            {t.label}
                          </button>
                        )
                      })}
                    </div>
                    {/* Deduct/cutout toggle (msg19 "WIN") — only meaningful for
                        an area (polygon/rect) tool. */}
                    {tool === 'polygon' ? (
                      <button
                        type="button"
                        onClick={() => setDeduct((d) => !d)}
                        aria-pressed={deduct}
                        style={{
                          width: '100%',
                          marginBottom: 8,
                          padding: '10px 12px',
                          background: deduct ? 'var(--m-ink)' : 'transparent',
                          color: deduct ? 'var(--m-sand)' : 'var(--m-ink-2)',
                          border: '2px solid var(--m-ink)',
                          fontFamily: 'var(--m-num)',
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>DEDUCT · CUTOUT (E.G. WINDOW)</span>
                        <span style={{ color: deduct ? 'var(--m-accent)' : 'var(--m-ink-4)' }}>
                          {deduct ? '● ON' : '○ OFF'}
                        </span>
                      </button>
                    ) : null}
                    {/* Bulk-select toggle (msg23) — switches canvas taps from
                        draw to multi-select. */}
                    {canvasMeasurements.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setBulkMode((b) => !b)
                          // CLEAR_SELECTION resets selectedId + bulkIds + the edit
                          // slice in one go; resetDraftPoints drops any in-progress
                          // draft while keeping the draw surface live.
                          sdispatch({ type: 'CLEAR_SELECTION' })
                          resetDraftPoints()
                          editDragIdxRef.current = null
                        }}
                        aria-pressed={bulkMode}
                        style={{
                          width: '100%',
                          marginBottom: 8,
                          padding: '10px 12px',
                          background: bulkMode ? 'var(--m-accent)' : 'transparent',
                          color: bulkMode ? 'var(--m-accent-ink)' : 'var(--m-ink-2)',
                          border: '2px solid var(--m-ink)',
                          fontFamily: 'var(--m-num)',
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>{bulkMode ? `${bulkSelected.length} SELECTED` : 'SELECT MULTIPLE'}</span>
                        {bulkMode ? (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              selectAllBulk()
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.stopPropagation()
                                selectAllBulk()
                              }
                            }}
                            style={{ color: 'var(--m-accent-ink)', textDecoration: 'underline', cursor: 'pointer' }}
                          >
                            SELECT ALL · {canvasMeasurements.length}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--m-ink-4)' }}>○ OFF</span>
                        )}
                      </button>
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
                      underlay={
                        pdfEngineOn && blueprintIsPdf ? (
                          pdfDocState.doc ? (
                            <PdfPageCanvas
                              doc={pdfDocState.doc}
                              pageNumber={activePage?.page_number ?? 1}
                              scale={3}
                              style={{
                                position: 'absolute',
                                inset: 0,
                                width: '100%',
                                height: '100%',
                                objectFit: 'fill',
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
                              objectFit: 'fill',
                              opacity: 0.7,
                            }}
                          />
                        ) : null
                      }
                      editId={editId}
                      editPoints={editPoints}
                      editDragIdxRef={editDragIdxRef}
                      onEditPoint={(idx, p) =>
                        sdispatch({ type: 'DRAG_VERTEX', index: idx, point: { x: p.x, y: p.y } })
                      }
                    />
                    {/* Bulk selection footer (msg23). */}
                    {bulkMode && bulkSelected.length > 0 ? (
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
                            SELECTION · {bulkPolys} POLY{bulkPolys === 1 ? '' : 'S'} · TOTAL
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
                            {formatQty(bulkTotal)}
                            <span style={{ fontSize: 13, color: 'var(--m-ink-4)', marginLeft: 6 }}>
                              {bulkUnit.toUpperCase()}
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex' }}>
                          <button
                            type="button"
                            onClick={() => void bulkReassign()}
                            disabled={patchMeasurement.isPending}
                            style={{
                              flex: 1,
                              padding: '12px 6px',
                              background: 'transparent',
                              color: 'var(--m-sand)',
                              border: 'none',
                              borderRight: '1px solid var(--m-ink-2)',
                              fontFamily: 'var(--m-num)',
                              fontSize: 11,
                              fontWeight: 700,
                              letterSpacing: '0.04em',
                              cursor: 'pointer',
                            }}
                          >
                            REASSIGN ITEM
                          </button>
                          <button
                            type="button"
                            onClick={() => setCopyOpen((v) => !v)}
                            style={{
                              flex: 1,
                              padding: '12px 6px',
                              background: copyOpen ? 'var(--m-accent)' : 'transparent',
                              color: copyOpen ? 'var(--m-accent-ink)' : 'var(--m-sand)',
                              border: 'none',
                              borderRight: '1px solid var(--m-ink-2)',
                              fontFamily: 'var(--m-num)',
                              fontSize: 11,
                              fontWeight: 700,
                              letterSpacing: '0.04em',
                              cursor: 'pointer',
                            }}
                          >
                            {copyOpen ? 'COPY ✕' : 'COPY…'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void bulkDelete()}
                            disabled={deleteMeasurement.isPending}
                            style={{
                              flex: 1,
                              padding: '12px 6px',
                              background: 'transparent',
                              color: 'var(--m-red)',
                              border: 'none',
                              fontFamily: 'var(--m-num)',
                              fontSize: 11,
                              fontWeight: 700,
                              letterSpacing: '0.04em',
                              cursor: 'pointer',
                            }}
                          >
                            DELETE {bulkSelected.length}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {/* Copy / array / mirror panel (deep-dive H6). Renders when the
                        COPY… toggle is on and a copyable measurement is selected
                        (single or bulk). Saves NEW measurements via the create
                        path — same item/unit/sheet — so quantities recompute. */}
                    {copyOpen && copyableTargets.length > 0 ? (
                      <div style={{ marginTop: 8, background: 'var(--m-ink)', border: '2px solid var(--m-ink)' }}>
                        <div
                          style={{
                            padding: '10px 14px',
                            borderBottom: '1px solid var(--m-ink-2)',
                            fontFamily: 'var(--m-num)',
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            color: 'var(--m-accent)',
                          }}
                        >
                          COPY · {copyableTargets.length}{' '}
                          {copyableTargets.length === 1 ? 'MEASUREMENT' : 'MEASUREMENTS'}
                        </div>
                        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <label style={mCopyLabelStyle}>
                              OFFSET X
                              <input
                                type="number"
                                value={copyDx}
                                onChange={(e) => setCopyDx(e.target.value)}
                                style={mCopyInputStyle}
                              />
                            </label>
                            <label style={mCopyLabelStyle}>
                              OFFSET Y
                              <input
                                type="number"
                                value={copyDy}
                                onChange={(e) => setCopyDy(e.target.value)}
                                style={mCopyInputStyle}
                              />
                            </label>
                            <label style={mCopyLabelStyle}>
                              COUNT
                              <input
                                type="number"
                                min={1}
                                value={copyCount}
                                onChange={(e) => setCopyCount(e.target.value)}
                                style={mCopyInputStyle}
                              />
                            </label>
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <label style={mCopyLabelStyle}>
                              MIRROR
                              <select
                                value={copyMirror}
                                onChange={(e) => setCopyMirror(e.target.value as MirrorAxis | 'none')}
                                style={mCopyInputStyle}
                              >
                                <option value="none">None</option>
                                <option value="x">Flip ↔</option>
                                <option value="y">Flip ↕</option>
                              </select>
                            </label>
                            <label style={mCopyLabelStyle}>
                              ROTATE °
                              <input
                                type="number"
                                value={copyRotate}
                                onChange={(e) => setCopyRotate(e.target.value)}
                                style={mCopyInputStyle}
                              />
                            </label>
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              type="button"
                              disabled={copyBusy}
                              onClick={() => void runCopyPlan('offset')}
                              style={mCopyActionStyle}
                            >
                              {copyBusy ? 'COPYING…' : 'COPY OFFSET'}
                            </button>
                            <button
                              type="button"
                              disabled={copyBusy}
                              onClick={() => void runCopyPlan('array')}
                              style={mCopyActionStyle}
                            >
                              ARRAY ×{Math.max(1, Math.floor(Number(copyCount) || 1))}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {/* Edit-committed-measurement action bar (msg22). Appears when a
                        saved polygon on the canvas is tapped. Hidden in bulk mode:
                        the machine's BULK_SELECT sets `selectedId` when exactly one
                        row is in the set, but the single-select bar must not show
                        while multi-selecting (the canvas masks selection the same
                        way via `bulkMode ? null : selectedId`). */}
                    {selected && !bulkMode ? (
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
                    ) : null}
                    {/* Live measurement strip — brutalist eyebrow + big-number readout
                        on an ink slab; Undo/Clear as mono chips. */}
                    <div
                      style={{
                        marginTop: 8,
                        padding: '12px 14px',
                        background: 'var(--m-ink)',
                        color: 'var(--m-sand)',
                        border: '2px solid var(--m-ink)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
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
                            : tool === 'lineal'
                              ? `LIN · ${draftPoints.length} PTS`
                              : `PT · ${draftPoints.length}`}
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--m-font-display)',
                            fontWeight: 800,
                            fontSize: 30,
                            lineHeight: 1,
                            marginTop: 4,
                            color: 'var(--m-sand)',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {tool === 'count' ? `${draftPoints.length}` : formatQty(draftQuantity)}
                          <span style={{ fontSize: 14, color: 'var(--m-ink-4)', marginLeft: 6 }}>
                            {tool === 'polygon'
                              ? 'AREA'
                              : tool === 'lineal'
                                ? 'LEN'
                                : draftPoints.length === 1
                                  ? 'CT'
                                  : 'CTS'}
                          </span>
                        </div>
                      </div>
                      <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={() => sdispatch({ type: 'UNDO_POINT' })}
                          disabled={draftPoints.length === 0}
                          style={{
                            padding: '8px 10px',
                            background: 'transparent',
                            color: 'var(--m-sand)',
                            border: '2px solid var(--m-sand)',
                            fontFamily: 'var(--m-num)',
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            cursor: draftPoints.length === 0 ? 'default' : 'pointer',
                            opacity: draftPoints.length === 0 ? 0.4 : 1,
                          }}
                        >
                          UNDO
                        </button>
                        <button
                          type="button"
                          onClick={() => resetDraftPoints()}
                          disabled={draftPoints.length === 0}
                          style={{
                            padding: '8px 10px',
                            background: 'transparent',
                            color: 'var(--m-sand)',
                            border: '2px solid var(--m-sand)',
                            fontFamily: 'var(--m-num)',
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            cursor: draftPoints.length === 0 ? 'default' : 'pointer',
                            opacity: draftPoints.length === 0 ? 0.4 : 1,
                          }}
                        >
                          CLEAR
                        </button>
                      </span>
                    </div>
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

                {/* --- Scope item + quantity entry --- */}
                <MSectionH>Scope item</MSectionH>
                <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                <MSectionH>Running quantities</MSectionH>
                {totals.length === 0 ? (
                  <div style={{ padding: '0 16px 8px', fontSize: 13, color: 'var(--m-ink-3)', lineHeight: 1.5 }}>
                    No measurements on this draft yet. Add one above — it saves straight to the project takeoff.
                  </div>
                ) : (
                  <>
                    <div style={{ padding: '0 16px 6px', fontSize: 12, color: 'var(--m-ink-3)' }}>
                      {draftMeasurements.length} measurement{draftMeasurements.length === 1 ? '' : 's'} ·{' '}
                      {totals.length} scope item{totals.length === 1 ? '' : 's'}
                    </div>
                    <MListInset>
                      {totals.map((t) => {
                        const share = grandTotal > 0 ? Math.max(2, Math.round((t.quantity / grandTotal) * 100)) : 0
                        return (
                          <MListRow
                            key={t.code}
                            leading={<MI.Layers size={18} />}
                            leadingTone="accent"
                            headline={t.code}
                            chev
                            onTap={() =>
                              navigate(
                                `/projects/${projectId}/takeoff-item/${encodeURIComponent(t.code)}${
                                  activeDraftId ? `?draft=${activeDraftId}` : ''
                                }`,
                              )
                            }
                            supporting={
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                {t.count} measurement{t.count === 1 ? '' : 's'}
                                <span
                                  aria-hidden="true"
                                  style={{
                                    display: 'inline-block',
                                    width: 48,
                                    height: 4,
                                    borderRadius: 2,
                                    background: 'var(--m-line)',
                                    overflow: 'hidden',
                                    verticalAlign: 'middle',
                                  }}
                                >
                                  <span
                                    style={{
                                      display: 'block',
                                      width: `${share}%`,
                                      height: '100%',
                                      background: 'var(--m-accent)',
                                    }}
                                  />
                                </span>
                              </span>
                            }
                            trailing={
                              <span className="num" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                                {formatQty(t.quantity)} {t.mixedUnits ? <MPill>mixed</MPill> : t.unit}
                              </span>
                            }
                          />
                        )
                      })}
                    </MListInset>
                    {/* DONE / running-total — big-number brutalist action.
                        Same navigation handler; grandTotal is view-only. */}
                    <div style={{ padding: '8px 16px 16px' }}>
                      <button
                        type="button"
                        onClick={() => navigate(`/projects/${projectId}/estimate`)}
                        style={{
                          width: '100%',
                          minHeight: 56,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          padding: '0 18px',
                          background: 'var(--m-accent)',
                          color: 'var(--m-accent-ink)',
                          border: '2px solid var(--m-ink)',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--m-num)',
                            fontSize: 12,
                            fontWeight: 700,
                            letterSpacing: '0.08em',
                          }}
                        >
                          DONE
                        </span>
                        <span
                          style={{
                            fontFamily: 'var(--m-font-display)',
                            fontSize: 26,
                            fontWeight: 800,
                            lineHeight: 1,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {formatQty(grandTotal)}
                          <span style={{ fontSize: 12, marginLeft: 6 }}>
                            {totals.length === 1 ? totals[0]?.unit?.toUpperCase() : 'QTY →'}
                          </span>
                        </span>
                      </button>
                    </div>
                  </>
                )}
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
    </>
  )
}
