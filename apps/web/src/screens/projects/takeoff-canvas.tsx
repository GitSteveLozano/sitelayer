import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { AgentSurface, AiEyebrow, Attribution, Spark, useRejectSheet, type SparkState } from '@/components/ai'
import { useAuthenticatedObjectUrl } from '@/lib/api/blob-url'
import {
  useBlueprintPages,
  useCaptureTakeoffDraft,
  useCreateMeasurement,
  useCreateTakeoffDraft,
  useDuplicateTakeoffDraft,
  usePromoteCapturedQuantities,
  useProjectBlueprints,
  useProjectMeasurements,
  useServiceItems,
  useTakeoffDrafts,
  useTakeoffDraftResult,
  useUpdateTakeoffDraft,
  type BlueprintDocument,
  type BlueprintPage,
  type CapturedQuantity,
  type CaptureKind,
  type MeasurementGeometry,
  type ServiceItem,
  type TakeoffDraft,
  type TakeoffMeasurement,
} from '@/lib/api'
import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { CalibrationBanner, PageCalibrationOverlay } from './page-calibration-overlay'
import { PageStrip } from './page-strip'
import { RevisionCompareStub } from './revision-compare-stub'
import { TakeoffTagSheet } from './takeoff-tag-sheet'

/**
 * `prj-takeoff-canvas` — mobile-first polygon / lineal / count canvas
 * port of v1's TakeoffWorkspace. Phase 3 deferred this; we're closing
 * the gap here.
 *
 * Coordinates are board-space (0–100 in both axes), matching the
 * `normalizePolygonGeometry` shared helper in @sitelayer/domain. The
 * canvas size is responsive; the SVG viewBox is always `0 0 100 100`.
 *
 * Tools:
 *   - polygon: tap to drop vertices, "Save" closes the polygon and
 *     POSTs a measurement with `geometry.kind = 'polygon'`. Quantity
 *     defaults to the shoelace area (sqft units).
 *   - lineal: tap to drop vertices along a line. Quantity = total
 *     length between consecutive vertices. Save → `kind = 'lineal'`.
 *   - count: each tap drops a single point and the running total ticks.
 *     Save commits one count measurement with kind = 'count'.
 *
 * Pan/zoom is intentionally light — viewBox-based zoom (button +/-)
 * and panning via two-finger touch / middle-click drag. The full
 * gesture set (pinch-to-zoom, momentum scroll) lands as a follow-on
 * once the basic canvas is in workers' hands.
 */
export function TakeoffCanvasScreen() {
  const { id: projectId } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const blueprints = useProjectBlueprints(projectId)
  const serviceItems = useServiceItems()
  const create = useCreateMeasurement(projectId ?? '')

  const blueprintParam = searchParams.get('blueprint')
  const activeBlueprint: BlueprintDocument | null =
    (blueprints.data?.blueprints ?? []).find((b) => b.id === blueprintParam) ?? blueprints.data?.blueprints[0] ?? null
  const blueprintPages = useBlueprintPages(activeBlueprint?.id)

  const setBlueprint = (id: string) => {
    const sp = new URLSearchParams(searchParams)
    sp.set('blueprint', id)
    setSearchParams(sp, { replace: true })
  }

  // Phase A.3: multi-draft takeoff picker. The active draft id flows
  // through the URL (`?draft=<uuid>`), survives reload, and is sticky
  // per (project, blueprint) in localStorage so opening the canvas after
  // switching blueprints returns to whatever draft the operator last
  // worked on in that pair.
  const drafts = useTakeoffDrafts(projectId)
  const createDraft = useCreateTakeoffDraft(projectId ?? '')
  const updateDraft = useUpdateTakeoffDraft(projectId ?? '')
  const duplicateDraft = useDuplicateTakeoffDraft(projectId ?? '')
  const captureDraft = useCaptureTakeoffDraft(projectId ?? '')

  const draftParam = searchParams.get('draft')
  const draftList = drafts.data?.drafts ?? []
  const stickyKey = projectId && activeBlueprint ? `takeoff-draft:${projectId}:${activeBlueprint.id}` : null
  const stickyDraftId = stickyKey
    ? typeof window !== 'undefined'
      ? window.localStorage.getItem(stickyKey)
      : null
    : null
  const candidateDraftId = draftParam ?? stickyDraftId ?? null
  const activeDraft: TakeoffDraft | null = draftList.find((d) => d.id === candidateDraftId) ?? draftList[0] ?? null
  const activeDraftId = activeDraft?.id ?? null

  const setActiveDraft = (id: string) => {
    const sp = new URLSearchParams(searchParams)
    sp.set('draft', id)
    setSearchParams(sp, { replace: true })
    if (stickyKey && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(stickyKey, id)
      } catch {
        // Storage quota / disabled — non-fatal; URL is the source of truth.
      }
    }
  }

  const onPickDraftValue = (value: string) => {
    if (value === '__new__') {
      const name = typeof window !== 'undefined' ? window.prompt('New draft name')?.trim() : ''
      if (!name) return
      createDraft.mutate(
        { name },
        {
          onSuccess: (res) => setActiveDraft(res.draft.id),
        },
      )
      return
    }
    setActiveDraft(value)
  }

  const onDuplicateCurrent = () => {
    if (!activeDraftId) return
    duplicateDraft.mutate(
      { id: activeDraftId },
      {
        onSuccess: (res) => setActiveDraft(res.draft.id),
      },
    )
  }

  const measurements = useProjectMeasurements(projectId, { draftId: activeDraftId })

  // Phase C.3: capture pipeline runner. Reads the selected file as JSON
  // for the three offline pipelines (roomplan / photogrammetry / drone),
  // or sends a dry-run request for blueprint_vision. On success, switches
  // the active draft to the freshly-captured one so the canvas
  // immediately reflects the new scope.
  const runCapture = (kind: CaptureKind, file: File | null) => {
    setError(null)
    const dispatch = (payload: Record<string, unknown>, name?: string) => {
      captureDraft.mutate(
        {
          kind,
          ...(name ? { name } : {}),
          payload,
        },
        {
          onSuccess: (res) => {
            setActiveDraft(res.draft.id)
            if (res.result_summary.review_required) {
              setError(`Capture done — ${res.result_summary.quantities_count} quantities, but some need review.`)
            }
          },
          onError: (err) => setError(err instanceof Error ? err.message : 'Capture failed'),
        },
      )
    }
    if (kind === 'blueprint_vision') {
      // Live blueprint_vision needs server-side pdfPath + ANTHROPIC_API_KEY;
      // until that path lands, kick the pipeline in dry-run mode so the
      // operator can preview the layout of the resulting draft.
      const knownDimRaw = typeof window !== 'undefined' ? window.prompt('Known dimension (ft)?', '30') : '30'
      const knownDimensionFt = knownDimRaw ? Number(knownDimRaw) : 30
      dispatch({ dryRun: true, knownDimensionFt }, 'Blueprint capture (dry-run)')
      return
    }
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result ?? '{}')) as unknown
        if (kind === 'roomplan') {
          dispatch({ capturedRoomJson: parsed, capturedRoomJsonUri: `upload://${file.name}` }, file.name)
        } else if (kind === 'photogrammetry') {
          dispatch({ labeledMesh: parsed }, file.name)
        } else if (kind === 'drone') {
          dispatch({ sidecar: parsed, sidecarPath: `upload://${file.name}` }, file.name)
        }
      } catch (e) {
        setError(e instanceof Error ? `Invalid JSON: ${e.message}` : 'Invalid JSON')
      }
    }
    reader.onerror = () => setError('Failed to read file')
    reader.readAsText(file)
  }

  const onArchiveCurrent = () => {
    if (!activeDraft) return
    // Block archiving the last active draft — the canvas can't render
    // measurements without one and the spec wants archive (not delete)
    // for keeping old proposals around.
    if (draftList.length <= 1) {
      setError('Cannot archive the last active draft. Create another draft first.')
      return
    }
    updateDraft.mutate(
      { id: activeDraft.id, status: 'archived', expected_version: activeDraft.version },
      {
        onSuccess: () => {
          // Switch to the first remaining active draft.
          const next = draftList.find((d) => d.id !== activeDraft.id && d.status === 'active')
          if (next) setActiveDraft(next.id)
        },
      },
    )
  }

  const [tool, setTool] = useState<'polygon' | 'lineal' | 'count'>('polygon')
  const [draftPoints, setDraftPoints] = useState<Array<{ x: number; y: number }>>([])
  const [serviceItemCode, setServiceItemCode] = useState<string>('')
  // Elevation tag (Sitemap §5 panel 1, "Items by location"). Stored as a
  // prefix on notes (`elev:east`, `elev:south`, …) so we don't require a
  // schema change today; the takeoff-summary screen parses it back out
  // for the per-elevation breakdown. `none` skips the tag entirely.
  const [elevation, setElevation] = useState<ElevationTag>('none')
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [calibrationOpen, setCalibrationOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  // Tag sheet target — `null` keeps it closed; a measurement id opens
  // the multi-condition editor (Sitemap §5 panel 2 — "Multi-condition
  // tags").
  const [tagSheetMeasurementId, setTagSheetMeasurementId] = useState<string | null>(null)

  // Pick a default service item once the catalog loads.
  useEffect(() => {
    if (!serviceItemCode && serviceItems.data?.serviceItems[0]) {
      setServiceItemCode(serviceItems.data.serviceItems[0].code)
    }
  }, [serviceItemCode, serviceItems.data])

  // Default the active page to page 1 of the active blueprint whenever
  // the blueprint changes. The page strip below lets the user switch.
  const pages = blueprintPages.data?.pages ?? []
  const activePage: BlueprintPage | null = useMemo(() => {
    if (pages.length === 0) return null
    return pages.find((p) => p.id === activePageId) ?? pages[0] ?? null
  }, [pages, activePageId])

  useEffect(() => {
    // Reset selection when switching blueprint so we don't stick on a
    // page id from the previous doc.
    if (activePage && activePage.id !== activePageId) {
      setActivePageId(activePage.id)
    }
  }, [activePage, activePageId])

  const blueprintReference = useMemo(
    () => buildBlueprintReference(activeBlueprint, activePage),
    [activeBlueprint, activePage],
  )
  const canvasSourceImage = useAuthenticatedObjectUrl(blueprintReference?.texturePath)

  if (!projectId) {
    return (
      <div className="px-5 pt-8">
        <Link to="/projects" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  const blueprintList = blueprints.data?.blueprints ?? []
  const items = serviceItems.data?.serviceItems ?? []
  const selectedItem = items.find((i) => i.code === serviceItemCode) ?? null
  const blueprintMeasurements = (measurements.data?.measurements ?? []).filter(
    (m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id && measurementBelongsToPage(m, activePage),
  )
  const previewParams = new URLSearchParams()
  if (activeBlueprint) previewParams.set('blueprint', activeBlueprint.id)
  if (activeDraftId) previewParams.set('draft', activeDraftId)
  if (activePage) previewParams.set('page', activePage.id)
  const previewSearch = previewParams.toString()

  const onCanvasTap = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    if (tool === 'polygon' && draftPoints.length >= 64) return
    // Use the SVG screen-CTM so the tap respects the current viewBox
    // (i.e. zoom). A naive client-rect map would always project to the
    // full 0–100 board space and drop points in the wrong place at any
    // zoom != 1.
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const local = pt.matrixTransform(ctm.inverse())
    const x = clamp(local.x, 0, 100)
    const y = clamp(local.y, 0, 100)
    setDraftPoints((prev) => [...prev, { x, y }])
  }

  const undo = () => setDraftPoints((prev) => prev.slice(0, -1))
  const clearDraft = () => setDraftPoints([])

  const draftQuantity = useMemo(() => {
    if (tool === 'polygon') return polygonArea(draftPoints)
    if (tool === 'lineal') return lineLength(draftPoints)
    return draftPoints.length
  }, [tool, draftPoints])

  const minPoints = tool === 'polygon' ? 3 : tool === 'lineal' ? 2 : 1
  const canSave =
    !create.isPending &&
    Boolean(activeBlueprint) &&
    Boolean(serviceItemCode) &&
    draftPoints.length >= minPoints &&
    draftQuantity > 0

  const onSave = async () => {
    if (!canSave) return
    setError(null)
    try {
      let geometry: MeasurementGeometry
      if (tool === 'polygon') {
        geometry = { kind: 'polygon', points: draftPoints }
      } else if (tool === 'lineal') {
        geometry = { kind: 'lineal', points: draftPoints }
      } else {
        geometry = { kind: 'count', points: draftPoints }
      }
      await create.mutateAsync({
        blueprint_document_id: activeBlueprint?.id ?? null,
        service_item_code: serviceItemCode,
        unit: selectedItem?.unit ?? (tool === 'polygon' ? 'sqft' : tool === 'lineal' ? 'lf' : 'ea'),
        geometry,
        elevation: elevation === 'none' ? null : elevation,
        page_id: activePage?.id ?? null,
        // Land the measurement on the currently-selected draft. Falls
        // back to the project's default server-side when null.
        draft_id: activeDraftId,
      })
      setDraftPoints([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <Link to={`/projects/${projectId}?tab=takeoff`} className="text-[12px] text-ink-3">
          ← Measurements
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight truncate">
            {activeBlueprint?.file_name ?? 'No blueprint'}
          </h1>
          <div className="flex items-center gap-3 shrink-0">
            <button type="button" onClick={() => setCompareOpen(true)} className="text-[12px] font-medium text-accent">
              Compare
            </button>
            <Link
              to={`/projects/${projectId}/takeoff-preview${previewSearch ? `?${previewSearch}` : ''}`}
              className="text-[12px] font-medium text-accent"
            >
              3D →
            </Link>
            <Link to={`/projects/${projectId}/photo-measure`} className="text-[12px] font-medium text-accent">
              Photo →
            </Link>
            <Link to={`/projects/${projectId}/takeoff-summary`} className="text-[12px] font-medium text-accent">
              Summary →
            </Link>
          </div>
        </div>
      </div>

      {blueprintList.length === 0 ? (
        <div className="px-4 pb-8">
          <Card>
            <div className="text-[13px] font-semibold">No blueprints uploaded</div>
            <div className="text-[12px] text-ink-3 mt-1">Upload a PDF or image to start drawing measurements.</div>
            <div className="mt-3">
              <MobileButton variant="primary" onClick={() => navigate(`/projects/${projectId}/setup`)}>
                Upload blueprint
              </MobileButton>
            </div>
          </Card>
        </div>
      ) : (
        <>
          {blueprintList.length > 1 ? (
            <div className="px-4 pb-2 flex gap-1.5 overflow-x-auto scrollbar-hide">
              {blueprintList.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBlueprint(b.id)}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-medium border shrink-0 ${
                    activeBlueprint?.id === b.id
                      ? 'bg-accent text-white border-transparent'
                      : 'bg-card-soft text-ink-2 border-line'
                  }`}
                >
                  {b.file_name}
                </button>
              ))}
            </div>
          ) : null}

          {/* Phase A.3: draft picker. Selection is sticky per
              (project, blueprint) so opening the canvas after switching
              blueprints lands back on whichever draft the operator was
              working on for that pair. */}
          {draftList.length > 0 ? (
            <div className="px-4 pb-2 flex items-center gap-2 text-[12px]">
              <span className="text-ink-3 font-semibold uppercase tracking-[0.06em] text-[10px]">Draft</span>
              <select
                value={activeDraftId ?? ''}
                onChange={(e) => onPickDraftValue(e.target.value)}
                className="flex-1 min-w-0 py-1.5 px-2 rounded border border-line bg-card-soft text-[13px] font-medium"
              >
                {draftList.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
                <option value="__new__">+ New draft…</option>
              </select>
              <button
                type="button"
                onClick={onDuplicateCurrent}
                disabled={!activeDraftId || duplicateDraft.isPending}
                className="px-2 py-1.5 rounded border border-line text-[11px] font-medium text-ink-2 disabled:opacity-50"
                title="Duplicate this draft"
              >
                Duplicate
              </button>
              <button
                type="button"
                onClick={onArchiveCurrent}
                disabled={!activeDraftId || updateDraft.isPending || draftList.length <= 1}
                className="px-2 py-1.5 rounded border border-line text-[11px] font-medium text-ink-2 disabled:opacity-50"
                title="Archive this draft"
              >
                Archive
              </button>
            </div>
          ) : null}

          {/* Phase C.3: Capture from… — runs one of the four
              @sitelayer/pipe-* pipelines server-side and lands the result
              as a new draft. The file inputs accept JSON for the three
              offline pipelines; blueprint_vision triggers a dry-run that
              doesn't require a server-side PDF (full live mode lands in
              a follow-on PR). */}
          {activeDraft ? (
            <div className="px-4 pb-2 flex items-center gap-2 text-[11px]">
              <span className="text-ink-3 font-semibold uppercase tracking-[0.06em] text-[10px]">Capture</span>
              <label className="px-2 py-1.5 rounded border border-line bg-card-soft text-ink-2 cursor-pointer hover:bg-card">
                RoomPlan JSON…
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null
                    e.target.value = ''
                    if (f) runCapture('roomplan', f)
                  }}
                />
              </label>
              <label className="px-2 py-1.5 rounded border border-line bg-card-soft text-ink-2 cursor-pointer hover:bg-card">
                Photogrammetry…
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null
                    e.target.value = ''
                    if (f) runCapture('photogrammetry', f)
                  }}
                />
              </label>
              <label className="px-2 py-1.5 rounded border border-line bg-card-soft text-ink-2 cursor-pointer hover:bg-card">
                Drone sidecar…
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null
                    e.target.value = ''
                    if (f) runCapture('drone', f)
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => runCapture('blueprint_vision', null)}
                disabled={captureDraft.isPending}
                className="px-2 py-1.5 rounded border border-line bg-card-soft text-ink-2 disabled:opacity-50"
                title="Run blueprint_vision in dry-run mode"
              >
                Blueprint (dry-run)
              </button>
              {captureDraft.isPending ? <span className="text-ink-3 italic">capturing…</span> : null}
            </div>
          ) : null}

          {/* Capture-source + review badges on the current draft. */}
          {activeDraft && activeDraft.source && activeDraft.source !== 'manual' ? (
            <div className="px-4 pb-2 flex items-center gap-2 text-[11px]">
              <Pill tone="info">{activeDraft.source.replace('_', ' ')}</Pill>
              {activeDraft.pipeline_version ? (
                <span className="text-ink-3">v{activeDraft.pipeline_version}</span>
              ) : null}
              {activeDraft.review_required ? <Pill tone="warn">review needed</Pill> : null}
            </div>
          ) : null}

          <CalibrationBanner page={activePage} onClickCalibrate={() => setCalibrationOpen(true)} />

          <div className="px-4 flex gap-3 items-start">
            <div className="flex-1 min-w-0">
              <CanvasSurface
                svgRef={svgRef}
                tool={tool}
                zoom={zoom}
                onTap={onCanvasTap}
                draftPoints={draftPoints}
                measurements={blueprintMeasurements}
                sourceImageUrl={canvasSourceImage.url}
                onMeasurementContext={(measurement) => setTagSheetMeasurementId(measurement.id)}
              />
              {blueprintReference ? (
                <div className="mt-1 text-[11px] text-ink-3" data-testid="takeoff-canvas-source-sheet-status">
                  Source sheet:{' '}
                  {blueprintReference.kind === 'image'
                    ? canvasSourceImage.loading
                      ? 'loading image underlay'
                      : canvasSourceImage.error
                        ? 'image underlay failed'
                        : canvasSourceImage.url
                          ? 'image underlay loaded'
                          : 'image underlay pending'
                    : blueprintReference.kind === 'pdf'
                      ? 'PDF rasterization needed before it can be underlaid'
                      : 'unsupported file type for image underlay'}
                </div>
              ) : null}
            </div>
            <RunningTotalsRail measurements={blueprintMeasurements} serviceItems={items} />
          </div>

          <PageStrip
            blueprintId={activeBlueprint?.id}
            activePageId={activePage?.id ?? null}
            onSelectPage={(p) => setActivePageId(p.id)}
          />

          <div className="px-4 pt-3 flex items-center justify-between text-[11px] text-ink-3">
            <span>
              {tool === 'polygon'
                ? `${draftPoints.length} pts · area ${draftQuantity.toFixed(2)}`
                : tool === 'lineal'
                  ? `${draftPoints.length} pts · length ${draftQuantity.toFixed(2)}`
                  : `${draftPoints.length} ${draftPoints.length === 1 ? 'count' : 'counts'}`}
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                aria-label="Zoom out"
                className="px-2 py-1 rounded border border-line"
              >
                −
              </button>
              <span className="num text-[11px]">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
                aria-label="Zoom in"
                className="px-2 py-1 rounded border border-line"
              >
                +
              </button>
            </span>
          </div>

          <div className="px-4 pt-3">
            <div className="grid grid-cols-3 gap-1.5">
              {(['polygon', 'lineal', 'count'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setTool(t)
                    setDraftPoints([])
                  }}
                  className={`py-2 rounded-md text-[12px] font-semibold ${
                    tool === t ? 'bg-accent text-white' : 'bg-card-soft text-ink-2'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 pt-3 space-y-2">
            <Card tight>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Service item
              </label>
              <select
                value={serviceItemCode}
                onChange={(e) => setServiceItemCode(e.target.value)}
                className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
              >
                {items.length === 0 ? <option value="">Loading…</option> : null}
                {items.map((it: ServiceItem) => (
                  <option key={it.code} value={it.code}>
                    {it.code} — {it.name}
                  </option>
                ))}
              </select>
            </Card>

            <Card tight>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">Elevation</div>
              <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
                {ELEVATION_TAGS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setElevation(t)}
                    className={
                      elevation === t
                        ? 'shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium bg-accent text-white'
                        : 'shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium bg-card-soft text-ink-2 border border-line'
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Card>

            <div className="grid grid-cols-3 gap-2">
              <MobileButton variant="ghost" onClick={undo} disabled={draftPoints.length === 0}>
                Undo
              </MobileButton>
              <MobileButton variant="ghost" onClick={clearDraft} disabled={draftPoints.length === 0}>
                Clear
              </MobileButton>
              <MobileButton variant="primary" onClick={onSave} disabled={!canSave}>
                {create.isPending ? 'Saving…' : 'Save'}
              </MobileButton>
            </div>

            {error ? <div className="text-[12px] text-warn">{error}</div> : null}

            <div className="flex items-center justify-between text-[11px] text-ink-3 pt-1">
              <span>{blueprintMeasurements.length} saved on this blueprint</span>
              <Pill tone="default">{tool}</Pill>
            </div>

            {/* Phase C.3 — AI-captured quantity review, dressed in the
                calm-AI design language (`AI Layer.html` + `ai-keystone.jsx`).
                Each quantity gets its own dashed-border AgentSurface so the
                operator can Confirm / Edit / Reject one at a time without
                the bulk-checklist baggage. Only renders for drafts whose
                source is a capture pipeline; manual drafts have no
                `takeoff_result_json` and the GET would 404. */}
            {activeDraft && activeDraft.source && activeDraft.source !== 'manual' ? (
              <AgentSuggestionsPanel projectId={projectId} draft={activeDraft} />
            ) : null}

            {blueprintMeasurements.length > 0 ? (
              <Card tight>
                <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1.5">
                  Saved measurements · long-press to tag
                </div>
                <ul className="divide-y divide-line">
                  {blueprintMeasurements.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => setTagSheetMeasurementId(m.id)}
                        className="w-full flex items-center justify-between gap-2 py-1.5 text-left"
                      >
                        <span className="text-[12px] font-semibold truncate">{m.service_item_code}</span>
                        <span className="font-mono tabular-nums text-[12px] text-ink-3">
                          {Number(m.quantity).toFixed(2)} {m.unit}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <Attribution source="POST /api/projects/:id/takeoff/measurement · geometry shared with @sitelayer/domain" />
          </div>
        </>
      )}

      <PageCalibrationOverlay open={calibrationOpen} onClose={() => setCalibrationOpen(false)} page={activePage} />
      <RevisionCompareStub
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        projectId={projectId}
        initialAfterId={activeBlueprint?.id ?? null}
      />
      <TakeoffTagSheet
        open={tagSheetMeasurementId !== null}
        onClose={() => setTagSheetMeasurementId(null)}
        measurementId={tagSheetMeasurementId}
        defaultQuantity={
          tagSheetMeasurementId
            ? Number(blueprintMeasurements.find((m) => m.id === tagSheetMeasurementId)?.quantity ?? 0)
            : undefined
        }
        defaultUnit={
          tagSheetMeasurementId
            ? (blueprintMeasurements.find((m) => m.id === tagSheetMeasurementId)?.unit ?? undefined)
            : undefined
        }
      />
    </div>
  )
}

function measurementBelongsToPage(measurement: TakeoffMeasurement, page: BlueprintPage | null): boolean {
  if (!page) return true
  if (measurement.page_id) return measurement.page_id === page.id
  return page.page_number === 1
}

interface CanvasSurfaceProps {
  svgRef: React.RefObject<SVGSVGElement | null>
  tool: 'polygon' | 'lineal' | 'count'
  zoom: number
  onTap: (e: ReactPointerEvent<SVGSVGElement>) => void
  draftPoints: Array<{ x: number; y: number }>
  measurements: TakeoffMeasurement[]
  sourceImageUrl?: string | null
  /**
   * Right-click / context-menu / long-press on a saved measurement —
   * the canvas raises this so the parent can open the multi-condition
   * tag sheet for that measurement.
   */
  onMeasurementContext?: (measurement: TakeoffMeasurement) => void
}

function CanvasSurface({
  svgRef,
  tool,
  zoom,
  onTap,
  draftPoints,
  measurements,
  sourceImageUrl,
  onMeasurementContext,
}: CanvasSurfaceProps) {
  const viewBoxSize = 100 / zoom
  const viewBoxOrigin = (100 - viewBoxSize) / 2
  return (
    <div className="relative w-full aspect-square bg-card-soft rounded-md overflow-hidden border border-line">
      {sourceImageUrl ? (
        <img
          src={sourceImageUrl}
          alt=""
          data-testid="takeoff-canvas-source-image"
          className="absolute inset-0 h-full w-full object-fill opacity-70"
          draggable={false}
        />
      ) : null}
      <svg
        ref={svgRef}
        viewBox={`${viewBoxOrigin} ${viewBoxOrigin} ${viewBoxSize} ${viewBoxSize}`}
        onPointerDown={onTap}
        className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
      >
        {/* Grid */}
        <g aria-hidden="true">
          {Array.from({ length: 11 }, (_, i) => (
            <line
              key={`h${i}`}
              x1={0}
              x2={100}
              y1={i * 10}
              y2={i * 10}
              stroke="currentColor"
              strokeWidth={0.05}
              className="text-line"
            />
          ))}
          {Array.from({ length: 11 }, (_, i) => (
            <line
              key={`v${i}`}
              x1={i * 10}
              x2={i * 10}
              y1={0}
              y2={100}
              stroke="currentColor"
              strokeWidth={0.05}
              className="text-line"
            />
          ))}
        </g>

        {/* Saved measurements */}
        {measurements.map((m) => {
          const geo = m.geometry as MeasurementGeometry
          // Right-click → open the multi-condition tag sheet for that
          // measurement. We `preventDefault` so the browser's native
          // context menu doesn't compete with our sheet.
          const onContext = (e: React.MouseEvent<SVGElement>) => {
            if (!onMeasurementContext) return
            e.preventDefault()
            e.stopPropagation()
            onMeasurementContext(m)
          }
          if (geo.kind === 'polygon' && geo.points && geo.points.length >= 3) {
            return (
              <polygon
                key={m.id}
                points={geo.points.map((p) => `${p.x},${p.y}`).join(' ')}
                className="fill-accent/15 stroke-accent"
                strokeWidth={0.3}
                onContextMenu={onContext}
              />
            )
          }
          if (geo.kind === 'lineal' && geo.points && geo.points.length >= 2) {
            return (
              <polyline
                key={m.id}
                points={geo.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                className="stroke-accent"
                strokeWidth={0.4}
                onContextMenu={onContext}
              />
            )
          }
          if (geo.kind === 'count' && geo.points) {
            return (
              <g key={m.id} onContextMenu={onContext}>
                {geo.points.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={0.6} className="fill-accent" />
                ))}
              </g>
            )
          }
          return null
        })}

        {/* Draft */}
        {tool === 'polygon' && draftPoints.length >= 3 ? (
          <polygon
            points={draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
            className="fill-warn/20 stroke-warn"
            strokeWidth={0.3}
            strokeDasharray="0.6 0.6"
          />
        ) : null}
        {(tool === 'polygon' || tool === 'lineal') && draftPoints.length >= 2 ? (
          <polyline
            points={draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            className="stroke-warn"
            strokeWidth={0.4}
            strokeDasharray="0.6 0.6"
          />
        ) : null}
        {draftPoints.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={tool === 'count' ? 0.7 : 0.5} className="fill-warn" />
        ))}
      </svg>
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function polygonArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  // Shoelace formula in board-space (0–100 coords). The result is
  // scaled board area; downstream `calculateTakeoffQuantity` already
  // does the scale-to-real-world conversion using the page's
  // calibration, but for the inline draft display we just show
  // board area as a working number.
  if (points.length < 3) return 0
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

function lineLength(points: ReadonlyArray<{ x: number; y: number }>): number {
  if (points.length < 2) return 0
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    total += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
  }
  return total
}

/**
 * `RunningTotalsRail` — sticky right rail (Sitemap §estimator takeoff
 * canvas, "Right rail shows running quantities by category"). Hidden
 * below the `md` breakpoint; the canvas reclaims that horizontal space
 * on phones and the saved-measurements list at the bottom of the screen
 * already covers the same data for narrow layouts.
 *
 * Categories are derived by joining each measurement's `service_item_code`
 * to the `service_items` catalog and grouping by the catalog row's
 * `category` (currently `measurable | accounting`, see
 * `packages/domain/src/index.ts`). Quantities are summed per category and
 * the share-of-total drives the progress bar — measurable categories take
 * the accent tone; non-measurable rows fall back to the default tone so
 * accounting-only items still display without competing visually.
 */
interface RunningTotalsRailProps {
  measurements: TakeoffMeasurement[]
  serviceItems: ServiceItem[]
}

interface CategoryTotal {
  category: string
  quantity: number
  unit: string
  /** Whether multiple measurement units are mixed under this category. */
  mixedUnits: boolean
  isMeasurable: boolean
}

function RunningTotalsRail({ measurements, serviceItems }: RunningTotalsRailProps) {
  const totals = useMemo<CategoryTotal[]>(() => {
    if (measurements.length === 0) return []
    const itemByCode = new Map<string, ServiceItem>()
    for (const it of serviceItems) itemByCode.set(it.code, it)

    type Bucket = { quantity: number; units: Set<string>; isMeasurable: boolean }
    const buckets = new Map<string, Bucket>()
    for (const m of measurements) {
      const item = itemByCode.get(m.service_item_code)
      const category = item?.category ?? 'uncategorized'
      const bucket = buckets.get(category) ?? {
        quantity: 0,
        units: new Set<string>(),
        isMeasurable: item?.category === 'measurable',
      }
      bucket.quantity += Number(m.quantity) || 0
      bucket.units.add(m.unit)
      buckets.set(category, bucket)
    }
    return Array.from(buckets.entries())
      .map(([category, b]) => {
        const unit = b.units.size === 1 ? Array.from(b.units)[0]! : 'mixed'
        return {
          category,
          quantity: b.quantity,
          unit,
          mixedUnits: b.units.size > 1,
          isMeasurable: b.isMeasurable,
        }
      })
      .sort((a, b) => b.quantity - a.quantity)
  }, [measurements, serviceItems])

  const grandTotal = totals.reduce((sum, t) => sum + t.quantity, 0)

  return (
    <aside className="hidden md:flex w-60 shrink-0 sticky top-2 max-h-[calc(100vh-1rem)] flex-col">
      <Card tight>
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          Running totals · by category
        </div>
        {totals.length === 0 ? (
          <div className="mt-2 text-[11px] text-ink-3 leading-snug">No measurements yet. Draw a polygon to start.</div>
        ) : (
          <ul className="mt-2 space-y-2.5">
            {totals.map((t) => {
              const share = grandTotal > 0 ? t.quantity / grandTotal : 0
              const widthPct = Math.max(2, Math.round(share * 100))
              return (
                <li key={t.category}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-semibold capitalize truncate">{t.category}</span>
                    <span className="font-mono tabular-nums text-[11px] text-ink-3 shrink-0">
                      {formatQuantity(t.quantity)} {t.unit}
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full rounded-full bg-line/60 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${t.isMeasurable ? 'bg-accent' : 'bg-ink-3'}`}
                      style={{ width: `${widthPct}%` }}
                      aria-hidden="true"
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </aside>
  )
}

function formatQuantity(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (Number.isInteger(n)) return String(n)
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

/**
 * `AgentSuggestionsPanel` — operator review surface for the AI-captured
 * `TakeoffResult.quantities[]` stashed on a draft (Phase C.3, redesigned to
 * use the calm-AI design language documented in `AI Layer.html` and
 * `ai-keystone.jsx`).
 *
 * Each captured quantity gets its own dashed-border `AgentSurface` card
 * with three equal-weight actions:
 *   - Confirm  → POST to /promote with `quantity_ids: [thisOne]`. Picks up
 *                the inline `service_item_code` edit when the operator
 *                retyped the captured code.
 *   - Edit     → toggles an inline service_item_code input. Persisted as
 *                the next Confirm's override.
 *   - Reject   → opens `RejectSheet` with four structured reasons
 *                (`wrong_code`, `wrong_quantity`, `not_in_scope`, `other`).
 *                Rejected quantities hide for the session (we don't have
 *                a backend yet for rejection signals — keeping that as a
 *                follow-on PR per the spec).
 *
 * Confidence is ordinal, never a numeric percent (the hard rule from
 * `AI Layer.html`). High ≥0.85 → `Spark state="strong"` and pre-staged for
 * the bulk "Confirm all high-confidence" CTA. Medium 0.6–0.85 → `accent`,
 * offered one-by-one. Low <0.6 → hidden behind a "Show low-confidence (N)"
 * disclosure so the canvas isn't drowned in noise on a bad capture.
 *
 * The captured result on the draft is left intact so a later operator can
 * still re-promote the same quantities under different codes if needed —
 * the promote endpoint is additive and idempotent in that sense.
 */
interface AgentSuggestionsPanelProps {
  projectId: string
  draft: TakeoffDraft
}

/** Ordinal confidence buckets — keep these in sync with the `Spark` states
 * mapped in `confidenceState` below. Hard rule from `AI Layer.html`:
 * confidence is **ordinal**, never a percentage. */
type ConfidenceBucket = 'high' | 'medium' | 'low'

function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= 0.85) return 'high'
  if (confidence >= 0.6) return 'medium'
  return 'low'
}

function confidenceState(bucket: ConfidenceBucket): SparkState {
  switch (bucket) {
    case 'high':
      return 'strong'
    case 'medium':
      return 'accent'
    case 'low':
      return 'muted'
  }
}

function confidenceLabel(bucket: ConfidenceBucket): string {
  switch (bucket) {
    case 'high':
      return 'High confidence'
    case 'medium':
      return 'Medium confidence'
    case 'low':
      return 'Low confidence'
  }
}

/** Four canonical rejection reasons, matching the spec. `RejectSheet`
 * renders these as equal-weight chips per the AI-layer anti-pattern rule
 * against free-text rejections. */
const TAKEOFF_REJECT_REASONS = ['wrong_code', 'wrong_quantity', 'not_in_scope', 'other'] as const

/** Pretty-print a capture source / provenance kind for the eyebrow line.
 * Matches the design intent ("Blueprint vision · captured 2m ago") rather
 * than spitting the raw enum at the operator. */
function formatSource(draftSource: string | undefined, provenanceKind: string | undefined): string {
  // Provenance is the more specific signal; fall back to draft source so
  // we always show something even when the pipeline emitted a minimal
  // provenance record.
  const raw = provenanceKind ?? draftSource ?? 'capture'
  switch (raw) {
    case 'blueprint_vision':
    case 'blueprint':
      return 'Blueprint vision'
    case 'roomplan':
      return 'RoomPlan capture'
    case 'photogrammetry':
      return 'Photogrammetry'
    case 'drone':
      return 'Drone capture'
    case 'manual':
      return 'Manual entry'
    case 'derived':
      return 'Derived'
    default:
      return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
}

/** Loose "2m ago" formatter — no need to pull in date-fns for one line.
 * Falls back to `captured just now` for the no-timestamp case so the
 * eyebrow doesn't read awkwardly. */
function formatRelativeTime(timestamp: string | undefined): string {
  if (!timestamp) return 'just now'
  const t = Date.parse(timestamp)
  if (!Number.isFinite(t)) return 'just now'
  const delta = Date.now() - t
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

/** Build the Attribution emphasis line. Names the source specifically per
 * the AI-layer rule (specificity is the trust signal — never "AI"). */
function attributionEmphasisFor(
  provenanceKind: string | undefined,
  draftSource: string | undefined,
  pipelineVersion: string | null | undefined,
): string {
  const base = (() => {
    switch (provenanceKind ?? draftSource) {
      case 'blueprint_vision':
      case 'blueprint':
        return 'Claude vision PDF extraction'
      case 'roomplan':
        return 'iPad RoomPlan capture'
      case 'photogrammetry':
        return 'photogrammetry mesh labels'
      case 'drone':
        return 'drone orthomosaic sidecar'
      case 'derived':
        return 'derived from prior quantities'
      default:
        return 'capture pipeline'
    }
  })()
  return pipelineVersion ? `${base} (v${pipelineVersion})` : base
}

function AgentSuggestionsPanel({ projectId, draft }: AgentSuggestionsPanelProps) {
  const result = useTakeoffDraftResult(draft.id)
  const promote = usePromoteCapturedQuantities(projectId, draft.id)
  const [rejectNode, askReject] = useRejectSheet()
  // Per-quantity inline edit toggle + override value. Persists across
  // renders so the operator can stage edits before Confirming.
  const [editing, setEditing] = useState<Set<string>>(new Set())
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  // Session-scoped rejection state. We don't have a backend signal for
  // structured takeoff rejections yet (the spec calls it out as optional);
  // hiding rejected quantities until the page reloads is the lightest
  // honest UX — operators can refresh to bring them back.
  const [rejected, setRejected] = useState<Record<string, string>>({})
  // Track which row is currently in-flight so we can disable just that
  // card's buttons rather than the whole panel. The promote mutation is
  // shared so we serialise per-id via this state.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  // Disclosure for low-confidence rows. Defaults to hidden per the design
  // rule "low → hidden by default behind 'Show low-confidence (N)'".
  const [showLow, setShowLow] = useState(false)

  // Pre-fill the override input with the captured code so the operator
  // only has to type when they actually want to remap. Live updates so
  // newly-captured drafts (capture → switch → here) hydrate correctly.
  useEffect(() => {
    if (!result.data) return
    setOverrides((prev) => {
      const next: Record<string, string> = { ...prev }
      for (const q of result.data.takeoff_result.quantities) {
        if (next[q.id] === undefined) {
          next[q.id] = derivedCodeFor(q) ?? ''
        }
      }
      return next
    })
  }, [result.data])

  const quantities = result.data?.takeoff_result.quantities ?? []
  const pipelineVersion = result.data?.pipeline_version ?? draft.pipeline_version ?? null
  // The capture pipelines stamp `producedAt`/`capturedAt` onto the result;
  // fall back to the draft's `created_at` so we always have a usable
  // timestamp for the eyebrow line.
  const capturedAt =
    (result.data?.takeoff_result as { producedAt?: string; capturedAt?: string } | undefined)?.producedAt ??
    (result.data?.takeoff_result as { producedAt?: string; capturedAt?: string } | undefined)?.capturedAt ??
    draft.created_at

  const visible = quantities.filter((q) => !rejected[q.id])
  const highConfidence = visible.filter((q) => confidenceBucket(q.confidence) === 'high')
  const mediumConfidence = visible.filter((q) => confidenceBucket(q.confidence) === 'medium')
  const lowConfidence = visible.filter((q) => confidenceBucket(q.confidence) === 'low')

  const onConfirm = (q: CapturedQuantity) => {
    setError(null)
    setSummary(null)
    setBusyId(q.id)
    const candidate = (overrides[q.id] ?? '').trim()
    const derived = derivedCodeFor(q) ?? ''
    // Only forward the override when the operator actually retyped — the
    // server falls back to the AI-derived MasterFormat/UniFormat/OmniClass
    // code otherwise (and bypasses the curated-catalog gate for review).
    const overridesToSend: Record<string, string> = {}
    if (candidate.length > 0 && candidate !== derived) {
      overridesToSend[q.id] = candidate
    }
    promote.mutate(
      {
        quantity_ids: [q.id],
        ...(Object.keys(overridesToSend).length > 0 ? { service_item_code_overrides: overridesToSend } : {}),
      },
      {
        onSuccess: (res) => {
          setBusyId(null)
          // Promotion is additive on the server — hide the quantity from
          // the suggestion panel so the operator doesn't see it twice. The
          // promoted row already shows up in the canvas measurement list.
          setRejected((prev) => ({ ...prev, [q.id]: 'confirmed' }))
          setEditing((prev) => {
            const next = new Set(prev)
            next.delete(q.id)
            return next
          })
          const parts = [`Confirmed ${res.promoted_count}.`]
          if (res.skipped_count > 0) parts.push(`Skipped ${res.skipped_count}.`)
          setSummary(parts.join(' '))
        },
        onError: (err) => {
          setBusyId(null)
          setError(err instanceof Error ? err.message : 'Confirm failed')
        },
      },
    )
  }

  const onBulkConfirmHigh = () => {
    setError(null)
    setSummary(null)
    if (highConfidence.length === 0) return
    setBusyId('__bulk__')
    const ids = highConfidence.map((q) => q.id)
    // Bulk path doesn't apply per-row edits — operators that want to
    // remap a code should Confirm that row individually. Stick to the
    // canonical AI-derived codes so the server takes the fast path.
    promote.mutate(
      { quantity_ids: ids },
      {
        onSuccess: (res) => {
          setBusyId(null)
          setRejected((prev) => {
            const next = { ...prev }
            for (const id of ids) next[id] = 'confirmed'
            return next
          })
          const parts = [`Confirmed ${res.promoted_count}.`]
          if (res.skipped_count > 0) parts.push(`Skipped ${res.skipped_count}.`)
          setSummary(parts.join(' '))
        },
        onError: (err) => {
          setBusyId(null)
          setError(err instanceof Error ? err.message : 'Bulk confirm failed')
        },
      },
    )
  }

  const onToggleEdit = (id: string) => {
    setEditing((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onReject = async (q: CapturedQuantity) => {
    const reason = await askReject({
      title: 'Reject this captured quantity?',
      body: 'Pick the closest match — this trains the model.',
      reasons: TAKEOFF_REJECT_REASONS,
    })
    if (reason === null) return
    setRejected((prev) => ({ ...prev, [q.id]: reason }))
    setSummary(`Rejected (${reason.replace(/_/g, ' ')}).`)
  }

  if (result.isLoading) {
    return (
      <Card tight>
        <AiEyebrow>Agent suggestions</AiEyebrow>
        <div className="text-[12px] text-ink-3 italic mt-1.5">Loading captured result…</div>
      </Card>
    )
  }

  if (result.isError || !result.data) {
    return (
      <Card tight>
        <AiEyebrow>Agent suggestions</AiEyebrow>
        <div className="text-[12px] text-ink-3 leading-snug mt-1.5">
          Capture from a blueprint or upload to see AI-suggested quantities.
        </div>
      </Card>
    )
  }

  if (quantities.length === 0) {
    return (
      <Card tight>
        <AiEyebrow>Agent suggestions</AiEyebrow>
        <div className="text-[12px] text-ink-3 leading-snug mt-1.5">
          The capture pipeline returned no quantities. Re-run the capture or escalate to manual takeoff.
        </div>
      </Card>
    )
  }

  if (visible.length === 0) {
    return (
      <Card tight>
        <AiEyebrow>Agent suggestions</AiEyebrow>
        <div className="text-[12px] text-ink-3 leading-snug mt-1.5">
          All {quantities.length} captured quantities have been confirmed or rejected this session.
        </div>
        {summary ? <div className="mt-1.5 text-[11px] text-ink-3">{summary}</div> : null}
      </Card>
    )
  }

  return (
    <div>
      <Card tight>
        <div className="flex items-baseline justify-between">
          <AiEyebrow>Agent suggestions · {visible.length} pending</AiEyebrow>
          {highConfidence.length > 0 ? (
            <button
              type="button"
              onClick={onBulkConfirmHigh}
              disabled={promote.isPending}
              className="text-[11px] font-semibold text-accent disabled:opacity-50"
            >
              {busyId === '__bulk__' ? 'Confirming…' : `Confirm all high-confidence (${highConfidence.length})`}
            </button>
          ) : null}
        </div>
        {summary ? <div className="mt-1.5 text-[11px] text-ink-3">{summary}</div> : null}
        {error ? <div className="mt-1.5 text-[12px] text-warn">{error}</div> : null}
      </Card>

      {/* High + medium confidence stack first; low confidence sits behind
          a disclosure per the design rule. AgentSurface contributes its own
          top margin so we don't need to add spacing between cards. */}
      {[...highConfidence, ...mediumConfidence].map((q) => (
        <AgentSuggestionCard
          key={q.id}
          quantity={q}
          draftSource={draft.source}
          pipelineVersion={pipelineVersion}
          capturedAt={capturedAt}
          override={overrides[q.id] ?? ''}
          isEditing={editing.has(q.id)}
          isBusy={busyId === q.id || promote.isPending}
          onOverrideChange={(value) => setOverrides((prev) => ({ ...prev, [q.id]: value }))}
          onConfirm={() => onConfirm(q)}
          onToggleEdit={() => onToggleEdit(q.id)}
          onReject={() => void onReject(q)}
        />
      ))}

      {lowConfidence.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowLow((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 bg-card-soft border border-line rounded text-[12px] font-medium text-ink-2"
          >
            <span className="flex items-center gap-2">
              <Spark state="muted" size={10} aria-label="" />
              {showLow ? 'Hide low-confidence' : `Show low-confidence (${lowConfidence.length})`}
            </span>
            <span className="text-ink-3">{showLow ? '−' : '+'}</span>
          </button>
          {showLow
            ? lowConfidence.map((q) => (
                <AgentSuggestionCard
                  key={q.id}
                  quantity={q}
                  draftSource={draft.source}
                  pipelineVersion={pipelineVersion}
                  capturedAt={capturedAt}
                  override={overrides[q.id] ?? ''}
                  isEditing={editing.has(q.id)}
                  isBusy={busyId === q.id || promote.isPending}
                  onOverrideChange={(value) => setOverrides((prev) => ({ ...prev, [q.id]: value }))}
                  onConfirm={() => onConfirm(q)}
                  onToggleEdit={() => onToggleEdit(q.id)}
                  onReject={() => void onReject(q)}
                />
              ))
            : null}
        </div>
      ) : null}

      {rejectNode}
    </div>
  )
}

/**
 * Single captured-quantity card rendered inside an `AgentSurface`.
 *
 * Layout follows `ai-keystone.jsx` §05a / `AI Layer.html`:
 *   - dashed border + corner banner ("Agent draft · review before sending")
 *   - eyebrow line with source + relative timestamp
 *   - title = `{value} {unit} · {service_item_code}` (per the spec)
 *   - body = short description from the captured quantity
 *   - `Attribution` line at the bottom naming the producing pipeline
 *   - three equal-weight buttons (Confirm / Edit / Reject)
 *
 * The Edit toggle reveals an inline `service_item_code` input; pressing
 * Confirm afterwards forwards the typed value as a per-quantity override.
 */
interface AgentSuggestionCardProps {
  quantity: CapturedQuantity
  draftSource: TakeoffDraft['source']
  pipelineVersion: string | null | undefined
  capturedAt: string
  override: string
  isEditing: boolean
  isBusy: boolean
  onOverrideChange: (value: string) => void
  onConfirm: () => void
  onToggleEdit: () => void
  onReject: () => void
}

function AgentSuggestionCard({
  quantity,
  draftSource,
  pipelineVersion,
  capturedAt,
  override,
  isEditing,
  isBusy,
  onOverrideChange,
  onConfirm,
  onToggleEdit,
  onReject,
}: AgentSuggestionCardProps) {
  const bucket = confidenceBucket(quantity.confidence)
  const sparkState = confidenceState(bucket)
  const provenanceKind = quantity.provenance?.kind
  const displayedCode = override.trim() || derivedCodeFor(quantity) || 'unknown code'
  const banner = `Agent draft · ${confidenceLabel(bucket).toLowerCase()}`
  return (
    <AgentSurface banner={banner}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">
            <Spark state={sparkState} size={11} aria-label={confidenceLabel(bucket)} />
            <span>
              {formatSource(draftSource, provenanceKind)} · captured {formatRelativeTime(capturedAt)}
            </span>
          </div>
          <div className="mt-1 text-[13px] font-semibold leading-tight">
            <span className="font-mono tabular-nums">
              {Number(quantity.value).toFixed(2)} {quantity.unit}
            </span>{' '}
            · <span className="font-mono">{displayedCode}</span>
          </div>
          {quantity.description ? (
            <div className="mt-1 text-[12px] text-ink-2 leading-snug">{quantity.description}</div>
          ) : null}
        </div>
      </div>

      {isEditing ? (
        <div className="mt-2 flex items-center gap-2">
          <label
            htmlFor={`agent-code-${quantity.id}`}
            className="text-[10px] uppercase tracking-[0.06em] text-ink-3 shrink-0"
          >
            Code
          </label>
          <input
            id={`agent-code-${quantity.id}`}
            type="text"
            value={override}
            onChange={(e) => onOverrideChange(e.target.value)}
            placeholder={derivedCodeFor(quantity) ?? 'service_item_code'}
            className="flex-1 min-w-0 px-2 py-1 rounded border border-line bg-card-soft text-[12px] font-mono"
          />
        </div>
      ) : null}

      <div className="mt-3 pt-2 border-t border-dashed border-line-2 flex items-center justify-between gap-2">
        <Attribution
          source="Based on"
          emphasis={attributionEmphasisFor(provenanceKind, draftSource, pipelineVersion)}
          state={sparkState}
        />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <MobileButton variant="primary" size="sm" fullWidth={false} onClick={onConfirm} disabled={isBusy}>
          {isBusy ? 'Working…' : 'Confirm'}
        </MobileButton>
        <MobileButton
          variant={isEditing ? 'quiet' : 'ghost'}
          size="sm"
          fullWidth={false}
          onClick={onToggleEdit}
          disabled={isBusy}
        >
          {isEditing ? 'Done' : 'Edit'}
        </MobileButton>
        <MobileButton variant="ghost" size="sm" fullWidth={false} onClick={onReject} disabled={isBusy}>
          Reject
        </MobileButton>
      </div>
    </AgentSurface>
  )
}

/** Prefer MasterFormat (matches sitelayer's curated service_items code
 * shape), then UniFormat, then OmniClass. Returns null when the quantity
 * carries no classification at all — the operator must type one before
 * the promote endpoint will accept it. */
function derivedCodeFor(q: CapturedQuantity): string | null {
  return q.masterformatCode ?? q.uniformatCode ?? q.omniclassCode ?? null
}

/**
 * Elevation tags from Sitemap §5 panel 1 ("Items by location"). Stored
 * as a first-class column (`elevation`) on `takeoff_measurements` since
 * migration 042. The legacy `elev:<tag>` notes prefix is migrated in
 * place by 042's UPDATE; this helper still exists for any pre-migrated
 * data the API might return null `elevation` on.
 */
export const ELEVATION_TAGS = ['none', 'east', 'south', 'west', 'north', 'roof', 'other'] as const
export type ElevationTag = (typeof ELEVATION_TAGS)[number]

export function readElevation(measurement: { elevation: string | null; notes: string | null }): ElevationTag {
  if (measurement.elevation) {
    const t = measurement.elevation.toLowerCase()
    return ELEVATION_TAGS.includes(t as ElevationTag) ? (t as ElevationTag) : 'other'
  }
  // Fallback: parse legacy notes-prefix for any rows that escaped the
  // 042 backfill (e.g. queued offline mutations from an older client).
  if (!measurement.notes) return 'none'
  const match = /^elev:(\w+)/i.exec(measurement.notes.trim())
  if (!match) return 'none'
  const t = match[1]?.toLowerCase()
  return ELEVATION_TAGS.includes(t as ElevationTag) ? (t as ElevationTag) : 'other'
}
