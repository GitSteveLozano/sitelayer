import { useEffect, useRef, useState, useCallback } from 'react'
import { TH } from '../lib/theme'
import { Btn, Card, Label } from './Atoms'

// ─── PDF.js worker setup ─────────────────────────────────────────────────────
import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// ─── Scope items — synced from L&A QBO service items ─────────────────────────
// Covers D1-Stucco, D2-Masonry, D4-EIFS, D5-Paper & Wire divisions
// unit: sqft = area polygon | lf = linear feet polygon
export const SCOPE_ITEMS = [
  { id: 'EPS',             color: '#f59e0b', unit: 'sqft', defaultRate: 4.00,  div: 'EIFS'          },
  { id: 'Basecoat',        color: '#fb923c', unit: 'sqft', defaultRate: 2.50,  div: 'EIFS'          },
  { id: 'Finish Coat',     color: '#fbbf24', unit: 'sqft', defaultRate: 3.50,  div: 'EIFS/Stucco'   },
  { id: 'Cultured Stone',  color: '#8b5cf6', unit: 'sqft', defaultRate: 12.00, div: 'Masonry'       },
  { id: 'Air Barrier',     color: '#3b82f6', unit: 'sqft', defaultRate: 1.80,  div: 'Paper & Wire'  },
  { id: 'Cementboard',     color: '#06b6d4', unit: 'sqft', defaultRate: 3.25,  div: 'Siding'        },
  { id: 'Envelope Seal',   color: '#22c55e', unit: 'sqft', defaultRate: 2.00,  div: 'Paper & Wire'  },
  { id: 'Caulking',        color: '#ec4899', unit: 'lf',   defaultRate: 4.50,  div: 'All'           },
  { id: 'Flashing',        color: '#f43f5e', unit: 'lf',   defaultRate: 8.00,  div: 'All'           },
]

const DIVISIONS = [...new Set(SCOPE_ITEMS.map(s => s.div))]

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

export function BlueprintCanvas({ project, blueprintUrl, onMeasurementsApplied, onBack, rates = {} }) {
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
  const [divOverrides,  setDivOverrides]  = useState(project.metadata?.div_overrides || {})

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

  const getDivision = (scopeId) => divOverrides[scopeId] || SCOPE_ITEMS.find(s => s.id === scopeId)?.div || 'All'

  // ── Summary: sqft by scope ───────────────────────────────────────────────────
  const summary = polygons.reduce((acc, poly) => {
    acc[poly.scope] = (acc[poly.scope] || 0) + poly.sqft
    return acc
  }, {})

  const totalSqft = Object.values(summary).reduce((s, v) => s + v, 0)

  // ── Estimate line items ──────────────────────────────────────────────────────
  const estimate = SCOPE_ITEMS
    .filter(s => summary[s.id] > 0)
    .map(s => {
      const qty      = summary[s.id] || 0
      const rate     = rates[s.id] ?? s.defaultRate
      const amount   = Math.round(qty * rate * 100) / 100
      return { item: s.id, qty: Math.round(qty * 10) / 10, unit: s.unit, rate, amount }
    })
  const subtotal = estimate.reduce((s, l) => s + l.amount, 0)
  const gst      = Math.round(subtotal * 0.05 * 100) / 100
  const total    = subtotal + gst

  function handleApply() {
    onMeasurementsApplied?.({ summary, totalSqft, polygonCount: polygons.length, estimate, subtotal, gst, total, divOverrides })
  }

  // ── Render helpers ───────────────────────────────────────────────────────────
  const svgPolygons = polygons.filter(p => p.page === pageNum)
  const scopeColor  = SCOPE_ITEMS.find(s => s.id === activeScope)?.color || TH.amber

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 80px)', gap: 0, overflow: 'hidden' }}>

      {/* ── Left panel: canvas ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#1a1a2e' }}>

        {/* Toolbar — fixed above scroll area */}
        <div style={{
          flexShrink: 0, zIndex: 10,
          background: TH.card, borderBottom: `1px solid ${TH.border}`,
          padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
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
                padding: '5px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit',
                background: mode === m.id ? TH.amber : TH.surf,
                color:      mode === m.id ? '#000'   : m.disabled ? TH.faint : TH.text,
                border:     `1px solid ${mode === m.id ? TH.amber : TH.border}`,
                cursor:     m.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {m.icon} {m.label}
            </button>
          ))}

          <div style={{ width: 1, height: 20, background: TH.border }} />

          {/* Scope pills */}
          {SCOPE_ITEMS.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveScope(s.id)}
              style={{
                padding: '4px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'inherit',
                background: activeScope === s.id ? s.color + '33' : 'transparent',
                color:      activeScope === s.id ? s.color : TH.muted,
                border:     `1px solid ${activeScope === s.id ? s.color : TH.border}`,
                cursor:     'pointer',
              }}
            >
              {s.id}
            </button>
          ))}

          <div style={{ flex: 1 }} />

          {/* Zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setZoom(z => Math.max(0.3, z - 0.1))} style={{ ...btnStyle }}>−</button>
            <span style={{ fontSize: 11, color: TH.muted, width: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(3, z + 0.1))} style={{ ...btnStyle }}>+</button>
          </div>

          {/* Page nav */}
          {numPages > 1 && (
            <>
              <div style={{ width: 1, height: 20, background: TH.border }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={() => setPageNum(p => Math.max(1, p - 1))} disabled={pageNum === 1} style={{ ...btnStyle }}>‹</button>
                <span style={{ fontSize: 11, color: TH.muted }}>Page {pageNum} / {numPages}</span>
                <button onClick={() => setPageNum(p => Math.min(numPages, p + 1))} disabled={pageNum === numPages} style={{ ...btnStyle }}>›</button>
              </div>
            </>
          )}
        </div>

        {/* Scrollable canvas area */}
        <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>

        {/* Calibration input bar */}
        {mode === 'calibrate' && calibPoints.length === 2 && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 9,
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
        <div style={{ padding: 24 }}>
          <div style={{ width: canvasSize.w * zoom, height: canvasSize.h * zoom }}>
            <div
              style={{
                position: 'relative',
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
                cursor: mode === 'pan' ? 'grab' : 'crosshair',
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
        </div>{/* end scrollable area */}
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

        {/* Scope selector + measurements */}
        <div style={{ overflowY: 'auto', padding: '12px 18px', borderBottom: `1px solid ${TH.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: TH.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Scope
          </div>
          {SCOPE_ITEMS.map(scope => {
            const isActive = activeScope === scope.id
            const qty     = summary[scope.id] || 0
            const myPolys = polygons.filter(p => p.scope === scope.id)
            const div = getDivision(scope.id)
            return (
              <div key={scope.id} style={{ marginBottom: 8 }}>
                <div
                  onClick={() => setActiveScope(scope.id)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    marginBottom: 3, padding: '4px 6px', borderRadius: 5, cursor: 'pointer',
                    background: isActive ? scope.color + '18' : 'transparent',
                    border: `1px solid ${isActive ? scope.color + '55' : 'transparent'}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 9, height: 9, borderRadius: 2, background: scope.color }} />
                    <span style={{ fontSize: 12, fontWeight: isActive ? 600 : 500, color: isActive ? scope.color : TH.text }}>{scope.id}</span>
                    <select
                      value={div}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setDivOverrides(prev => ({ ...prev, [scope.id]: e.target.value }))}
                      style={{
                        padding: '1px 2px', borderRadius: 3, fontSize: 9, fontFamily: 'inherit',
                        background: 'transparent', color: TH.faint,
                        border: `1px solid ${TH.border}55`, cursor: 'pointer',
                      }}
                    >
                      {DIVISIONS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: qty > 0 ? TH.text : TH.faint }}>
                    {qty > 0 ? `${qty.toLocaleString()} ${scope.unit}` : '—'}
                  </span>
                </div>
                {myPolys.map(poly => (
                  <div key={poly.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0 2px 16px' }}>
                    <span style={{ fontSize: 10, color: TH.muted }}>Zone {myPolys.indexOf(poly) + 1} · p{poly.page}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontSize: 10, color: TH.muted }}>{poly.sqft}</span>
                      <button onClick={() => deletePolygon(poly.id)}
                        style={{ fontSize: 10, color: TH.faint, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>

        {/* Estimate preview */}
        <div style={{ overflowY: 'auto', padding: '12px 18px', flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: TH.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Estimate Preview
          </div>
          {estimate.length === 0 ? (
            <div style={{ fontSize: 12, color: TH.faint }}>Draw zones to generate estimate</div>
          ) : (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${TH.border}` }}>
                    <th style={{ textAlign: 'left', color: TH.muted, fontWeight: 600, padding: '4px 0', fontSize: 10 }}>Item</th>
                    <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '4px 0', fontSize: 10 }}>Qty</th>
                    <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '4px 0', fontSize: 10 }}>Rate</th>
                    <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '4px 0', fontSize: 10 }}>Amt</th>
                  </tr>
                </thead>
                <tbody>
                  {estimate.map(line => (
                    <tr key={line.item} style={{ borderBottom: `1px solid ${TH.border}22` }}>
                      <td style={{ padding: '5px 0', color: TH.text }}>{line.item}</td>
                      <td style={{ textAlign: 'right', padding: '5px 0', color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                        {line.qty.toLocaleString()} {line.unit}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 0', color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                        ${line.rate.toFixed(2)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 0', fontVariantNumeric: 'tabular-nums', color: TH.amber }}>
                        ${line.amount.toLocaleString('en', { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 10, borderTop: `1px solid ${TH.border}`, paddingTop: 8 }}>
                {[
                  { label: 'Subtotal', value: subtotal },
                  { label: 'GST (5%)', value: gst },
                ].map(r => (
                  <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                    <span style={{ color: TH.muted }}>{r.label}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: TH.muted }}>
                      ${r.value.toLocaleString('en', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, marginTop: 6 }}>
                  <span>Scope Total</span>
                  <span style={{ color: TH.amber, fontVariantNumeric: 'tabular-nums' }}>
                    ${total.toLocaleString('en', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              {/* Bid vs Scope comparison */}
              {project.bid_psf > 0 && totalSqft > 0 && (() => {
                const bidTotal = Math.round(totalSqft * project.bid_psf * 100) / 100
                const diff = bidTotal - subtotal
                const isOver = diff < 0
                return (
                  <div style={{
                    marginTop: 10, padding: '8px 10px', borderRadius: 5,
                    background: isOver ? (TH.redLo || '#fee2e222') : (TH.greenLo || '#dcfce722'),
                    border: `1px solid ${isOver ? TH.red + '44' : TH.green + '44'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: TH.muted }}>Bid ({`$${project.bid_psf}/sqft`})</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', color: TH.muted }}>
                        ${bidTotal.toLocaleString('en', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                      <span style={{ color: isOver ? TH.red : TH.green, fontWeight: 600 }}>
                        {isOver ? 'Over bid by' : 'Under bid by'}
                      </span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', color: isOver ? TH.red : TH.green, fontWeight: 600 }}>
                        ${Math.abs(diff).toLocaleString('en', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>
                )
              })()}
            </>
          )}
        </div>

        {/* Apply + back */}
        <div style={{ padding: '14px 18px', borderTop: `1px solid ${TH.border}` }}>
          <Btn
            onClick={handleApply}
            disabled={totalSqft === 0}
            style={{ width: '100%', background: TH.green, color: '#000', marginBottom: 8 }}
          >
            Generate Estimate →
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
