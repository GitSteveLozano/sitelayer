import { type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { calculatePolygonCentroid, type TakeoffPoint } from '@sitelayer/domain'
import { type MeasurementGeometry } from '@/lib/api'
import { clamp, screenToBoardPoint } from '@/lib/takeoff/canvas-math'
import { formatQty } from '@/lib/takeoff/canvas-totals'
import { HEIGHT_PRESETS, stepperBtn } from './constants'
import { type MobileCanvasSurfaceProps } from './types'

// ---------------------------------------------------------------------------
// Segmented control — small two/three-up toggle built from m-btn so it
// matches the rest of the mobile design language without a new primitive.
// ---------------------------------------------------------------------------
export function SegmentedControl({
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
export function WallHeightPanel({
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

// ---------------------------------------------------------------------------
// Pitch → slope-corrected area. Mirrors the desktop pitch driver: a rise:run
// turns plan area/length into true sloped-surface area/length (the server
// applies √(rise²+run²)/run). Critical for exterior envelope (roof / sloped
// wall) takeoff. Empty rise ⇒ flat (factor 1.0). Presets cover the common
// residential roof pitches.
// ---------------------------------------------------------------------------
const PITCH_PRESETS = ['4', '6', '8', '12'] as const

export function PitchPanel({
  rise,
  run,
  onRise,
  onRun,
  factor,
}: {
  rise: string
  run: string
  onRise: (v: string) => void
  onRun: (v: string) => void
  factor: number
}) {
  const active = factor > 1
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
        <span className="m-topbar-eyebrow">PITCH → SLOPE AREA</span>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            background: active ? 'var(--m-ink)' : 'transparent',
            color: active ? 'var(--m-sand)' : 'var(--m-ink-3)',
            padding: '3px 8px',
          }}
        >
          ×{active ? factor.toFixed(3) : '1.000'}
        </span>
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step="any"
            placeholder="0"
            aria-label="Pitch rise"
            value={rise}
            onChange={(e) => onRise(e.target.value)}
            style={pitchInput}
          />
          <span style={{ fontFamily: 'var(--m-num)', fontSize: 13, fontWeight: 700, color: 'var(--m-ink-2)' }}>:</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step="any"
            aria-label="Pitch run"
            value={run}
            onChange={(e) => onRun(e.target.value)}
            style={pitchInput}
          />
          <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 600, color: 'var(--m-ink-3)' }}>
            rise : run
          </span>
        </label>
      </div>
      <div style={{ padding: '0 14px 12px', display: 'flex', gap: 6 }}>
        {PITCH_PRESETS.map((r) => {
          const on = rise === r && run === '12'
          return (
            <button
              key={r}
              type="button"
              onClick={() => {
                onRise(on ? '' : r)
                onRun('12')
              }}
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
              {r}/12
            </button>
          )
        })}
      </div>
    </div>
  )
}

const pitchInput: CSSProperties = {
  width: 56,
  padding: '8px 10px',
  background: 'var(--m-bg)',
  color: 'var(--m-ink)',
  border: '2px solid var(--m-ink)',
  fontFamily: 'var(--m-font-display)',
  fontWeight: 800,
  fontSize: 22,
  textAlign: 'center',
}

// ---------------------------------------------------------------------------
// Sheet-scale calibration (parity with the desktop DCanvasScale overlay). Tap
// two points of a known dimension on the sheet above, type its real-world
// length, and Apply persists the scale to the page so every later measurement
// reads in true sqft/lf. Mirrors the desktop flow on the phone form factor.
// ---------------------------------------------------------------------------
export function MobileScalePanel({
  scalePoints,
  scaleLength,
  onScaleLength,
  scaleError,
  onApply,
  onCancel,
  applyPending,
}: {
  scalePoints: TakeoffPoint[]
  scaleLength: string
  onScaleLength: (v: string) => void
  scaleError: string | null
  onApply: () => void
  onCancel: () => void
  applyPending: boolean
}) {
  const ready = scalePoints.length >= 2
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
        <span className="m-topbar-eyebrow">SET SHEET SCALE</span>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            background: ready ? 'var(--m-ink)' : 'transparent',
            color: ready ? 'var(--m-sand)' : 'var(--m-ink-3)',
            padding: '3px 8px',
          }}
        >
          {scalePoints.length}/2 PTS
        </span>
      </div>
      <div style={{ padding: '10px 14px 0', fontSize: 12, color: 'var(--m-ink-3)', lineHeight: 1.45 }}>
        {ready
          ? 'Enter the real-world length of the line you drew, then Apply.'
          : 'Tap two points of a known dimension on the sheet above.'}
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          aria-label="Real-world length in feet"
          value={scaleLength}
          onChange={(e) => onScaleLength(e.target.value.replace(/[^\d.]/g, ''))}
          style={{ ...pitchInput, width: 92 }}
        />
        <span style={{ fontFamily: 'var(--m-num)', fontSize: 13, fontWeight: 700, color: 'var(--m-ink-3)' }}>FT</span>
      </div>
      {scaleError ? (
        <div style={{ padding: '0 14px 8px', fontSize: 12, fontWeight: 600, color: 'var(--m-red)' }}>{scaleError}</div>
      ) : null}
      <div style={{ padding: '0 14px 12px', display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onApply}
          disabled={!ready || applyPending}
          style={{
            flex: 2,
            padding: '10px 0',
            background: ready ? 'var(--m-accent)' : 'transparent',
            color: ready ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
            border: '2px solid var(--m-ink)',
            fontFamily: 'var(--m-num)',
            fontSize: 12,
            fontWeight: 700,
            cursor: ready ? 'pointer' : 'default',
          }}
        >
          {applyPending ? 'SAVING…' : 'APPLY TO SHEET'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            flex: 1,
            padding: '10px 0',
            background: 'transparent',
            color: 'var(--m-ink-2)',
            border: '2px solid var(--m-ink)',
            fontFamily: 'var(--m-num)',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          CANCEL
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Canvas — board-space (0–100) SVG overlay matching the desktop canvas so
// rows are interchangeable. Touch-friendly: full-width square, tap to drop
// points. Pinch-zoom is deferred (manual entry covers the no-zoom case).
// ---------------------------------------------------------------------------
export function MobileCanvasSurface({
  svgRef,
  tool,
  deduct,
  onTap,
  draftPoints,
  measurements,
  selectedId,
  bulkIds,
  onSelectMeasurement,
  underlay,
  editId,
  editPoints,
  editDragIdxRef,
  onEditPoint,
  scalePoints,
  arcPreview,
}: MobileCanvasSurfaceProps) {
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
      {underlay}
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
        {/* ARC tool: the smooth tessellated curve through the 3 control points
            (the control points themselves render as dots below). */}
        {tool === 'arc' && arcPreview && arcPreview.length >= 2 ? (
          <polyline
            points={arcPreview.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--m-amber)"
            strokeWidth={0.5}
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
        {/* SCALE mode: the calibration reference line + endpoint markers. */}
        {scalePoints && scalePoints.length > 0 ? (
          <g aria-hidden="true">
            {scalePoints.length >= 2 ? (
              <line
                x1={scalePoints[0]!.x}
                y1={scalePoints[0]!.y}
                x2={scalePoints[1]!.x}
                y2={scalePoints[1]!.y}
                stroke="var(--m-amber)"
                strokeWidth={0.6}
              />
            ) : null}
            {scalePoints.map((p, i) => (
              <g key={`sp${i}`}>
                <circle cx={p.x} cy={p.y} r={1.2} fill="var(--m-amber)" stroke="var(--m-ink)" strokeWidth={0.4} />
                <line x1={p.x - 2} y1={p.y} x2={p.x + 2} y2={p.y} stroke="var(--m-ink)" strokeWidth={0.3} />
                <line x1={p.x} y1={p.y - 2} x2={p.x} y2={p.y + 2} stroke="var(--m-ink)" strokeWidth={0.3} />
              </g>
            ))}
          </g>
        ) : null}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// NOTE: this is kept local (NOT the shared `@/lib/takeoff/canvas-totals`
// `buildScopeTotals`) because the mobile copy DRIFTED from desktop — it sums
// `quantity` WITHOUT the `is_deduction` sign that the desktop/server use. Until
// that behavioral difference is reconciled it stays separate so the
// Blocker-1 canvas-math extraction is a pure, behavior-identical refactor.
// buildMobileScopeTotals removed — it duplicated buildScopeTotals but dropped the
// is_deduction sign (overcounting net quantity). The mobile body now uses the
// canonical signed buildScopeTotals from lib/takeoff/canvas-totals.
