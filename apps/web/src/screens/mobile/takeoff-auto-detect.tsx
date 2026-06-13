/**
 * `mb-takeoff-auto-detect` — mobile AI "tap to detect" canvas state.
 *
 * Ported from Steve's v2 master-flow mockup `V2EstCanvasAutoDetect` (MOBILE,
 * "CANVAS · TAP AUTO-DETECT"). Tap a room on the plan → the AI fills it and
 * proposes a square-footage; low-confidence boundaries get a red callout, and
 * an INSIDE/CENTER/OUTSIDE toggle controls which face the area measures to.
 *
 * ⛔ GATED OFF — intentionally UNREACHABLE (2026-06-12, audit M04 #18).
 * There is no single-room "tap to auto-detect a boundary" endpoint anywhere
 * in apps/api: the capture pipeline (POST /api/projects/:id/takeoff-drafts/
 * capture) produces a WHOLE-draft TakeoffResult, not an on-demand per-tap
 * room polygon, and blueprint-pages has no room-segmentation route. Until
 * that endpoint exists this screen is a hardcoded facade (four fixed 820-SF
 * rectangles, literal "A-201 EAST", confirm() just navigates), so its only
 * entry — the canvas toolbar's TAP chip (est-canvas/mobile-panels.tsx
 * MobileToolToolbar) — is rendered disabled ("SOON") and no longer navigates
 * here. The route mount stays so deep links fail soft; do NOT re-enable the
 * entry without building POST /api/projects/:id/takeoff/detect-room
 * { page_id, point:{x,y} } → { polygon, area_sqft, confidence } and wiring
 * confirm() to commit via useCreateMeasurement.
 */
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MButton, MI, Spark } from '../../components/m/index.js'

type Tool = 'POLY' | 'RECT' | 'LIN' | 'PT' | 'TAP'
type MeasureTo = 'INSIDE' | 'CENTER' | 'OUTSIDE'

// Presentational detected rooms (board-space 320×320 to match the mockup).
type DetectedRoom = {
  id: number
  x: number
  y: number
  w: number
  h: number
  sqft: number
  low?: boolean
}

const ROOMS: DetectedRoom[] = [
  { id: 1, x: 33, y: 43, w: 124, h: 94, sqft: 820 },
  { id: 2, x: 163, y: 43, w: 124, h: 94, sqft: 820 },
  { id: 3, x: 33, y: 143, w: 124, h: 94, sqft: 820 },
  { id: 4, x: 163, y: 143, w: 124, h: 94, sqft: 820, low: true },
]

export function TakeoffAutoDetect({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const [tool, setTool] = useState<Tool>('TAP')
  const [measureTo, setMeasureTo] = useState<MeasureTo>('CENTER')
  // The active (just-tapped) room defaults to the low-confidence one so the
  // callout + CONFIRM are visible on first paint.
  const [activeId, setActiveId] = useState<number>(4)
  const active = ROOMS.find((r) => r.id === activeId) ?? null

  const back = () => navigate(`/projects/${projectId}/takeoff-ai`)
  const confirm = () => navigate(`/projects/${projectId}/takeoff-mobile`)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* App bar — back + accent eyebrow + sheet name. */}
      <div className="m-topbar">
        <button type="button" className="m-topbar-back" aria-label="Back" onClick={back}>
          <MI.ChevLeft size={22} />
        </button>
        <div className="m-topbar-title">
          <div className="m-topbar-eyebrow" data-tone="accent" style={{ display: 'inline-flex', gap: 5 }}>
            <Spark size={11} state="strong" /> AI · TAP TO DETECT
          </div>
          <div className="m-h1">A-201 EAST</div>
        </div>
      </div>

      {/* Tool row — POLY / RECT / LIN / PT / TAP (TAP is the AI state). */}
      <div style={{ display: 'flex', borderBottom: '2px solid var(--m-ink)', background: 'var(--m-card-soft)' }}>
        {(['POLY', 'RECT', 'LIN', 'PT', 'TAP'] as const).map((t, i, arr) => {
          const on = tool === t
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTool(t)}
              aria-pressed={on}
              style={{
                flex: 1,
                padding: '14px 0',
                background: on ? 'var(--m-accent)' : 'transparent',
                color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                border: 'none',
                borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: on ? 700 : 600,
                letterSpacing: '0.06em',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          )
        })}
      </div>

      {/* Canvas with detected fills */}
      <div style={{ flex: 1, background: 'var(--m-card-soft)', position: 'relative', overflow: 'hidden' }}>
        <svg
          viewBox="0 0 320 320"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
          style={{ position: 'absolute', inset: 0, touchAction: 'none' }}
        >
          <defs>
            <pattern id="auto-detect-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" stroke="var(--m-ink-3)" strokeWidth="0.5" fill="none" />
            </pattern>
          </defs>
          <rect width="320" height="320" fill="url(#auto-detect-grid)" />

          {/* Floor plan walls */}
          <rect x="30" y="40" width="260" height="200" fill="none" stroke="var(--m-ink)" strokeWidth="3" />
          <line x1="160" y1="40" x2="160" y2="240" stroke="var(--m-ink)" strokeWidth="3" />
          <line x1="30" y1="140" x2="290" y2="140" stroke="var(--m-ink)" strokeWidth="3" />
          {/* Doorway gap */}
          <rect x="155" y="138" width="10" height="4" fill="var(--m-card-soft)" />

          {/* Detected rooms — tap to make active. */}
          {ROOMS.map((r) => {
            const on = r.id === activeId
            return (
              <g key={r.id} onPointerDown={() => setActiveId(r.id)} style={{ cursor: 'pointer' }}>
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill={on && r.low ? 'rgba(199,51,30,0.32)' : 'rgba(217,144,74,0.5)'}
                  stroke={on ? (r.low ? 'var(--m-red)' : 'var(--m-ink)') : 'transparent'}
                  strokeWidth={on ? 2.5 : 0}
                  strokeDasharray={on && r.low ? '4 3' : undefined}
                />
                <text
                  x={r.x + r.w / 2}
                  y={r.y + r.h / 2 + 3}
                  fontFamily="var(--m-num)"
                  fontSize={on && r.low ? 10 : 9}
                  fontWeight="700"
                  textAnchor="middle"
                  fill={on && r.low ? 'var(--m-red)' : 'var(--m-ink)'}
                >
                  {on && r.low ? 'LOW CONF' : `${r.sqft} SF`}
                </text>
              </g>
            )
          })}

          {/* Tap marker on the active room. */}
          {active ? (
            <circle
              cx={active.x + active.w / 2}
              cy={active.y + active.h / 2 - 12}
              r="12"
              fill="var(--m-accent)"
              stroke="var(--m-ink)"
              strokeWidth="3"
            />
          ) : null}
        </svg>

        {/* Low-confidence callout */}
        {active?.low ? (
          <div
            style={{
              position: 'absolute',
              bottom: 14,
              left: 14,
              right: 14,
              padding: '10px 12px',
              background: 'var(--m-ink)',
              color: 'var(--m-sand)',
              border: '2px solid var(--m-ink)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                color: 'var(--m-red)',
                fontWeight: 700,
                letterSpacing: '0.06em',
              }}
            >
              ● LOW CONFIDENCE
            </div>
            <div style={{ fontSize: 12, marginTop: 3 }}>
              Boundary is open near doorway.{' '}
              <span style={{ color: 'var(--m-accent)', fontWeight: 700 }}>Add a cut-line</span> to seal it.
            </div>
          </div>
        ) : null}
      </div>

      {/* Measure-to reference toggle */}
      <div
        style={{
          padding: '10px 20px',
          borderTop: '2px solid var(--m-ink)',
          borderBottom: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div className="m-topbar-eyebrow">MEASURES TO</div>
        <div style={{ display: 'flex', flex: 1, border: '2px solid var(--m-ink)' }}>
          {(['INSIDE', 'CENTER', 'OUTSIDE'] as const).map((t, i, arr) => {
            const on = measureTo === t
            return (
              <button
                key={t}
                type="button"
                onClick={() => setMeasureTo(t)}
                aria-pressed={on}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  background: on ? 'var(--m-accent)' : 'transparent',
                  color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-2)',
                  border: 'none',
                  borderRight: i < arr.length - 1 ? '1.5px solid var(--m-ink)' : 'none',
                  fontFamily: 'var(--m-num)',
                  fontSize: 10,
                  fontWeight: on ? 700 : 600,
                  letterSpacing: '0.04em',
                  cursor: 'pointer',
                }}
              >
                {t}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ padding: '12px 20px 16px' }}>
        <MButton variant="primary" onClick={confirm}>
          {active ? `Confirm Room ${active.id} · ${active.sqft} SF` : 'Tap a room to detect'}
        </MButton>
      </div>
    </div>
  )
}
