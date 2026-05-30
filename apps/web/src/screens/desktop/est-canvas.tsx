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
  calculateLinealLength,
  calculatePolygonArea,
  calculatePolygonCentroid,
  type TakeoffPoint,
} from '@sitelayer/domain'
import {
  ApiError,
  useBlueprintPages,
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
import { EstAiCountSetupPanel } from './est-ai-count'
import { EstAiTakeoffSetupPanel } from './est-ai-takeoff'
import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { PdfPageCanvas, usePdfDocument } from '@/lib/pdf/pdf-page-canvas'
import { useRole } from '@/lib/role'
import { MButton, MPill, MSelect } from '@/components/m'
import { DEmptyState } from '@/components/d'

/** Accept filter for the blueprint file input — PDF plan sets + images.
 * The upload control itself is gated to admin/foreman/office (owner/foreman
 * personas), matching the API role gate on POST /api/projects/:id/blueprints. */
const BLUEPRINT_UPLOAD_ACCEPT = 'application/pdf,image/*'

type Tool = 'polygon' | 'lineal' | 'count'

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

  // Phase 1b (flag-gated): render the ORIGINAL PDF via PDFium for crisp vector
  // zoom instead of the server-rasterized page PNG. Off by default; opt in with
  // localStorage['sitelayer.pdf_engine'] = 'pdfium'. Falls back to the image
  // path for non-PDF blueprints or while the PDF document is still loading.
  const pdfEngineOn = typeof window !== 'undefined' && window.localStorage?.getItem('sitelayer.pdf_engine') === 'pdfium'
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
  const removeMeasurement = useDeleteMeasurement()
  const patchMeasurement = usePatchMeasurement()
  const serviceItems = useServiceItems()
  const items = useMemo(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])

  // --- Entry state (identical semantics to mobile draw mode) ----------------
  const [tool, setTool] = useState<Tool>('polygon')
  const [serviceItemCode, setServiceItemCode] = useState('')
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

  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

  const selectedItem = items.find((i) => i.code === serviceItemCode) ?? null
  const unitForItem = selectedItem?.unit ?? (tool === 'polygon' ? 'sqft' : tool === 'lineal' ? 'lf' : 'ea')

  // --- Geometry (unchanged from mobile) ------------------------------------
  const draftQuantity = useMemo(() => {
    if (tool === 'polygon') return round2(calculatePolygonArea(draftPoints))
    if (tool === 'lineal') return round2(calculateLinealLength(draftPoints))
    return draftPoints.length
  }, [tool, draftPoints])

  // EXACT same CTM math as takeoff-mobile.tsx — do not change.
  const onCanvasTap = (e: ReactPointerEvent<SVGSVGElement>) => {
    // In select/scale mode the canvas tap is not a draft-point append: select
    // mode tapping empty space clears the marquee selection; scale mode lets
    // the calibration overlay drive instead. Only draw mode appends points.
    if (mode !== 'draw') {
      if (mode === 'select') {
        setBulkSelected(new Set())
        setSelectedMeasurementId(null)
      }
      return
    }
    const svg = svgRef.current
    if (!svg) return
    if (tool === 'polygon' && draftPoints.length >= MAX_POLYGON_POINTS) return
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const local = pt.matrixTransform(ctm.inverse())
    setDraftPoints((prev) => [...prev, { x: round2(clamp(local.x, 0, 100)), y: round2(clamp(local.y, 0, 100)) }])
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

  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const onPointerDownCanvas = (e: ReactPointerEvent<SVGSVGElement>) => {
    // Middle-button, Space-hold, or the Hand tool pans instead of drawing.
    if (e.button === 1 || spaceHeld || handMode) {
      e.preventDefault()
      e.currentTarget.setPointerCapture?.(e.pointerId)
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: panRef.current.x, panY: panRef.current.y }
      setPanning(true)
      return
    }
    onCanvasTap(e)
  }
  const onPointerMoveCanvas = (e: ReactPointerEvent<SVGSVGElement>) => {
    const start = panStartRef.current
    if (!start) return
    setPan({ x: start.panX + (e.clientX - start.x), y: start.panY + (e.clientY - start.y) })
  }
  const onPointerUpCanvas = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (panStartRef.current) {
      panStartRef.current = null
      setPanning(false)
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    }
  }

  const minPoints = tool === 'polygon' ? 3 : tool === 'lineal' ? 2 : 1
  const canSave = !create.isPending && Boolean(serviceItemCode) && draftQuantity > 0 && draftPoints.length >= minPoints

  const onSave = async () => {
    if (!canSave) return
    setError(null)
    setSavedToast(null)
    try {
      let geometry: MeasurementGeometry
      if (tool === 'polygon') geometry = { kind: 'polygon', points: draftPoints }
      else if (tool === 'lineal') geometry = { kind: 'lineal', points: draftPoints }
      else geometry = { kind: 'count', points: draftPoints }
      const res = await create.mutateAsync({
        blueprint_document_id: activeBlueprint?.id ?? null,
        page_id: activePage?.id ?? null,
        service_item_code: serviceItemCode,
        // Carry the item's own curated division (e.g. Air Barrier → D5) so the
        // measurement passes the catalog guard instead of falling back to the
        // project division and 422ing. Supports multi-division projects too.
        division_code: selectedItem?.divisions?.[0] ?? null,
        unit: unitForItem,
        geometry,
        draft_id: activeDraftId,
      })
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

  const draftMeasurements = measurements.data?.measurements ?? []
  const blueprintMeasurements = draftMeasurements.filter(
    (m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id,
  )
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

  const clearSelection = () => {
    setSelectedMeasurementId(null)
    setBulkSelected(new Set())
  }

  // Real delete (was a no-op that only cleared the highlight).
  const onDeleteSelected = () => {
    if (!selectedMeasurement) return
    removeMeasurement.mutate({ id: selectedMeasurement.id })
    clearSelection()
  }
  const onBulkDelete = () => {
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

  // Real "edit geometry" (was a no-op): pick the shape back up into the draft
  // (tool + item + points), remove the original, and drop into draw mode so the
  // user can adjust the points and re-save.
  const onEditGeom = () => {
    if (!selectedMeasurement) return
    const geo = selectedMeasurement.geometry as MeasurementGeometry
    if (geo.points) {
      setTool(geo.kind === 'lineal' ? 'lineal' : geo.kind === 'count' ? 'count' : 'polygon')
      setServiceItemCode(selectedMeasurement.service_item_code)
      setDraftPoints(geo.points.map((p) => ({ x: p.x, y: p.y })))
    }
    removeMeasurement.mutate({ id: selectedMeasurement.id })
    clearSelection()
    setMode('draw')
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
                return (
                  <g key={m.id} onClick={onClick} style={{ cursor: interactive ? 'pointer' : undefined }}>
                    <polygon
                      points={geo.points.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill={fillSel}
                      stroke={strokeSel}
                      strokeWidth={strokeWSel}
                    />
                    {c ? (
                      <text x={c.x} y={c.y} fontSize={3} textAnchor="middle" fill="var(--m-accent)" fontWeight={700}>
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
                  <g key={m.id} onClick={onClick} style={{ cursor: interactive ? 'pointer' : undefined }}>
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

            {/* Draft-in-progress (same render as mobile) */}
            {tool === 'polygon' && draftPoints.length >= 3 ? (
              <polygon
                points={draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="rgba(201,138,46,0.2)"
                stroke="var(--m-amber)"
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
            {draftPoints.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={tool === 'count' ? 1 : 0.8} fill="var(--m-amber)" />
            ))}
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

      {/* ---- TOOL palette (top-left, below the strip) ---- */}
      <div style={floatBox({ top: 92, left: 16, width: 56 })}>
        <div style={{ ...floatHead, padding: '8px 0', textAlign: 'center' }}>TOOL</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {(
            [
              { kind: 'draw', tool: 'polygon', label: 'POLY' },
              { kind: 'draw', tool: 'rect', label: 'RECT' },
              { kind: 'draw', tool: 'lineal', label: 'LIN' },
              { kind: 'draw', tool: 'count', label: 'PT' },
              { kind: 'draw', tool: 'tap', label: 'TAP' },
              // SCALE / SEL are interaction modes (DCanvasScale / DCanvasBulkSelect),
              // not new geometry tools — they layer overlays over the same canvas.
              { kind: 'mode', mode: 'scale', label: 'SCALE' },
              { kind: 'mode', mode: 'select', label: 'SEL' },
            ] as const
          ).map((t, i, arr) => {
            const isDraw = t.kind === 'draw'
            // RECT/TAP are aliases that drive the same underlying tool values as
            // the mobile surface (polygon / count); no new geometry is introduced.
            const value: Tool = isDraw
              ? t.tool === 'rect'
                ? 'polygon'
                : t.tool === 'tap'
                  ? 'count'
                  : (t.tool as Tool)
              : 'polygon'
            const on = isDraw
              ? mode === 'draw' &&
                ((t.tool === 'polygon' && tool === 'polygon') ||
                  (t.tool === 'lineal' && tool === 'lineal') ||
                  (t.tool === 'count' && tool === 'count') ||
                  // RECT/TAP highlight when their alias tool is active.
                  (t.tool === 'rect' && tool === 'polygon') ||
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
                  setSelectedMeasurementId(null)
                  setBulkSelected(new Set())
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
                toggle: true,
              },
            ] as const
          ).map((b, i, arr) => {
            const active = 'toggle' in b && b.toggle && handMode
            return (
              <button
                key={b.title}
                type="button"
                title={b.title}
                aria-label={b.title}
                aria-pressed={'toggle' in b && b.toggle ? handMode : undefined}
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
              onClick={() => setDraftPoints((p) => p.slice(0, -1))}
              disabled={draftPoints.length === 0}
              style={ghostChip(draftPoints.length === 0)}
            >
              UNDO
            </button>
            <button
              type="button"
              onClick={() => setDraftPoints([])}
              disabled={draftPoints.length === 0}
              style={ghostChip(draftPoints.length === 0)}
            >
              CLEAR
            </button>
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
              YOU DREW A LINE. ENTER ITS REAL-WORLD LENGTH:
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
                <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, color: 'var(--m-ink-3)', fontWeight: 600 }}>
                  = 1:48
                </div>
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    color: 'var(--m-accent-ink)',
                    fontWeight: 700,
                    marginTop: 3,
                  }}
                >
                  ● PROVISIONAL
                </div>
              </div>
            </div>
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
              <MButton variant="ghost" onClick={() => setMode('draw')}>
                Apply to sheet
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
              SELECTED · {selectedIndex >= 0 ? selectedIndex + 1 : '—'} OF {blueprintMeasurements.length}
            </span>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 24, marginTop: 6 }}>
              {formatQty(Number(selectedMeasurement.quantity))} {selectedMeasurement.unit} ·{' '}
              {selectedMeasurement.service_item_code}
            </div>
          </div>
          {(
            [
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
            ] as const
          ).map((b, i, arr) => (
            <button
              key={b.l}
              type="button"
              onClick={b.action}
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

// ---------------------------------------------------------------------------
// Helpers (copied verbatim from takeoff-mobile.tsx — same totals + math)
// ---------------------------------------------------------------------------
interface ScopeTotal {
  code: string
  quantity: number
  unit: string
  count: number
  mixedUnits: boolean
}

function buildScopeTotals(measurements: TakeoffMeasurement[]): ScopeTotal[] {
  const buckets = new Map<string, { quantity: number; units: Set<string>; count: number }>()
  for (const m of measurements) {
    const bucket = buckets.get(m.service_item_code) ?? { quantity: 0, units: new Set<string>(), count: 0 }
    bucket.quantity += Number(m.quantity) || 0
    bucket.units.add(m.unit)
    bucket.count += 1
    buckets.set(m.service_item_code, bucket)
  }
  return Array.from(buckets.entries())
    .map(([code, b]) => ({
      code,
      quantity: round2(b.quantity),
      unit: b.units.size === 1 ? (Array.from(b.units)[0] ?? '') : 'mixed',
      count: b.count,
      mixedUnits: b.units.size > 1,
    }))
    .sort((a, b) => b.quantity - a.quantity)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function formatQty(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (Number.isInteger(n)) return String(n)
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}
