/**
 * Estimator desktop · AI Auto-Count (Desktop v2 · ported from Steve's mockup
 * `DAICountSetup` + `DAICountReview` in /tmp/steve3/04_app.js).
 *
 * Two route-able screens:
 *   - EstAiCountSetup — pick a clicked symbol, sensitivity, and the mech sheets
 *     to scan, then run the AI symbol count. Float palette over a faint
 *     blueprint backdrop.
 *   - EstAiCountReview — canvas with the AI-overlaid count markers + a
 *     keyboard-driven review panel (J/K navigate · Y keep · N reject). Low-
 *     confidence detections are flagged red; APPROVE keeps the clean set.
 *
 * Same gap as est-ai-queue.tsx / est-ai-takeoff.tsx: no company-wide AI-count
 * feed hook yet, so the mockup's demo detections stay presentational. Run /
 * approve are local-state handlers with a TODO for the capture pipeline.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DEyebrow } from '@/components/d'
import { MButton, MPill } from '@/components/m'

type Sensitivity = 'STRICT' | 'NORMAL' | 'LOOSE'

const label: React.CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

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

function CountBackdrop({ children }: { children?: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--m-ink-2)', overflow: 'hidden' }}>
      <svg
        viewBox="0 0 1208 836"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: 'absolute', inset: 0, opacity: 0.4 }}
        aria-hidden="true"
      >
        <defs>
          <pattern id="ai-count-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" stroke="var(--m-ink-3)" strokeWidth="0.5" fill="none" />
          </pattern>
        </defs>
        <rect width="1208" height="836" fill="url(#ai-count-grid)" />
        {children}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EstAiCountSetup — symbol + sensitivity + sheet scope + RUN.
// ---------------------------------------------------------------------------
export function EstAiCountSetup() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  const sheets = ['M-101', 'M-102', 'M-103', 'M-104']
  const [sensitivity, setSensitivity] = useState<Sensitivity>('NORMAL')
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sheets.map((s) => [s, true])),
  )
  const [running, setRunning] = useState(false)

  const toggleSheet = (sheet: string) => {
    setSelected((prev) => ({ ...prev, [sheet]: !prev[sheet] }))
  }
  const selectedCount = sheets.filter((s) => selected[s]).length

  const runCount = () => {
    setRunning(true)
    // No capture pipeline run yet — jump to the count review lane.
    navigate(projectId ? `/desktop/ai-count/${projectId}/review` : '/desktop/ai-queue')
  }

  return (
    <div className="d-content-full" style={{ position: 'relative' }}>
      <CountBackdrop>
        <circle cx="500" cy="400" r="16" fill="var(--m-accent)" stroke="var(--m-ink)" strokeWidth="3" />
      </CountBackdrop>

      <div
        style={{
          position: 'absolute',
          top: 24,
          right: 24,
          width: 300,
          background: 'var(--m-card)',
          border: '2px solid var(--m-ink)',
          boxShadow: '6px 6px 0 var(--m-ink)',
        }}
      >
        <div style={floatHead}>● AI · Count a symbol</div>
        <div style={{ padding: 18 }}>
          <div style={{ ...label, fontWeight: 600 }}>Clicked · A-104 sheet</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <span
              style={{
                width: 44,
                height: 44,
                background: 'var(--m-accent)',
                border: '2px solid var(--m-ink)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 18,
              }}
              aria-hidden
            >
              ◯
            </span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Diffuser · 24" round</span>
          </div>

          <div style={{ ...label, marginTop: 18 }}>Sensitivity</div>
          <div style={{ display: 'flex', border: '2px solid var(--m-ink)', marginTop: 8 }}>
            {(['STRICT', 'NORMAL', 'LOOSE'] as const).map((s, i, arr) => {
              const on = sensitivity === s
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSensitivity(s)}
                  aria-pressed={on}
                  style={{
                    flex: 1,
                    padding: '10px 0',
                    background: on ? 'var(--m-accent)' : 'transparent',
                    color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                    border: 'none',
                    borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {s}
                </button>
              )
            })}
          </div>

          <div style={{ ...label, marginTop: 18 }}>Scan · {selectedCount} mech sheets</div>
          <div style={{ marginTop: 8 }}>
            {sheets.map((s) => {
              const on = Boolean(selected[s])
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSheet(s)}
                  aria-pressed={on}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 0',
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      background: on ? 'var(--m-accent)' : 'transparent',
                      border: '2px solid var(--m-ink)',
                    }}
                    aria-hidden
                  />
                  <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 600 }}>{s}</span>
                </button>
              )
            })}
          </div>

          <div style={{ marginTop: 18 }}>
            <MButton variant="primary" onClick={runCount} disabled={running || selectedCount === 0}>
              {running ? 'Starting…' : 'Run · ~30s'}
            </MButton>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EstAiCountReview — canvas markers + keyboard review panel.
// ---------------------------------------------------------------------------
type CountStatus = 'ok' | 'review' | 'flag'

type CountDetection = {
  id: string
  confidence: 'HIGH' | 'MED' | 'LOW'
  status: CountStatus
}

const DETECTIONS: CountDetection[] = [
  { id: 'D-118', confidence: 'HIGH', status: 'ok' },
  { id: 'D-119', confidence: 'HIGH', status: 'ok' },
  { id: 'D-201', confidence: 'LOW', status: 'flag' },
  { id: 'D-202', confidence: 'MED', status: 'review' },
  { id: 'D-203', confidence: 'LOW', status: 'flag' },
]

// Marker positions in the review canvas (x, y, low?) — verbatim from mockup.
const MARKERS: Array<[number, number, boolean]> = [
  [180, 240, false],
  [340, 240, false],
  [500, 240, false],
  [660, 240, false],
  [180, 440, false],
  [340, 440, false],
  [500, 440, false],
  [180, 600, true],
  [660, 600, true],
]

function statusBg(status: CountStatus): string {
  return status === 'flag' ? 'var(--m-red)' : status === 'review' ? 'var(--m-accent)' : 'var(--m-green)'
}

export function EstAiCountReview() {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''

  // Demo detections stay presentational. // TODO: back with the real count
  // result + promote via .../:draftId/promote.
  const dets = useMemo<CountDetection[]>(() => DETECTIONS, [])
  const [active, setActive] = useState(0)
  const [approving, setApproving] = useState(false)

  const total = 214
  const flagged = dets.filter((d) => d.status !== 'ok').length
  const kept = total - flagged

  const approve = () => {
    setApproving(true)
    navigate(projectId ? `/desktop/estimate/${projectId}` : '/desktop/ai-queue')
  }

  return (
    <div className="d-content-full" style={{ position: 'relative' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', height: '100%' }}>
        {/* Canvas with overlaid count markers */}
        <div
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: 'var(--m-card-soft)',
            borderRight: '2px solid var(--m-ink)',
          }}
        >
          <svg
            viewBox="0 0 900 836"
            width="100%"
            height="100%"
            preserveAspectRatio="xMidYMid slice"
            style={{ position: 'absolute', inset: 0 }}
            aria-hidden="true"
          >
            <defs>
              <pattern id="ai-count-review-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" stroke="var(--m-ink-3)" strokeWidth="0.5" fill="none" />
              </pattern>
            </defs>
            <rect width="900" height="836" fill="url(#ai-count-review-grid)" />
            <rect x="80" y="120" width="740" height="560" fill="none" stroke="var(--m-ink)" strokeWidth="3" />
            {MARKERS.map(([x, y, low], i) => (
              <g key={i}>
                <circle
                  cx={x}
                  cy={y}
                  r="18"
                  fill={low ? 'var(--m-red)' : 'var(--m-accent)'}
                  stroke="var(--m-ink)"
                  strokeWidth="3"
                />
                {low ? (
                  <text
                    x={x}
                    y={y + 5}
                    fontFamily="var(--m-num)"
                    fontSize="16"
                    fontWeight="800"
                    textAnchor="middle"
                    fill="#fff"
                  >
                    ?
                  </text>
                ) : null}
              </g>
            ))}
          </svg>
        </div>

        {/* Keyboard review panel */}
        <div style={{ overflowY: 'auto', background: 'var(--m-card)' }}>
          <div style={{ padding: 20, borderBottom: '2px solid var(--m-ink)' }}>
            <DEyebrow>AI · {total} found</DEyebrow>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 36, marginTop: 6 }}>
              {kept} <span style={{ fontSize: 16, color: 'var(--m-green)' }}>kept</span>
            </div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                color: 'var(--m-ink-2)',
                marginTop: 6,
                fontWeight: 600,
              }}
            >
              {flagged} LOW-CONF FLAGGED
            </div>
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--m-ink)',
                color: 'var(--m-accent)',
                marginTop: 14,
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.04em',
              }}
            >
              J/K NAVIGATE · Y KEEP · N REJECT
            </div>
          </div>
          {dets.map((d, i) => {
            const on = i === active
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setActive(i)}
                aria-pressed={on}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '14px 20px',
                  borderBottom: '1px solid var(--m-line-2)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background: on ? 'var(--m-accent)' : 'transparent',
                  border: 'none',
                  borderTop: 'none',
                  cursor: 'pointer',
                }}
              >
                <span style={{ width: 8, height: 8, background: statusBg(d.status) }} aria-hidden />
                <span style={{ flex: 1, fontFamily: 'var(--m-num)', fontSize: 12, fontWeight: 700 }}>{d.id}</span>
                <MPill tone={d.confidence === 'HIGH' ? 'green' : d.confidence === 'MED' ? 'amber' : 'red'}>
                  {d.confidence}
                </MPill>
              </button>
            )
          })}
          <div style={{ padding: '16px 20px' }}>
            <MButton variant="primary" onClick={approve} disabled={approving}>
              {approving ? 'Approving…' : `Approve ${kept} clean`}
            </MButton>
          </div>
        </div>
      </div>
    </div>
  )
}
