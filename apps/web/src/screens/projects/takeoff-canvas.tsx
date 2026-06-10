import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useAuthenticatedObjectUrl } from '@/lib/api/blob-url'
import { currentCaptureRoutePath } from '@/lib/capture-session'
import { registerCaptureArtifactProvider } from '@/lib/capture-artifact-providers'
import { registerCaptureStateProvider } from '@/lib/capture-state-providers'
import {
  useBlueprintPages,
  useCaptureTakeoffDraft,
  useCreateMeasurement,
  useCreateTakeoffDraft,
  useDuplicateTakeoffDraft,
  useProjectBlueprints,
  useProjectMeasurements,
  useServiceItems,
  useTakeoffDrafts,
  useUpdateTakeoffDraft,
  useUploadBlueprint,
  type BlueprintDocument,
  type BlueprintPage,
  type CaptureKind,
  type MeasurementGeometry,
  type ServiceItem,
  type TakeoffDraft,
  type TakeoffMeasurement,
} from '@/lib/api'
import { ELEVATION_TAGS, type ElevationTag } from '@/lib/takeoff/elevation'
import { AgentSuggestionsPanel } from '@/screens/desktop/est-canvas/agent-suggestions-panel'
import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { buildCanvasGeometryArtifact, uploadCanvasGeometryArtifact } from '@/lib/takeoff/canvas-geometry-artifact'
import { buildTakeoffCanvasStateSnapshot } from '@/lib/takeoff/canvas-state-snapshot'
import { clamp, screenToBoardPoint } from '@/lib/takeoff/canvas-math'
import { useRole } from '@/lib/role'
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
  const blueprints = useProjectBlueprints(projectId)
  const serviceItems = useServiceItems()
  const create = useCreateMeasurement(projectId ?? '')

  // Blueprint upload — admin/foreman/office only (hidden for worker).
  const role = useRole()
  const canUploadBlueprint = role === 'owner' || role === 'foreman'
  const uploadBlueprint = useUploadBlueprint(projectId ?? '')
  const blueprintFileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const onPickBlueprintFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    setUploadError(null)
    uploadBlueprint.mutate(file, {
      onSuccess: (doc) => {
        setBlueprint(doc.id)
        void blueprints.refetch()
      },
      onError: (err) => setUploadError(err instanceof Error ? err.message : 'Upload failed'),
    })
  }

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
    const local = screenToBoardPoint(svg, e.clientX, e.clientY)
    if (!local) return
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

  useEffect(() => {
    if (!projectId) return
    const shouldCapture = () => activeBlueprint || blueprintMeasurements.length > 0 || draftPoints.length > 0
    const unregisterArtifact = registerCaptureArtifactProvider(
      `takeoff:project:${projectId}`,
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
          viewport: { zoom, mode: 'draw', tool },
          draft: {
            points: draftPoints,
            quantity: draftQuantity,
            service_item_code: serviceItemCode,
            elevation,
          },
          selection: {
            tag_sheet_measurement_id: tagSheetMeasurementId,
          },
          measurements: blueprintMeasurements,
        })
        return uploadCanvasGeometryArtifact(captureSessionId, payload, {
          ...metadata,
          surface: 'project_takeoff_canvas',
        })
      },
    )
    const unregisterState = registerCaptureStateProvider(`takeoff:project:${projectId}`, ({ reason }) => {
      if (!shouldCapture()) return null
      return buildTakeoffCanvasStateSnapshot({
        surface: 'project_takeoff_canvas',
        project_id: projectId,
        route_path: currentCaptureRoutePath(),
        reason,
        active_draft: activeDraft,
        active_blueprint: activeBlueprint,
        active_page: activePage,
        viewport: { zoom, mode: 'draw', tool },
        session: {
          mode: 'legacy_project_takeoff_canvas',
          tool,
          active_page_id: activePage?.id ?? null,
          tag_sheet_open: Boolean(tagSheetMeasurementId),
        },
        draft: {
          points: draftPoints,
          quantity: draftQuantity,
          service_item_code: serviceItemCode,
          elevation,
        },
        selection: {
          tag_sheet_measurement_id: tagSheetMeasurementId,
        },
        measurements: blueprintMeasurements,
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
    blueprintMeasurements,
    draftPoints,
    draftQuantity,
    elevation,
    projectId,
    serviceItemCode,
    tagSheetMeasurementId,
    tool,
    zoom,
  ])

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

      {canUploadBlueprint ? (
        <input
          ref={blueprintFileInputRef}
          type="file"
          accept="application/pdf,image/*"
          className="hidden"
          onChange={onPickBlueprintFile}
        />
      ) : null}

      {blueprintList.length === 0 ? (
        <div className="px-4 pb-8">
          <Card>
            <div className="text-[13px] font-semibold">No blueprints uploaded</div>
            <div className="text-[12px] text-ink-3 mt-1">Upload a PDF or image to start drawing measurements.</div>
            {canUploadBlueprint ? (
              <div className="mt-3">
                <MobileButton
                  variant="primary"
                  onClick={() => blueprintFileInputRef.current?.click()}
                  disabled={uploadBlueprint.isPending}
                >
                  {uploadBlueprint.isPending ? 'Uploading…' : 'Upload blueprint'}
                </MobileButton>
                {uploadError ? <div className="text-[12px] text-warn mt-2">{uploadError}</div> : null}
              </div>
            ) : (
              <div className="text-[12px] text-ink-3 mt-3">Ask an estimator or admin to upload the plan set.</div>
            )}
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

// Elevation tags + helpers now live in `@/lib/takeoff/elevation` (shared with
// the est-canvas editor and the projects/* summary cluster). Imported at the
// top of this file for internal use.
