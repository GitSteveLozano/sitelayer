import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Banner, Card, MobileButton, Sheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useCalibratePage, type BlueprintPage } from '@/lib/api'

/**
 * `prj-page-calibration-overlay` — per-page scale calibration UI.
 *
 * Two surfaces:
 *
 *   1. `<CalibrationBanner />` — inline banner the canvas mounts above
 *      the SVG. Shows "Calibrate this page" when missing or
 *      "Calibrated · 1in = 8ft" when set, with a button to (re)open
 *      the overlay.
 *
 *   2. `<PageCalibrationOverlay />` — full-screen sheet that captures
 *      two clicks on the page (board-space 0–100 coords), takes the
 *      real-world distance + unit, and POSTs to
 *      `/api/blueprint-pages/:id/calibrate`.
 *
 * Calibration columns already exist in migration 034 — no new
 * migration needed. Pixel-to-world conversion is computed at render
 * time from `(x1,y1)–(x2,y2)` and `world_distance` so re-opens are
 * deterministic.
 */
export interface CalibrationBannerProps {
  page: BlueprintPage | null
  onClickCalibrate: () => void
}

export function CalibrationBanner({ page, onClickCalibrate }: CalibrationBannerProps) {
  if (!page) return null
  const summary = formatCalibration(page)
  if (summary) {
    return (
      <Banner
        tone="ok"
        title={`Calibrated · ${summary}`}
        action={
          <button type="button" onClick={onClickCalibrate} className="text-[12px] font-semibold text-accent">
            Recalibrate
          </button>
        }
      >
        Quantities on this page use the saved scale.
      </Banner>
    )
  }
  return (
    <Banner
      tone="warn"
      title="This page isn't calibrated"
      action={
        <button type="button" onClick={onClickCalibrate} className="text-[12px] font-semibold text-accent">
          Calibrate
        </button>
      }
    >
      Click two points of known distance to set the scale before measuring.
    </Banner>
  )
}

export interface PageCalibrationOverlayProps {
  open: boolean
  onClose: () => void
  page: BlueprintPage | null
}

type Pt = { x: number; y: number }

export function PageCalibrationOverlay({ open, onClose, page }: PageCalibrationOverlayProps) {
  const calibrate = useCalibratePage()
  const [p1, setP1] = useState<Pt | null>(null)
  const [p2, setP2] = useState<Pt | null>(null)
  const [worldDistance, setWorldDistance] = useState<string>('')
  const [worldUnit, setWorldUnit] = useState<string>('in')
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setP1(null)
    setP2(null)
    setWorldDistance('')
    setWorldUnit('in')
    setError(null)
  }

  const onPick = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const local = pt.matrixTransform(ctm.inverse())
    const next: Pt = { x: clamp(local.x, 0, 100), y: clamp(local.y, 0, 100) }
    if (!p1) setP1(next)
    else if (!p2) setP2(next)
    else {
      // Third tap restarts the pair so users can re-pick without
      // having to back out and re-open the sheet.
      setP1(next)
      setP2(null)
    }
  }

  const submit = async () => {
    if (!page) return
    setError(null)
    if (!p1 || !p2) {
      setError('Pick two points on the page first.')
      return
    }
    const distance = Number(worldDistance)
    if (!Number.isFinite(distance) || distance <= 0) {
      setError('Real-world distance must be a positive number.')
      return
    }
    if (p1.x === p2.x && p1.y === p2.y) {
      setError('Pick two distinct points (the calibration line cannot be zero length).')
      return
    }
    try {
      await calibrate.mutateAsync({
        pageId: page.id,
        world_distance: distance,
        world_unit: worldUnit.trim() || 'in',
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
      })
      reset()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calibration failed')
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Calibrate page scale">
      <div className="space-y-3">
        <div className="text-[12px] text-ink-2 leading-snug">
          Tap two points on the page whose real-world distance you know (a dimension line, the side of a known room).
          We'll save this scale per page so quantities convert correctly.
        </div>

        <div className="relative w-full aspect-square bg-card-soft rounded-md overflow-hidden border border-line">
          <svg
            viewBox="0 0 100 100"
            onPointerDown={onPick}
            className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
          >
            {/* Light grid so taps have a visual anchor */}
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
            {p1 && p2 ? (
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="stroke-accent" strokeWidth={0.3} />
            ) : null}
            {p1 ? <circle cx={p1.x} cy={p1.y} r={1} className="fill-accent" /> : null}
            {p2 ? <circle cx={p2.x} cy={p2.y} r={1} className="fill-accent" /> : null}
          </svg>
        </div>

        <Card tight>
          <div className="grid grid-cols-2 gap-2 text-[11px] text-ink-3">
            <div>
              Point 1: {p1 ? `${p1.x.toFixed(1)}, ${p1.y.toFixed(1)}` : 'tap canvas'}
            </div>
            <div>
              Point 2: {p2 ? `${p2.x.toFixed(1)}, ${p2.y.toFixed(1)}` : 'tap canvas'}
            </div>
          </div>
        </Card>

        <Card tight>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Real distance
              </span>
              <input
                type="number"
                inputMode="decimal"
                value={worldDistance}
                onChange={(e) => setWorldDistance(e.target.value)}
                placeholder="e.g. 12"
                className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent font-mono tabular-nums"
              />
            </label>
            <label className="block">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Unit</span>
              <select
                value={worldUnit}
                onChange={(e) => setWorldUnit(e.target.value)}
                className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
              >
                <option value="in">inches</option>
                <option value="ft">feet</option>
                <option value="cm">centimetres</option>
                <option value="m">metres</option>
                <option value="mm">millimetres</option>
              </select>
            </label>
          </div>
        </Card>

        {error ? <div className="text-[12px] text-bad">{error}</div> : null}

        <div className="grid grid-cols-3 gap-2">
          <MobileButton variant="ghost" onClick={reset} disabled={calibrate.isPending}>
            Reset
          </MobileButton>
          <MobileButton variant="ghost" onClick={onClose} disabled={calibrate.isPending}>
            Cancel
          </MobileButton>
          <MobileButton
            variant="primary"
            onClick={submit}
            disabled={calibrate.isPending || !p1 || !p2 || !worldDistance}
          >
            {calibrate.isPending ? 'Saving…' : 'Save'}
          </MobileButton>
        </div>

        <Attribution source="POST /api/blueprint-pages/:id/calibrate" />
      </div>
    </Sheet>
  )
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Pretty-print a saved calibration as `1in = 8ft` style.
 *
 * The page row only has the raw two-point pair plus a real-world
 * distance. Pixel distance is the Euclidean length of (x1,y1)–(x2,y2)
 * in board-space (0..100). Without an absolute pixel reference we just
 * render the world distance per board-space unit; the canvas uses
 * the full pair when computing measurement quantities.
 */
function formatCalibration(page: BlueprintPage): string | null {
  const distance = page.calibration_world_distance ? Number(page.calibration_world_distance) : NaN
  const unit = page.calibration_world_unit ?? 'in'
  const x1 = page.calibration_x1 ? Number(page.calibration_x1) : NaN
  const y1 = page.calibration_y1 ? Number(page.calibration_y1) : NaN
  const x2 = page.calibration_x2 ? Number(page.calibration_x2) : NaN
  const y2 = page.calibration_y2 ? Number(page.calibration_y2) : NaN
  if (![distance, x1, y1, x2, y2].every(Number.isFinite)) return null
  const span = Math.hypot(x2 - x1, y2 - y1)
  if (!(span > 0)) return null
  // Per-board-unit world distance — gives a stable "scale" string the
  // user can read at a glance even if they don't think in board space.
  const perUnit = distance / span
  return `${distance}${unit} per ${span.toFixed(1)} board-units (≈ ${perUnit.toFixed(2)}${unit}/u)`
}
