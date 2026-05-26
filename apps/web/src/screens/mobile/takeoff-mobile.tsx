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
  const serviceItems = useServiceItems()
  const items = useMemo(() => serviceItems.data?.serviceItems ?? [], [serviceItems.data])

  // --- Entry state ----------------------------------------------------------
  const [mode, setMode] = useState<Mode>('manual')
  const [tool, setTool] = useState<Tool>('polygon')
  const [serviceItemCode, setServiceItemCode] = useState('')
  const [manualQty, setManualQty] = useState('')
  const [draftPoints, setDraftPoints] = useState<TakeoffPoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savedToast, setSavedToast] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Default the scope item once the catalog loads.
  useEffect(() => {
    if (!serviceItemCode && items[0]) setServiceItemCode(items[0].code)
  }, [serviceItemCode, items])

  const selectedItem = items.find((i) => i.code === serviceItemCode) ?? null
  const unitForItem =
    selectedItem?.unit ?? (mode === 'draw' && tool === 'polygon' ? 'sqft' : tool === 'lineal' ? 'lf' : 'ea')

  const draftQuantity = useMemo(() => {
    if (mode === 'manual') return Number(manualQty) || 0
    if (tool === 'polygon') return round2(calculatePolygonArea(draftPoints))
    if (tool === 'lineal') return round2(calculateLinealLength(draftPoints))
    return draftPoints.length
  }, [mode, tool, manualQty, draftPoints])

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
      } else {
        geometry = { kind: 'count', points: draftPoints }
      }
      const res = await create.mutateAsync({
        blueprint_document_id: activeBlueprint?.id ?? null,
        page_id: activePage?.id ?? null,
        service_item_code: serviceItemCode,
        unit: unitForItem,
        ...(quantity !== undefined ? { quantity } : {}),
        geometry,
        // Land on the selected draft; null falls back to the project default.
        draft_id: activeDraftId,
      })
      setDraftPoints([])
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

                {/* --- Canvas (draw mode) --- */}
                {mode === 'draw' ? (
                  <div style={{ padding: '10px 16px 0' }}>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                      {(['polygon', 'lineal', 'count'] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => {
                            setTool(t)
                            setDraftPoints([])
                          }}
                          className="m-btn m-btn-sm"
                          data-variant={tool === t ? 'primary' : 'quiet'}
                          style={{ flex: 1, textTransform: 'capitalize' }}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <CanvasSurface
                      svgRef={svgRef}
                      tool={tool}
                      onTap={onCanvasTap}
                      draftPoints={draftPoints}
                      measurements={draftMeasurements.filter(
                        (m) => activeBlueprint && m.blueprint_document_id === activeBlueprint.id,
                      )}
                      sourceImageUrl={sourceImage.url}
                    />
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: 12,
                        color: 'var(--m-ink-3)',
                        padding: '6px 2px 0',
                      }}
                    >
                      <span>
                        {tool === 'polygon'
                          ? `${draftPoints.length} pts · area ${formatQty(draftQuantity)}`
                          : tool === 'lineal'
                            ? `${draftPoints.length} pts · length ${formatQty(draftQuantity)}`
                            : `${draftPoints.length} ${draftPoints.length === 1 ? 'count' : 'counts'}`}
                      </span>
                      <span style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => setDraftPoints((p) => p.slice(0, -1))}
                          disabled={draftPoints.length === 0}
                          className="m-link"
                          style={{ opacity: draftPoints.length === 0 ? 0.4 : 1 }}
                        >
                          Undo
                        </button>
                        <button
                          type="button"
                          onClick={() => setDraftPoints([])}
                          disabled={draftPoints.length === 0}
                          className="m-link"
                          style={{ opacity: draftPoints.length === 0 ? 0.4 : 1 }}
                        >
                          Clear
                        </button>
                      </span>
                    </div>
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
                    <div style={{ padding: '8px 16px 16px' }}>
                      <MButton variant="ghost" onClick={() => navigate(`/projects/${projectId}/estimate`)}>
                        Review estimate →
                      </MButton>
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
// Canvas — board-space (0–100) SVG overlay matching the desktop canvas so
// rows are interchangeable. Touch-friendly: full-width square, tap to drop
// points. Pinch-zoom is deferred (manual entry covers the no-zoom case).
// ---------------------------------------------------------------------------
interface CanvasSurfaceProps {
  svgRef: React.RefObject<SVGSVGElement | null>
  tool: Tool
  onTap: (e: ReactPointerEvent<SVGSVGElement>) => void
  draftPoints: TakeoffPoint[]
  measurements: TakeoffMeasurement[]
  sourceImageUrl?: string | null
}

function CanvasSurface({ svgRef, tool, onTap, draftPoints, measurements, sourceImageUrl }: CanvasSurfaceProps) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '1 / 1',
        background: 'var(--m-card-soft)',
        borderRadius: 'var(--m-r)',
        overflow: 'hidden',
        border: '1px solid var(--m-line)',
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
          {Array.from({ length: 11 }, (_, i) => (
            <line key={`h${i}`} x1={0} x2={100} y1={i * 10} y2={i * 10} stroke="var(--m-line)" strokeWidth={0.1} />
          ))}
          {Array.from({ length: 11 }, (_, i) => (
            <line key={`v${i}`} x1={i * 10} x2={i * 10} y1={0} y2={100} stroke="var(--m-line)" strokeWidth={0.1} />
          ))}
        </g>

        {/* Saved measurements on this blueprint */}
        {measurements.map((m) => {
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
                  <text x={c.x} y={c.y} fontSize={3} textAnchor="middle" fill="var(--m-ink)" fontWeight={600}>
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

        {/* Draft-in-progress */}
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
