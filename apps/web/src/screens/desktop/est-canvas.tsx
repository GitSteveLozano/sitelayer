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
  useBlueprintPages,
  useCreateMeasurement,
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
import { buildBlueprintReference } from '@/lib/takeoff/blueprint-reference'
import { MButton, MSelect } from '@/components/m'

type Tool = 'polygon' | 'lineal' | 'count'

const MAX_POLYGON_POINTS = 64

export function EstCanvas() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  // --- Drafts (reuse mobile data layer; default to active/first) -----------
  const drafts = useTakeoffDrafts(projectId)
  const draftList = useMemo(() => drafts.data?.drafts ?? [], [drafts.data])
  const activeDraft: TakeoffDraft | null =
    draftList.find((d) => d.status === 'active') ?? draftList[0] ?? null
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

  const blueprintPages = useBlueprintPages(activeBlueprint?.id)
  const pages = useMemo(() => blueprintPages.data?.pages ?? [], [blueprintPages.data])
  const [pageId, setPageId] = useState<string | null>(null)
  const activePage: BlueprintPage | null = pages.find((p) => p.id === pageId) ?? pages[0] ?? null

  const blueprintReference = useMemo(
    () => buildBlueprintReference(activeBlueprint, activePage),
    [activeBlueprint, activePage],
  )
  const sourceImage = useAuthenticatedObjectUrl(blueprintReference?.texturePath)

  // --- Measurements ---------------------------------------------------------
  const measurements = useProjectMeasurements(projectId, { draftId: activeDraftId })
  const create = useCreateMeasurement(projectId)
  const serviceItems = useServiceItems()
  const items = useMemo(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])

  // --- Entry state (identical semantics to mobile draw mode) ----------------
  const [tool, setTool] = useState<Tool>('polygon')
  const [serviceItemCode, setServiceItemCode] = useState('')
  const [draftPoints, setDraftPoints] = useState<TakeoffPoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savedToast, setSavedToast] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

  const selectedItem = items.find((i) => i.code === serviceItemCode) ?? null
  const unitForItem =
    selectedItem?.unit ?? (tool === 'polygon' ? 'sqft' : tool === 'lineal' ? 'lf' : 'ea')

  // --- Geometry (unchanged from mobile) ------------------------------------
  const draftQuantity = useMemo(() => {
    if (tool === 'polygon') return round2(calculatePolygonArea(draftPoints))
    if (tool === 'lineal') return round2(calculateLinealLength(draftPoints))
    return draftPoints.length
  }, [tool, draftPoints])

  // EXACT same CTM math as takeoff-mobile.tsx — do not change.
  const onCanvasTap = (e: ReactPointerEvent<SVGSVGElement>) => {
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

  const minPoints = tool === 'polygon' ? 3 : tool === 'lineal' ? 2 : 1
  const canSave =
    !create.isPending && Boolean(serviceItemCode) && draftQuantity > 0 && draftPoints.length >= minPoints

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
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const draftMeasurements = measurements.data?.measurements ?? []
  const blueprintMeasurements = draftMeasurements.filter(
    (m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id,
  )
  const totals = useMemo(() => buildScopeTotals(draftMeasurements), [draftMeasurements])
  const grandTotal = totals.reduce((s, t) => s + t.quantity, 0)

  const loading = drafts.isLoading || blueprints.isLoading

  // ---- Loading state -------------------------------------------------------
  if (loading) {
    return (
      <div
        className="d-content-full"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
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
      {/* ---- Full-bleed SVG drawing surface (same board space as mobile) ---- */}
      <div style={{ position: 'absolute', inset: 0, background: 'var(--m-ink-2)', overflow: 'hidden' }}>
        {sourceImage.url ? (
          <img
            src={sourceImage.url}
            alt=""
            draggable={false}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 0.7 }}
          />
        ) : null}
        <svg
          ref={svgRef}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          onPointerDown={onCanvasTap}
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

          {/* Saved measurements on this blueprint (same render as mobile) */}
          {blueprintMeasurements.map((m) => {
            const geo = m.geometry as MeasurementGeometry
            if (geo.kind === 'polygon' && geo.points && geo.points.length >= 3) {
              const c = calculatePolygonCentroid(geo.points)
              return (
                <g key={m.id}>
                  <polygon
                    points={geo.points.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="rgba(217,144,74,0.18)"
                    stroke="var(--m-accent)"
                    strokeWidth={0.4}
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
          <MButton variant="primary" onClick={() => navigate(`/projects/${projectId}/estimate`)}>
            Done →
          </MButton>
        </span>
      </div>

      {/* ---- TOOL palette (top-left, below the strip) ---- */}
      <div style={floatBox({ top: 92, left: 16, width: 56 })}>
        <div style={{ ...floatHead, padding: '8px 0', textAlign: 'center' }}>TOOL</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {([
            { tool: 'polygon', label: 'POLY' },
            { tool: 'rect', label: 'RECT' },
            { tool: 'lineal', label: 'LIN' },
            { tool: 'count', label: 'PT' },
            { tool: 'tap', label: 'TAP' },
          ] as const).map((t, i, arr) => {
            // RECT/TAP are aliases that drive the same underlying tool values as
            // the mobile surface (polygon / count); no new geometry is introduced.
            const value: Tool = t.tool === 'rect' ? 'polygon' : t.tool === 'tap' ? 'count' : (t.tool as Tool)
            const on =
              (t.tool === 'polygon' && tool === 'polygon') ||
              (t.tool === 'lineal' && tool === 'lineal') ||
              (t.tool === 'count' && tool === 'count')
            return (
              <button
                key={t.label}
                type="button"
                onClick={() => {
                  setTool(value)
                  setDraftPoints([])
                }}
                style={{
                  width: 56,
                  height: 56,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: on ? 'var(--m-accent)' : 'var(--m-sand)',
                  color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  border: 'none',
                  borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
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
              </option>
            ))}
          </MSelect>

          {/* Live measurement readout (big-number) */}
          <div style={{ padding: '12px 14px', background: 'var(--m-ink)', color: 'var(--m-sand)', border: '2px solid var(--m-ink)' }}>
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
                {tool === 'polygon' ? unitForItem : tool === 'lineal' ? unitForItem : draftPoints.length === 1 ? 'CT' : 'CTS'}
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
            {create.isPending ? 'Saving…' : `Add ${draftQuantity > 0 ? formatQty(draftQuantity) : ''} ${unitForItem}`.trim()}
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
