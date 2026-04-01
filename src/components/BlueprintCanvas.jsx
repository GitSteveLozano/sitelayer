import { useEffect, useRef, useState, useCallback } from 'react'
import { TH } from '../lib/theme'
import { Btn, Card, Label } from './Atoms'

// ─── PDF.js worker setup ─────────────────────────────────────────────────────
import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// ─── Scope item config ────────────────────────────────────────────────────────
const SCOPE_ITEMS = [
  { id: 'Air Barrier',   color: '#3b82f6' },
  { id: 'EPS Foam',      color: '#f59e0b' },
  { id: 'Scratch Coat',  color: '#8b5cf6' },
  { id: 'Finish Coat',   color: '#22c55e' },
  { id: 'Trim & Detail', color: '#ec4899' },
]

// ─── Shoelace formula: polygon area in px² ───────────────────────────────────
function polygonArea(points) {
  let area = 0
  const n = points.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += points[i].x * points[j].y
    area -= points[j].x * points[i].y
  }
  return Math.abs(area / 2)
}

// ─── Convert px² → sqft using scale ─────────────────────────────────────────
function pxToSqft(pxArea, pxPerFt) {
  if (!pxPerFt) return 0
  return pxArea / (pxPerFt * pxPerFt)
}

export function BlueprintCanvas({ project, blueprintUrl, onMeasurementsApplied, onBack }) {
  const containerRef  = useRef(null)
  const canvasRef     = useRef(null)
  const fabricRef     = useRef(null)
  const pdfDocRef     = useRef(null)
  const renderTaskRef = useRef(null)

  const [pageNum,       setPageNum]       = useState(1)
  const [numPages,      setNumPages]      = useState(0)
  const [loading,       setLoading]       = useState(true)
  const [loadError,     setLoadError]     = useState(null)
  const [mode,          setMode]          = useState('pan') // pan | calibrate | draw
  const [activeScope,   setActiveScope]   = useState('Air Barrier')
  const [pxPerFt,       setPxPerFt]       = useState(null)
  const [calibPoints,   setCalibPoints]   = useState([]) // two clicks for calibration
  const [calibDist,     setCalibDist]     = useState('')  // user-entered real distance
  const [drawPoints,    setDrawPoints]    = useState([])  // current polygon in progress
  const [polygons,      setPolygons]      = useState([])  // completed polygons
  const [canvasSize,    setCanvasSize]    = useState({ w: 900, h: 600 })
  const [zoom,          setZoom]          = useState(1)
  const [showHelp,      setShowHelp]      = useState(true)

  // ── Load PDF ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!blueprintUrl) return
    setLoading(true)
    setLoadError(null)

    pdfjsLib.getDocument(blueprintUrl).promise
      .then(doc => {
        pdfDocRef.current = doc
        setNumPages(doc.numPages)
        renderPage(doc, 1)
      })
      .catch(err => {
        setLoadError('Could not load PDF. The link may have expired — try re-uploading.')
        setLoading(false)
        console.error(err)
      })
  }, [blueprintUrl])

  // ── Render page ─────────────────────────────────────────────────────────────
  const renderPage = useCallback(async (doc, num) => {
    if (!canvasRef.current) return
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel()
    }

    setLoading(true)
    const page     = await doc.getPage(num)
    const viewport = page.getViewport({ scale: 1.5 })
    const canvas   = canvasRef.current
    const ctx      = canvas.getContext('2d')

    canvas.width  = viewport.width
    canvas.height = viewport.height
    setCanvasSize({ w: viewport.width, h: viewport.height })

    const task = page.render({ canvasContext: ctx, viewport })
    renderTaskRef.current = task

    try {
      await task.promise
      setLoading(false)
    } catch (e) {
      if (e.name !== 'RenderingCancelledException') {
        setLoadError('Page render failed.')
        setLoading(false)
      }
    }
  }, [])

  // ── Handle page change ───────────────────────────────────────────────────────
  useEffect(() => {
    if (pdfDocRef.current) {
      renderPage(pdfDocRef.current, pageNum)
    }
  }, [pageNum, renderPage])

  // ── Canvas click handler ─────────────────────────────────────────────────────
  function handleCanvasClick(e) {
    const rect  = e.currentTarget.getBoundingClientRect()
    const x     = (e.clientX - rect.left) / zoom
    const y     = (e.clientY - rect.top)  / zoom
    const point = { x, y }

    if (mode === 'calibrate') {
      const next = [...calibPoints, point]
      setCalibPoints(next)
      if (next.length === 2) {
        // Two points selected — wait for user to enter distance
      }
    }

    if (mode === 'draw') {
      setDrawPoints(prev => [...prev, point])
    }
  }

  // ── Double-click closes polygon ──────────────────────────────────────────────
  function handleDoubleClick() {
    if (mode === 'draw' && drawPoints.length >= 3) {
      const area  = polygonArea(drawPoints)
      const sqft  = pxToSqft(area, pxPerFt)
      setPolygons(prev => [...prev, {
        id:        Date.now(),
        points:    [...drawPoints],
        scope:     activeScope,
        color:     SCOPE_ITEMS.find(s => s.id === activeScope)?.color || TH.amber,
        sqft:      Math.round(sqft * 10) / 10,
        pxArea:    area,
        page:      pageNum,
      }])
      setDrawPoints([])
    }
  }

  // ── Confirm calibration ──────────────────────────────────────────────────────
  function confirmCalibration() {
    const dist = parseFloat(calibDist)
    if (!dist || calibPoints.length < 2) return

    const dx    = calibPoints[1].x - calibPoints[0].x
    const dy    = calibPoints[1].y - calibPoints[0].y
    const pxLen = Math.sqrt(dx * dx + dy * dy)
    const scale = pxLen / dist

    setPxPerFt(scale)
    setCalibPoints([])
    setCalibDist('')
    setMode('draw')
    setShowHelp(false)
  }

  function deletePolygon(id) {
    setPolygons(prev => prev.filter(p => p.id !== id))
  }

  // ── Summary: sqft by scope ───────────────────────────────────────────────────
  const summary = polygons.reduce((acc, poly) => {
    acc[poly.scope] = (acc[poly.scope] || 0) + poly.sqft
    return acc
  }, {})

  const totalSqft = Object.values(summary).reduce((s, v) => s + v, 0)

  function handleApply() {
    onMeasurementsApplied?.({ summary, totalSqft, polygonCount: polygons.length })
  }

  // ── Render helpers ───────────────────────────────────────────────────────────
  const svgPolygons = polygons.filter(p => p.page === pageNum)
  const scopeColor  = SCOPE_ITEMS.find(s => s.id === activeScope)?.color || TH.amber

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 80px)', gap: 0, overflow: 'hidden' }}>

      {/* ── Left panel: canvas ── */}
      <div style={{ flex: 1, overflow: 'auto', position: 'relative', background: '#1a1a2e' }}>

        {/* Toolbar */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 10,
          background: TH.card, borderBottom: `1px solid ${TH.border}`,
          padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          {/* Mode buttons */}
          {[
            { id: 'pan',       icon: '✋', label: 'Pan'       },
            { id: 'calibrate', icon: '📏', label: 'Calibrate' },
            { id: 'draw',      icon: '✏️', label: 'Draw',     disabled: !pxPerFt },
          ].map(m => (
            <button
              key={m.id}
              onClick={() => { if (!m.disabled) { setMode(m.id); setDrawPoints([]); setCalibPoints([]) } }}
              disabled={m.disabled}
              title={m.disabled ? 'Calibrate scale first' : ''}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '6px 12px', borderRadius: 5, fontSize: 12, fontFamily: 'inherit',
                background: mode === m.id ? TH.amber : TH.surf,
                color:      mode === m.id ? '#000'   : m.disabled ? TH.faint : TH.text,
                border:     `1px solid ${mode === m.id ? TH.amber : TH.border}`,
                cursor:     m.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {m.icon} {m.label}
            </button>
          ))}

          <div style={{ width: 1, height: 24, background: TH.border }} />

          {/* Scope selector */}
          {SCOPE_ITEMS.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveScope(s.id)}
              style={{
                padding: '5px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit',
                background: activeScope === s.id ? s.color + '33' : 'transparent',
                color:      activeScope === s.id ? s.color : TH.muted,
                border:     `1px solid ${activeScope === s.id ? s.color : TH.border}`,
                cursor:     'pointer',
              }}
            >
              {s.id}
            </button>
          ))}

          <div style={{ width: 1, height: 24, background: TH.border }} />

          {/* Zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setZoom(z => Math.max(0.3, z - 0.1))} style={{ ...btnStyle }}>−</button>
            <span style={{ fontSize: 11, color: TH.muted, width: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(3, z + 0.1))} style={{ ...btnStyle }}>+</button>
          </div>

          {/* Page nav */}
          {numPages > 1 && (
            <>
              <div style={{ width: 1, height: 24, background: TH.border }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={() => setPageNum(p => Math.max(1, p - 1))} disabled={pageNum === 1} style={{ ...btnStyle }}>‹</button>
                <span style={{ fontSize: 11, color: TH.muted }}>Page {pageNum} / {numPages}</span>
                <button onClick={() => setPageNum(p => Math.min(numPages, p + 1))} disabled={pageNum === numPages} style={{ ...btnStyle }}>›</button>
              </div>
            </>
          )}
        </div>

        {/* Calibration input bar */}
        {mode === 'calibrate' && calibPoints.length === 2 && (
          <div style={{
            position: 'sticky', top: 48, zIndex: 9,
            background: TH.amberLo, borderBottom: `1px solid ${TH.amber}44`,
            padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ fontSize: 13, color: TH.amber }}>📏</span>
            <span style={{ fontSize: 13, color: TH.text }}>Two points set. Enter the real-world distance:</span>
            <input
              type="number"
              value={calibDist}
              onChange={e => setCalibDist(e.target.value)}
              placeholder="e.g. 20"
              autoFocus
              style={{
                width: 80, background: TH.surf, border: `1px solid ${TH.amber}`,
                borderRadius: 5, padding: '6px 10px', color: TH.text, fontSize: 13, fontFamily: 'inherit',
              }}
            />
            <span style={{ fontSize: 13, color: TH.muted }}>feet</span>
            <Btn onClick={confirmCalibration} disabled={!calibDist} style={{ padding: '6px 16px', fontSize: 12 }}>
              Confirm Scale
            </Btn>
            <button onClick={() => { setCalibPoints([]); setCalibDist('') }}
              style={{ fontSize: 12, color: TH.muted, background: 'none', border: 'none', cursor: 'pointer' }}>
              Reset
            </button>
          </div>
        )}

        {/* Scale confirmed banner */}
        {pxPerFt && mode !== 'calibrate' && (
          <div style={{
            position: 'sticky', top: 48, zIndex: 9,
            background: TH.greenLo, borderBottom: `1px solid ${TH.green}44`,
            padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 12, color: TH.green }}>✓ Scale calibrated — {pxPerFt.toFixed(1)} px/ft</span>
            <button onClick={() => { setPxPerFt(null); setMode('calibrate') }}
              style={{ fontSize: 11, color: TH.muted, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
              Recalibrate
            </button>
          </div>
        )}

        {/* Help hint */}
        {showHelp && !pxPerFt && (
          <div style={{
            position: 'sticky', top: 48, zIndex: 9,
            background: TH.blueLo, borderBottom: `1px solid ${TH.blue}44`,
            padding: '8px 16px', fontSize: 12, color: TH.blue,
          }}>
            👆 Start by clicking <strong>Calibrate</strong> — click two points on a known dimension to set the scale, then start drawing.
          </div>
        )}

        {/* Canvas container */}
        <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
          <div
            style={{
              position: 'relative',
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              cursor: mode === 'pan' ? 'grab' : mode === 'calibrate' ? 'crosshair' : 'crosshair',
            }}
            onClick={handleCanvasClick}
            onDoubleClick={handleDoubleClick}
          >
            {/* PDF canvas */}
            <canvas ref={canvasRef} style={{ display: 'block' }} />

            {/* SVG overlay for polygons + in-progress drawing */}
            {!loading && (
              <svg
                style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
                width={canvasSize.w}
                height={canvasSize.h}
              >
                {/* Completed polygons */}
                {svgPolygons.map(poly => (
                  <g key={poly.id}>
                    <polygon
                      points={poly.points.map(p => `${p.x},${p.y}`).join(' ')}
                      fill={poly.color + '44'}
                      stroke={poly.color}
                      strokeWidth={2}
                    />
                    {/* Label at centroid */}
                    {(() => {
                      const cx = poly.points.reduce((s, p) => s + p.x, 0) / poly.points.length
                      const cy = poly.points.reduce((s, p) => s + p.y, 0) / poly.points.length
                      return (
                        <text x={cx} y={cy} textAnchor="middle" fontSize={12} fill={poly.color} fontWeight="600">
                          {poly.sqft} sqft
                        </text>
                      )
                    })()}
                  </g>
                ))}

                {/* In-progress polygon */}
                {drawPoints.length > 0 && (
                  <g>
                    {drawPoints.map((p, i) => (
                      <circle key={i} cx={p.x} cy={p.y} r={4} fill={scopeColor} />
                    ))}
                    {drawPoints.length > 1 && (
                      <polyline
                        points={drawPoints.map(p => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        stroke={scopeColor}
                        strokeWidth={2}
                        strokeDasharray="6,3"
                      />
                    )}
                  </g>
                )}

                {/* Calibration points */}
                {calibPoints.map((p, i) => (
                  <g key={i}>
                    <circle cx={p.x} cy={p.y} r={5} fill={TH.amber} />
                    <line
                      x1={p.x - 8} y1={p.y} x2={p.x + 8} y2={p.y}
                      stroke={TH.amber} strokeWidth={2}
                    />
                    <line
                      x1={p.x} y1={p.y - 8} x2={p.x} y2={p.y + 8}
                      stroke={TH.amber} strokeWidth={2}
                    />
                  </g>
                ))}
                {calibPoints.length === 2 && (
                  <line
                    x1={calibPoints[0].x} y1={calibPoints[0].y}
                    x2={calibPoints[1].x} y2={calibPoints[1].y}
                    stroke={TH.amber} strokeWidth={2} strokeDasharray="6,3"
                  />
                )}
              </svg>
            )}

            {loading && (
              <div style={{
                position: 'absolute', inset: 0, background: '#1a1a2e88',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{ color: TH.muted, fontSize: 14 }}>Loading page…</div>
              </div>
            )}
          </div>
        </div>

        {loadError && (
          <div style={{ padding: 24, color: TH.red, fontSize: 13 }}>{loadError}</div>
        )}

        {/* Double-click hint */}
        {mode === 'draw' && drawPoints.length >= 3 && (
          <div style={{
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            background: TH.card, border: `1px solid ${TH.border}`,
            borderRadius: 8, padding: '8px 16px', fontSize: 12, color: TH.muted,
          }}>
            Double-click to close polygon
          </div>
        )}
      </div>

      {/* ── Right panel: measurements ── */}
      <div style={{
        width: 300, flexShrink: 0, background: TH.card,
        borderLeft: `1px solid ${TH.border}`, display: 'flex',
        flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 18px', borderBottom: `1px solid ${TH.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: TH.text }}>{project.name}</div>
          <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>Blueprint measurements</div>
        </div>

        {/* Scope summary */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px' }}>
          {SCOPE_ITEMS.map(scope => {
            const sqft     = summary[scope.id] || 0
            const myPolys  = polygons.filter(p => p.scope === scope.id)
            return (
              <div key={scope.id} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: scope.color }} />
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{scope.id}</span>
                  </div>
                  <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: sqft > 0 ? TH.text : TH.faint }}>
                    {sqft > 0 ? `${sqft.toLocaleString()} sqft` : '—'}
                  </span>
                </div>
                {myPolys.length > 0 && (
                  <div style={{ paddingLeft: 16 }}>
                    {myPolys.map(poly => (
                      <div key={poly.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
                        <span style={{ fontSize: 11, color: TH.muted }}>
                          Polygon {myPolys.indexOf(poly) + 1} · p{poly.page}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11, color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>{poly.sqft}</span>
                          <button
                            onClick={() => deletePolygon(poly.id)}
                            style={{ fontSize: 10, color: TH.faint, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Total + apply */}
        <div style={{ padding: '14px 18px', borderTop: `1px solid ${TH.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Total</span>
            <span style={{ fontSize: 18, fontWeight: 600, color: TH.amber, fontVariantNumeric: 'tabular-nums' }}>
              {totalSqft > 0 ? `${Math.round(totalSqft).toLocaleString()} sqft` : '—'}
            </span>
          </div>
          <Btn
            onClick={handleApply}
            disabled={totalSqft === 0}
            style={{ width: '100%', background: TH.green, color: '#000', marginBottom: 8 }}
          >
            Apply to Project →
          </Btn>
          <Btn variant="ghost" onClick={onBack} style={{ width: '100%', fontSize: 12 }}>
            ← Back to Project
          </Btn>
        </div>
      </div>
    </div>
  )
}

const btnStyle = {
  width: 26, height: 26, borderRadius: 4, background: 'transparent',
  border: `1px solid ${TH.border}`, color: TH.muted, cursor: 'pointer',
  fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'inherit',
}
