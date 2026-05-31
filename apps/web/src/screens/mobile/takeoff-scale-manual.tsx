/**
 * `mb-takeoff-scale-manual` — mobile two-point manual scale calibration.
 *
 * Implements Steve's handoff design `SCALE · A-201 / MANUAL` (msg18). The
 * estimator overrides the AI auto-scale by tapping two points on the sheet and
 * typing the real-world length of that line; the screen derives the scale
 * ratio and writes it through the REAL calibration endpoint
 * (`POST /api/blueprint-pages/:id/calibrate`, via `useCalibratePage`) — the
 * same two-point payload the desktop canvas uses. Until both points are placed
 * the line shows as PROVISIONAL.
 *
 * Reached from the autoscale verify list (a sheet's manual override) and from
 * the ingest manual-fallback. Route:
 *   projects/:projectId/takeoff-ai/scale-manual?page=<pageId>&blueprint=<docId>
 */
import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MButton, MI } from '../../components/m/index.js'
import { useBlueprintPages, useCalibratePage, useProjectBlueprints } from '../../lib/api/takeoff.js'

type Pt = { x: number; y: number }

const WORLD_UNITS = ['FT', 'IN', 'M', 'CM'] as const
type WorldUnit = (typeof WORLD_UNITS)[number]

export function TakeoffScaleManual({ companySlug }: { companySlug: string }) {
  void companySlug
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? ''

  // Resolve the target page. Prefer the explicit ?page; fall back to the first
  // page of the latest blueprint so the screen is exercisable from anywhere.
  const blueprintsQuery = useProjectBlueprints(projectId)
  const docParam = searchParams.get('blueprint')
  const latestDoc =
    (blueprintsQuery.data?.blueprints ?? []).filter((b) => !b.deleted_at).find((b) => b.id === docParam) ??
    (blueprintsQuery.data?.blueprints ?? []).filter((b) => !b.deleted_at).at(-1) ??
    null
  const pagesQuery = useBlueprintPages(latestDoc?.id ?? null)
  const pageParam = searchParams.get('page')
  const page = (pagesQuery.data?.pages ?? []).find((p) => p.id === pageParam) ?? pagesQuery.data?.pages[0] ?? null

  const calibrate = useCalibratePage()

  // Two tapped points in board space (0–100). The active endpoint gets the loupe.
  const [points, setPoints] = useState<Pt[]>([])
  const [length, setLength] = useState('24')
  const [unit, setUnit] = useState<WorldUnit>('FT')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onTap = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const p = svg.createSVGPoint()
    p.x = e.clientX
    p.y = e.clientY
    const local = p.matrixTransform(ctm.inverse())
    const pt = { x: clamp(round2(local.x), 0, 100), y: clamp(round2(local.y), 0, 100) }
    setSaved(false)
    setPoints((prev) => (prev.length >= 2 ? [pt] : [...prev, pt]))
  }

  const complete = points.length === 2
  const worldLen = Number(length) || 0

  // Derived "1 : N" board-to-world scale read-out (mirrors the design's
  // "= 1:48 SCALE" line). Board space is 0–100, so the pixel distance is in
  // board units; the ratio is how many real-world units one board unit spans.
  const scaleRatio = useMemo(() => {
    if (!complete || worldLen <= 0) return null
    const a = points[0]!
    const b = points[1]!
    const boardDist = Math.hypot(b.x - a.x, b.y - a.y)
    if (boardDist <= 0) return null
    return worldLen / boardDist
  }, [complete, worldLen, points])

  const back = () => navigate(`/projects/${projectId}/takeoff-ai/autoscale`)

  const apply = async () => {
    if (!complete || worldLen <= 0 || !page) return
    setError(null)
    try {
      const a = points[0]!
      const b = points[1]!
      await calibrate.mutateAsync({
        pageId: page.id,
        world_distance: worldLen,
        world_unit: unit.toLowerCase(),
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      })
      setSaved(true)
      back()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calibration failed')
    }
  }

  const retap = () => {
    setPoints([])
    setSaved(false)
    setError(null)
  }

  const a = points[0] ?? null
  const b = points[1] ?? null
  const loupe = b ?? a // magnifier sits over the most-recent endpoint

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="m-topbar">
        <button type="button" className="m-topbar-back" aria-label="Close" onClick={back}>
          <MI.X size={20} />
        </button>
        <div className="m-topbar-title">
          <div className="m-topbar-eyebrow">SCALE · {latestDoc?.file_name?.toUpperCase() ?? 'SHEET'}</div>
          <div className="m-h1">MANUAL</div>
        </div>
      </div>

      {/* Canvas — tap two points; loupe over the active endpoint. */}
      <div style={{ flex: 1, background: 'var(--m-card-soft)', position: 'relative', overflow: 'hidden' }}>
        <svg
          viewBox="0 0 100 100"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
          onPointerDown={onTap}
          style={{ position: 'absolute', inset: 0, touchAction: 'none', cursor: 'crosshair' }}
        >
          <defs>
            <pattern id="scale-grid" width="5" height="5" patternUnits="userSpaceOnUse">
              <path d="M 5 0 L 0 0 0 5" stroke="var(--m-ink-3)" strokeWidth="0.15" fill="none" />
            </pattern>
          </defs>
          <rect width="100" height="100" fill="url(#scale-grid)" />

          {/* A reference rectangle so there is something to scale against. */}
          <rect x="12" y="22" width="62" height="42" fill="none" stroke="var(--m-ink)" strokeWidth="0.6" />
          <line x1="43" y1="22" x2="43" y2="64" stroke="var(--m-ink)" strokeWidth="0.6" />

          {/* The two-point measurement line. */}
          {a && b ? <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--m-accent)" strokeWidth="0.8" /> : null}
          {[a, b].map((p, i) =>
            p ? (
              <rect
                key={i}
                x={p.x - 1.2}
                y={p.y - 1.2}
                width={2.4}
                height={2.4}
                fill="var(--m-accent)"
                stroke="var(--m-ink)"
                strokeWidth="0.5"
              />
            ) : null,
          )}

          {/* Loupe / magnifier over the active endpoint. */}
          {loupe ? (
            <g>
              <circle
                cx={loupe.x}
                cy={loupe.y}
                r="9"
                fill="rgba(15,14,12,0.04)"
                stroke="var(--m-ink)"
                strokeWidth="0.8"
              />
              <line
                x1={loupe.x - 9}
                y1={loupe.y}
                x2={loupe.x + 9}
                y2={loupe.y}
                stroke="var(--m-accent)"
                strokeWidth="0.3"
              />
              <line
                x1={loupe.x}
                y1={loupe.y - 9}
                x2={loupe.x}
                y2={loupe.y + 9}
                stroke="var(--m-accent)"
                strokeWidth="0.3"
              />
            </g>
          ) : null}
        </svg>

        {!complete ? (
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              right: 12,
              padding: '8px 12px',
              background: 'var(--m-ink)',
              color: 'var(--m-sand)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.04em',
            }}
          >
            TAP {points.length === 0 ? 'THE FIRST' : 'THE SECOND'} POINT OF A KNOWN-LENGTH LINE
          </div>
        ) : null}
      </div>

      {/* Real-world length entry + derived ratio (ink slab, msg18). */}
      <div
        style={{
          padding: '16px 20px',
          background: 'var(--m-ink)',
          color: 'var(--m-sand)',
          borderTop: '2px solid var(--m-ink)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--m-accent)',
          }}
        >
          REAL-WORLD LENGTH OF THIS LINE
        </div>
        <div
          style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 8 }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={length}
              onChange={(e) => {
                setLength(e.target.value)
                setSaved(false)
              }}
              aria-label="Real-world length"
              style={{
                width: 120,
                background: 'transparent',
                border: 'none',
                borderBottom: '2px solid var(--m-sand)',
                color: 'var(--m-sand)',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 800,
                fontSize: 44,
                lineHeight: 0.95,
                padding: 0,
                outline: 'none',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              {WORLD_UNITS.map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => {
                    setUnit(u)
                    setSaved(false)
                  }}
                  aria-pressed={unit === u}
                  style={{
                    padding: '4px 7px',
                    background: unit === u ? 'var(--m-sand)' : 'transparent',
                    color: unit === u ? 'var(--m-ink)' : 'var(--m-sand)',
                    border: '1.5px solid var(--m-sand)',
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700, color: 'var(--m-ink-4)' }}>
              {scaleRatio ? `= 1:${Math.round(scaleRatio)} SCALE` : '= — SCALE'}
            </div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                marginTop: 4,
                color: 'var(--m-accent)',
              }}
            >
              ● {saved ? 'CALIBRATED' : 'PROVISIONAL'}
            </div>
          </div>
        </div>
        {error ? (
          <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, color: '#fff', marginTop: 8, fontWeight: 600 }}>
            {error}
          </div>
        ) : null}
        {!page && !pagesQuery.isLoading ? (
          <div
            style={{ fontFamily: 'var(--m-num)', fontSize: 10, color: 'var(--m-ink-4)', marginTop: 8, fontWeight: 600 }}
          >
            No blueprint page to calibrate — upload a drawing first.
          </div>
        ) : null}
      </div>

      {/* Re-tap / verify-apply footer. */}
      <div style={{ display: 'flex', gap: 12, padding: '14px 20px 18px', borderTop: '2px solid var(--m-ink)' }}>
        <div style={{ flex: 1 }}>
          <MButton variant="ghost" onClick={retap} disabled={points.length === 0}>
            Re-tap
          </MButton>
        </div>
        <div style={{ flex: 1.4 }}>
          <MButton
            variant="primary"
            onClick={() => void apply()}
            disabled={!complete || worldLen <= 0 || !page || calibrate.isPending}
          >
            {calibrate.isPending ? 'Applying…' : 'Verify · Apply'}
          </MButton>
        </div>
      </div>
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
