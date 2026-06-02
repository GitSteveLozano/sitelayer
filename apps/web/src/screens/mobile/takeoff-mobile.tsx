/**
 * `mb-takeoff` — native mobile takeoff surface.
 *
 * The audit found the old `MobileTakeoffList` only *linked out* to the
 * heavy desktop `takeoff-canvas.tsx` (a full-viewport route declared
 * outside the mobile shell). This screen replaces that hop with a
 * phone-first takeoff flow built entirely from the `m-*` mobile
 * primitives, so a foreman/estimator on a phone can run a useful takeoff
 * without ever leaving the mobile shell.
 *
 * It does four things against the existing API (no API changes):
 *   1. Draft management — list / select / create takeoff drafts for the
 *      project (`useTakeoffDrafts` + `useCreateTakeoffDraft`). Active
 *      draft id rides the URL (`?draft=<id>`) so it survives a reload.
 *   2. Blueprint browsing — pick a blueprint and a page; the page image
 *      (when rasterized) is underlaid in the canvas via the shared
 *      `buildBlueprintReference` + `useAuthenticatedObjectUrl` helpers.
 *   3. Measurement entry — two equal-weight paths:
 *        • Manual quantity — type a number per scope item. Always works,
 *          even with no blueprint or an un-rasterized PDF. Writes a real
 *          measurement (`geometry.kind = 'count'`, a single synthetic
 *          point) so the row is valid against the API's geometry
 *          normalizer.
 *        • Draw — tap-to-add polygon / lineal / count points scaled to
 *          the 0–100 board space, with quantity computed by the shared
 *          `@sitelayer/domain` geometry helpers. This is the same board
 *          space + helper set the desktop canvas uses, so rows are
 *          interchangeable.
 *   4. Running totals — quantities grouped by scope item (service_item_code)
 *      for the active draft, summed live as measurements land.
 *
 * Every write goes through `useCreateMeasurement`, which already wraps the
 * offline queue (a tap during an LTE dropout enqueues instead of losing
 * the measurement) and posts to `POST /api/projects/:id/takeoff/measurement`.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  calculateLinealLength,
  calculatePolygonArea,
  calculatePolygonCentroid,
  type TakeoffPoint,
} from '@sitelayer/domain'
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
import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { buildCanvasGeometryArtifact, uploadCanvasGeometryArtifact } from '@/lib/takeoff/canvas-geometry-artifact'
import { clamp, round2, screenToBoardPoint } from '@/lib/takeoff/canvas-math'
import { buildDuplicateGeometries, type CopyPlan, type MirrorAxis } from '@/lib/takeoff/copy-transform'
import { formatQty } from '@/lib/takeoff/canvas-totals'
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
} from '../../components/m/index.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { TakeoffImportSheet } from './takeoff-import-sheet.js'

type Tool = 'polygon' | 'lineal' | 'count'
type Mode = 'manual' | 'draw'

const MAX_POLYGON_POINTS = 64

export function TakeoffMobileScreen({ companySlug }: { companySlug: string }) {
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

  // --- Measurements ---------------------------------------------------------
  const measurements = useProjectMeasurements(projectId, { draftId: activeDraftId })
  const create = useCreateMeasurement(projectId)
  const patchMeasurement = usePatchMeasurement()
  const deleteMeasurement = useDeleteMeasurement()
  const serviceItems = useServiceItems()
  const items = useMemo(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])

  // --- Entry state ----------------------------------------------------------
  const [mode, setMode] = useState<Mode>('manual')
  const [tool, setTool] = useState<Tool>('polygon')
  // The tool *label* the user picked (POLY/RECT/LIN/PT). RECT shares the
  // `polygon` tool value, so we track the label separately to highlight the
  // right chip without changing the draw behavior.
  const [toolLabel, setToolLabel] = useState<'POLY' | 'RECT' | 'LIN' | 'PT'>('POLY')
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
  const [draftPoints, setDraftPoints] = useState<TakeoffPoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savedToast, setSavedToast] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  // Committed-measurement selection (msg22 edit measurement). Tapping a saved
  // polygon on the canvas selects it and opens the REASSIGN/DUPLICATE/DELETE
  // action sheet, all wired to the real measurement PATCH/DELETE/create hooks.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Bulk multi-select (msg23). When on, canvas taps toggle membership in a set
  // (instead of drawing), exposing SELECT ALL + a bulk reassign/delete footer.
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkIds, setBulkIds] = useState<Set<string>>(() => new Set())
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
  // working point set lives here until APPLY PATCHes the new geometry (server
  // recomputes the quantity). `editId` mirrors `selectedId` while editing.
  const [editId, setEditId] = useState<string | null>(null)
  const [editPoints, setEditPoints] = useState<TakeoffPoint[]>([])
  const editDragIdxRef = useRef<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Default the scope item once the catalog loads.
  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

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
    if (selectedId) setSelectedId(null)
    if (tool === 'polygon' && draftPoints.length >= MAX_POLYGON_POINTS) return
    const local = screenToBoardPoint(svg, e.clientX, e.clientY)
    if (!local) return
    setDraftPoints((prev) => [...prev, { x: round2(clamp(local.x, 0, 100)), y: round2(clamp(local.y, 0, 100)) }])
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
      setDraftPoints([])
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
      setSelectedId(null)
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
    setEditId(selected.id)
    setEditPoints(pts.map((p) => ({ x: p.x, y: p.y })))
  }
  const cancelEditGeom = () => {
    setEditId(null)
    setEditPoints([])
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
      mirror: copyMirror === 'none' ? undefined : copyMirror,
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
            elevation: m.elevation ?? undefined,
            geometry: dupe as MeasurementGeometry,
            is_deduction: m.is_deduction ?? false,
            draft_id: activeDraftId,
          })
          made += 1
        }
      }
      setSavedToast(made > 0 ? `Copied ${made} measurement${made === 1 ? '' : 's'}.` : 'Nothing to copy.')
      setCopyOpen(false)
      setSelectedId(null)
      setBulkIds(new Set())
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

  const toggleBulk = (id: string) =>
    setBulkIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const selectAllBulk = () => setBulkIds(new Set(canvasMeasurements.map((m) => m.id)))
  const clearBulk = () => setBulkIds(new Set())

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

                {/* --- Mode toggle: manual vs draw --- */}
                <div style={{ padding: '8px 16px 0' }}>
                  <SegmentedControl
                    options={[
                      { value: 'manual', label: 'Manual qty' },
                      { value: 'draw', label: 'Draw on page' },
                    ]}
                    value={mode}
                    onChange={(v) => {
                      setMode(v as Mode)
                      setDraftPoints([])
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
                              setTool(t.tool)
                              setToolLabel(t.label)
                              setDraftPoints([])
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
                          setSelectedId(null)
                          clearBulk()
                          setDraftPoints([])
                          cancelEditGeom()
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
                    <CanvasSurface
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
                        else setSelectedId((cur) => (cur === id ? null : id))
                      }}
                      sourceImageUrl={sourceImage.url}
                      editId={editId}
                      editPoints={editPoints}
                      editDragIdxRef={editDragIdxRef}
                      onEditPoint={(idx, p) =>
                        setEditPoints((prev) => prev.map((pt, i) => (i === idx ? { x: p.x, y: p.y } : pt)))
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
                        saved polygon on the canvas is tapped. */}
                    {selected ? (
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
                          onClick={() => setDraftPoints((p) => p.slice(0, -1))}
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
                          onClick={() => setDraftPoints([])}
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
                    {blueprintReference && blueprintReference.kind === 'pdf' ? (
                      <div style={{ fontSize: 11, color: 'var(--m-ink-3)', padding: '4px 2px 0' }}>
                        PDF page underlay needs rasterization — draw on the grid, or use Manual qty.
                      </div>
                    ) : null}
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

// ---------------------------------------------------------------------------
// Segmented control — small two/three-up toggle built from m-btn so it
// matches the rest of the mobile design language without a new primitive.
// ---------------------------------------------------------------------------
function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: string; label: string }>
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${options.length}, 1fr)`,
        gap: 4,
        padding: 4,
        borderRadius: 'var(--m-r)',
        background: 'var(--m-card-soft)',
        border: '1px solid var(--m-line)',
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="m-btn m-btn-sm"
          data-variant={value === o.value ? 'primary' : 'quiet'}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wall-height panel (msg21) — converts a committed LIN trace into an area by
// applying a wall height. Presets 8/9/10/12 FT + stepper; "YIELDS AREA" slab
// shows length × height. Height 0 = off (the trace stays raw length).
// ---------------------------------------------------------------------------
const HEIGHT_PRESETS = [8, 9, 10, 12] as const

function WallHeightPanel({
  lengthLabel,
  height,
  onHeight,
  areaLabel,
  lengthValue,
}: {
  lengthLabel: string
  height: number
  onHeight: (h: number) => void
  areaLabel: string | null
  lengthValue: number
}) {
  const active = height > 0
  return (
    <div style={{ marginTop: 8, border: '2px solid var(--m-ink)' }}>
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--m-line-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span className="m-topbar-eyebrow">WALL HEIGHT → AREA</span>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            background: 'var(--m-ink)',
            color: 'var(--m-sand)',
            padding: '3px 8px',
          }}
        >
          {lengthLabel}
        </span>
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 26, minWidth: 64 }}>
          {active ? height : '—'}
          <span style={{ fontSize: 13, color: 'var(--m-ink-3)', marginLeft: 4 }}>FT</span>
        </div>
        <button
          type="button"
          onClick={() => onHeight(Math.max(0, (active ? height : 9) - 1))}
          aria-label="Decrease height"
          style={stepperBtn}
        >
          −
        </button>
        <button
          type="button"
          onClick={() => onHeight((active ? height : 8) + 1)}
          aria-label="Increase height"
          style={{ ...stepperBtn, background: 'var(--m-accent)', color: 'var(--m-accent-ink)' }}
        >
          +
        </button>
      </div>
      <div style={{ padding: '0 14px 12px', display: 'flex', gap: 6 }}>
        {HEIGHT_PRESETS.map((h) => {
          const on = height === h
          return (
            <button
              key={h}
              type="button"
              onClick={() => onHeight(on ? 0 : h)}
              aria-pressed={on}
              style={{
                flex: 1,
                padding: '8px 0',
                background: on ? 'var(--m-accent)' : 'transparent',
                color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-2)',
                border: '2px solid var(--m-ink)',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {h}FT
            </button>
          )
        })}
      </div>
      {active && areaLabel ? (
        <div style={{ padding: '12px 14px', background: 'var(--m-accent)', color: 'var(--m-accent-ink)' }}>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em' }}>
            YIELDS AREA
          </div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 30,
              lineHeight: 1,
              marginTop: 4,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {areaLabel}
            <span style={{ fontSize: 14, marginLeft: 6 }}>SF</span>
          </div>
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 600, marginTop: 4 }}>
            {formatQty(lengthValue)} LF × {height} FT
          </div>
        </div>
      ) : null}
    </div>
  )
}

const stepperBtn: React.CSSProperties = {
  width: 44,
  height: 44,
  background: 'transparent',
  border: '2px solid var(--m-ink)',
  fontFamily: 'var(--m-font-display)',
  fontWeight: 800,
  fontSize: 22,
  lineHeight: 1,
  cursor: 'pointer',
}

// ---------------------------------------------------------------------------
// Canvas — board-space (0–100) SVG overlay matching the desktop canvas so
// rows are interchangeable. Touch-friendly: full-width square, tap to drop
// points. Pinch-zoom is deferred (manual entry covers the no-zoom case).
// ---------------------------------------------------------------------------
interface CanvasSurfaceProps {
  svgRef: React.RefObject<SVGSVGElement | null>
  tool: Tool
  deduct: boolean
  onTap: (e: ReactPointerEvent<SVGSVGElement>) => void
  draftPoints: TakeoffPoint[]
  measurements: TakeoffMeasurement[]
  selectedId: string | null
  /** When non-null the canvas is in bulk-select mode; these ids are highlighted. */
  bulkIds: Set<string> | null
  onSelectMeasurement: (id: string) => void
  sourceImageUrl?: string | null
  /** EDIT GEOM (msg22): the measurement currently in vertex-drag edit, its live
   *  working points, the index of the handle being dragged, and the move sink. */
  editId: string | null
  editPoints: TakeoffPoint[]
  editDragIdxRef: React.MutableRefObject<number | null>
  onEditPoint: (idx: number, p: TakeoffPoint) => void
}

function CanvasSurface({
  svgRef,
  tool,
  deduct,
  onTap,
  draftPoints,
  measurements,
  selectedId,
  bulkIds,
  onSelectMeasurement,
  sourceImageUrl,
  editId,
  editPoints,
  editDragIdxRef,
  onEditPoint,
}: CanvasSurfaceProps) {
  // Map a touch/pointer position to 0–100 board space (same CTM the tap path
  // uses). Used by the vertex-drag handles.
  const toBoard = (clientX: number, clientY: number): TakeoffPoint | null => {
    const svg = svgRef.current
    if (!svg) return null
    const local = screenToBoardPoint(svg, clientX, clientY)
    if (!local) return null
    return { x: clamp(local.x, 0, 100), y: clamp(local.y, 0, 100) }
  }
  const onSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const idx = editDragIdxRef.current
    if (idx === null) return
    const p = toBoard(e.clientX, e.clientY)
    if (p) onEditPoint(idx, p)
  }
  const onSvgPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (editDragIdxRef.current === null) return
    editDragIdxRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '1 / 1',
        background: 'var(--m-ink-2)',
        borderRadius: 0,
        overflow: 'hidden',
        border: '2px solid var(--m-ink)',
      }}
    >
      {sourceImageUrl ? (
        <img
          src={sourceImageUrl}
          alt=""
          draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', opacity: 0.7 }}
        />
      ) : null}
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        onPointerDown={onTap}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onPointerCancel={onSvgPointerUp}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          touchAction: 'none',
          cursor: 'crosshair',
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
            <line key={`h${i}`} x1={0} x2={100} y1={i * 10} y2={i * 10} stroke="var(--m-ink-4)" strokeWidth={0.25} />
          ))}
          {Array.from({ length: 11 }, (_, i) => (
            <line key={`v${i}`} x1={i * 10} x2={i * 10} y1={0} y2={100} stroke="var(--m-ink-4)" strokeWidth={0.25} />
          ))}
        </g>

        {/* Saved measurements on this blueprint */}
        {measurements.map((m) => {
          // The measurement under EDIT GEOM is replaced by the draggable overlay
          // below — skip its static render so the two don't fight.
          if (m.id === editId) return null
          const geo = m.geometry as MeasurementGeometry
          const isSel = m.id === selectedId || (bulkIds?.has(m.id) ?? false)
          const selectGeo = (e: ReactPointerEvent<SVGGElement>) => {
            // Don't fall through to onTap (which would drop a draft point).
            e.stopPropagation()
            onSelectMeasurement(m.id)
          }
          if (geo.kind === 'polygon' && geo.points && geo.points.length >= 3) {
            const c = calculatePolygonCentroid(geo.points)
            const pts = geo.points
            return (
              <g key={m.id} onPointerDown={selectGeo} style={{ cursor: 'pointer' }}>
                <polygon
                  points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill={
                    m.is_deduction ? 'rgba(199,51,30,0.12)' : isSel ? 'rgba(255,212,0,0.28)' : 'rgba(217,144,74,0.18)'
                  }
                  stroke={m.is_deduction ? 'var(--m-red)' : isSel ? 'var(--m-ink)' : 'var(--m-accent)'}
                  strokeWidth={isSel ? 0.7 : 0.4}
                  strokeDasharray={m.is_deduction ? '0.8 0.8' : undefined}
                />
                {/* Resize-handle markers when selected (msg22). */}
                {isSel
                  ? pts.map((p, i) => (
                      <rect
                        key={i}
                        x={p.x - 1.1}
                        y={p.y - 1.1}
                        width={2.2}
                        height={2.2}
                        fill="var(--m-accent)"
                        stroke="var(--m-ink)"
                        strokeWidth={0.4}
                      />
                    ))
                  : null}
                {c ? (
                  <text
                    x={c.x}
                    y={c.y}
                    fontSize={isSel ? 3.4 : 3}
                    textAnchor="middle"
                    fill={isSel ? 'var(--m-ink)' : 'var(--m-accent)'}
                    fontWeight={700}
                  >
                    {m.service_item_code} · {formatQty(Number(m.quantity))}
                  </text>
                ) : null}
              </g>
            )
          }
          if (geo.kind === 'lineal' && geo.points && geo.points.length >= 2) {
            return (
              <polyline
                key={m.id}
                points={geo.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="var(--m-accent)"
                strokeWidth={0.5}
              />
            )
          }
          if (geo.kind === 'count' && geo.points) {
            return (
              <g key={m.id}>
                {geo.points.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={0.8} fill="var(--m-accent)" />
                ))}
              </g>
            )
          }
          return null
        })}

        {/* Draft-in-progress (deduct/cutout = red, msg19 "WIN") */}
        {tool === 'polygon' && draftPoints.length >= 3 ? (
          <polygon
            points={draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
            fill={deduct ? 'rgba(199,51,30,0.18)' : 'rgba(201,138,46,0.2)'}
            stroke={deduct ? 'var(--m-red)' : 'var(--m-amber)'}
            strokeWidth={0.4}
            strokeDasharray="0.8 0.8"
          />
        ) : null}
        {(tool === 'polygon' || tool === 'lineal') && draftPoints.length >= 2 ? (
          <polyline
            points={draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={deduct && tool === 'polygon' ? 'var(--m-red)' : 'var(--m-amber)'}
            strokeWidth={0.5}
            strokeDasharray="0.8 0.8"
          />
        ) : null}
        {draftPoints.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={tool === 'count' ? 1 : 0.8}
            fill={deduct && tool === 'polygon' ? 'var(--m-red)' : 'var(--m-amber)'}
          />
        ))}
        {/* EDIT GEOM (msg22): live dashed shape + draggable vertex handles for
            the measurement under edit. Touch-sized handles; drag a handle to
            move that vertex, then APPLY in the action bar to persist + re-price. */}
        {editId && editPoints.length > 0
          ? (() => {
              const target = measurements.find((m) => m.id === editId)
              const isLineal = (target?.geometry as MeasurementGeometry | undefined)?.kind === 'lineal'
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
                      fill="rgba(255,212,0,0.24)"
                      stroke="var(--m-ink)"
                      strokeWidth={0.6}
                      strokeDasharray="1.2 0.8"
                      pointerEvents="none"
                    />
                  ) : null}
                  {editPoints.map((p, i) => (
                    <rect
                      key={`eh${i}`}
                      x={p.x - 2}
                      y={p.y - 2}
                      width={4}
                      height={4}
                      fill="var(--m-accent)"
                      stroke="var(--m-ink)"
                      strokeWidth={0.5}
                      style={{ cursor: 'grab' }}
                      onPointerDown={(ev) => {
                        ev.stopPropagation()
                        editDragIdxRef.current = i
                        svgRef.current?.setPointerCapture?.(ev.pointerId)
                      }}
                    />
                  ))}
                </g>
              )
            })()
          : null}
        {/* Loupe / magnifier crosshair over the most-recent draft vertex (msg19). */}
        {draftPoints.length > 0
          ? (() => {
              const last = draftPoints[draftPoints.length - 1]!
              return (
                <g aria-hidden="true">
                  <circle cx={last.x} cy={last.y} r={6} fill="none" stroke="var(--m-ink)" strokeWidth={0.5} />
                  <line
                    x1={last.x - 6}
                    y1={last.y}
                    x2={last.x + 6}
                    y2={last.y}
                    stroke="var(--m-accent)"
                    strokeWidth={0.25}
                  />
                  <line
                    x1={last.x}
                    y1={last.y - 6}
                    x2={last.x}
                    y2={last.y + 6}
                    stroke="var(--m-accent)"
                    strokeWidth={0.25}
                  />
                </g>
              )
            })()
          : null}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface ScopeTotal {
  code: string
  quantity: number
  unit: string
  count: number
  mixedUnits: boolean
}

// NOTE: this is kept local (NOT the shared `@/lib/takeoff/canvas-totals`
// `buildScopeTotals`) because the mobile copy DRIFTED from desktop — it sums
// `quantity` WITHOUT the `is_deduction` sign that the desktop/server use. Until
// that behavioral difference is reconciled it stays separate so the
// Blocker-1 canvas-math extraction is a pure, behavior-identical refactor.
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
