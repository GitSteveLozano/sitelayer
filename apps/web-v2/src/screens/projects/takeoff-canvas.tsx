import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  useCreateMeasurement,
  useProjectBlueprints,
  useProjectMeasurements,
  useServiceItems,
  type BlueprintDocument,
  type MeasurementGeometry,
  type ServiceItem,
  type TakeoffMeasurement,
} from '@/lib/api'

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
  const measurements = useProjectMeasurements(projectId)
  const serviceItems = useServiceItems()
  const create = useCreateMeasurement(projectId ?? '')

  const blueprintParam = searchParams.get('blueprint')
  const activeBlueprint: BlueprintDocument | null =
    (blueprints.data?.blueprints ?? []).find((b) => b.id === blueprintParam) ?? blueprints.data?.blueprints[0] ?? null

  const setBlueprint = (id: string) => {
    const sp = new URLSearchParams(searchParams)
    sp.set('blueprint', id)
    setSearchParams(sp, { replace: true })
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

  // Pick a default service item once the catalog loads.
  useEffect(() => {
    if (!serviceItemCode && serviceItems.data?.serviceItems[0]) {
      setServiceItemCode(serviceItems.data.serviceItems[0].code)
    }
  }, [serviceItemCode, serviceItems.data])

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
    (m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id,
  )

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
          ← Takeoff hub
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight truncate">
            {activeBlueprint?.file_name ?? 'No blueprint'}
          </h1>
          <div className="flex items-center gap-3 shrink-0">
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

          <div className="px-4">
            <CanvasSurface
              svgRef={svgRef}
              tool={tool}
              zoom={zoom}
              onTap={onCanvasTap}
              draftPoints={draftPoints}
              measurements={blueprintMeasurements}
            />
          </div>

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

            <Attribution source="POST /api/projects/:id/takeoff/measurement · geometry shared with @sitelayer/domain" />
          </div>
        </>
      )}
    </div>
  )
}

interface CanvasSurfaceProps {
  svgRef: React.RefObject<SVGSVGElement | null>
  tool: 'polygon' | 'lineal' | 'count'
  zoom: number
  onTap: (e: ReactPointerEvent<SVGSVGElement>) => void
  draftPoints: Array<{ x: number; y: number }>
  measurements: TakeoffMeasurement[]
}

function CanvasSurface({ svgRef, tool, zoom, onTap, draftPoints, measurements }: CanvasSurfaceProps) {
  const viewBoxSize = 100 / zoom
  const viewBoxOrigin = (100 - viewBoxSize) / 2
  return (
    <div className="relative w-full aspect-square bg-card-soft rounded-md overflow-hidden border border-line">
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
          if (geo.kind === 'polygon' && geo.points && geo.points.length >= 3) {
            return (
              <polygon
                key={m.id}
                points={geo.points.map((p) => `${p.x},${p.y}`).join(' ')}
                className="fill-accent/15 stroke-accent"
                strokeWidth={0.3}
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
              />
            )
          }
          if (geo.kind === 'count' && geo.points) {
            return (
              <g key={m.id}>
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
