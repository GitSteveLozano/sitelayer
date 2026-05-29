/**
 * Clock-in confirmation screens — `wk-clockin`. Two surfaces live here:
 *
 *   1. `WorkerClockinConfirm` (auto) — shown after a successful
 *      geofence-triggered clock-in. The override window is 2 minutes; per
 *      the design handoff this is the most-important worker surface (the
 *      value prop). Mirrors Steve's v2 `V2WorkerClockInSuccess`.
 *   2. `WorkerClockinManual` — the geofence-MISS fallback
 *      (`V2WorkerClockInManual`). When the worker is off the auto path
 *      (no fence, fence off, or a denied/poor GPS read) they punch in by
 *      hand; this surface confirms the manual punch with the same
 *      brutalist framing but a "MANUAL" mode and an off-fence map state,
 *      and is honest that the location wasn't auto-verified.
 *
 * View layer mirrors the v2 brutalist worker screens: eyebrow + big
 * headline, a geofence map SVG (grid + dashed fence + marker), a 3-stat
 * strip, and a gloved primary button. The shell applies `.m-dark` for
 * workers, so all colors come from `var(--m-*)` tokens — no hardcoded
 * dark values.
 *
 * The map preview is intentionally simple — just the geofence fence with a
 * pulsing dot over a construction-site grid. Real implementations can layer a
 * static map tile from a provider; for now an SVG sketch is enough.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBanner, MBody, MButton, MButtonStack, MStat, MStatStrip, MTopBar } from '../../components/m/index.js'
import { timeOfDay } from './format.js'

/** Detect the OS-level reduced-motion preference; SMIL animations can't
 *  be paused via the CSS `prefers-reduced-motion` rule, so we gate the
 *  SVG <animate> nodes in JS instead. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mql.matches)
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return reduced
}

export function WorkerClockinConfirm() {
  const navigate = useNavigate()
  const [secondsLeft, setSecondsLeft] = useState(120)
  const punchedAt = useState(new Date().toISOString())[0]

  useEffect(() => {
    const id = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          navigate('/today')
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [navigate])

  return (
    <>
      <MTopBar back title="Clocked in" onBack={() => navigate('/today')} />
      <MBody>
        <div style={{ padding: '24px 20px 0' }}>
          <div style={ms.eyebrow}>You're on site</div>
          <div style={ms.bignum}>
            Clocked
            <br />
            in.
          </div>
        </div>

        <GeofenceMap />

        <MStatStrip>
          <MStat label="Punched" value={timeOfDay(punchedAt)} />
          <MStat label="Mode" value="AUTO" />
          <MStat label="Fence" value="ON SITE" />
        </MStatStrip>

        <div className="m-quiet-sm" style={{ padding: '14px 20px 0' }}>
          Walked into the geofence at <strong style={{ color: 'var(--m-accent-ink)' }}>{timeOfDay(punchedAt)}</strong> ·
          auto-clocked.
        </div>

        <div style={{ padding: '20px' }}>
          <MButtonStack>
            <MButton variant="primary" data-size="worker" onClick={() => navigate('/scope')}>
              See today's scope
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/today')}>
              Wrong project? Tap to fix · {secondsLeft}s
            </MButton>
          </MButtonStack>
          <div style={ms.micro}>Closes automatically in {secondsLeft} seconds.</div>
        </div>
      </MBody>
    </>
  )
}

/**
 * Manual clock-in confirmation — `wk-clockin` geofence-MISS fallback
 * (`V2WorkerClockInManual`). The worker reached here by punching in by
 * hand (no fence configured, geofence switched off, or a denied / poor
 * GPS read), so we can't claim "on site". The framing matches the auto
 * success screen — eyebrow + big headline + map + stat strip + gloved
 * primary — but the mode is MANUAL, the map shows the off-fence state,
 * and a banner is honest that the punch wasn't location-verified.
 *
 * The punch itself already landed server-side in `wk-today`'s
 * `handlePunch('in')` before navigation; this screen is the confirmation
 * surface, not the writer. There is no auto-dismiss timer here — a
 * manual punch warrants a deliberate "got it" rather than a countdown.
 */
export function WorkerClockinManual() {
  const navigate = useNavigate()
  const punchedAt = useState(new Date().toISOString())[0]

  return (
    <>
      <MTopBar back title="Clocked in" onBack={() => navigate('/today')} />
      <MBody>
        <div style={{ padding: '24px 20px 0' }}>
          <div style={{ ...ms.eyebrow, color: 'var(--m-ink-3)' }}>Manual punch</div>
          <div style={ms.bignum}>
            Clocked
            <br />
            in.
          </div>
        </div>

        <GeofenceMap offFence />

        <MStatStrip>
          <MStat label="Punched" value={timeOfDay(punchedAt)} />
          <MStat label="Mode" value="MANUAL" />
          <MStat label="Fence" value="OFF" />
        </MStatStrip>

        <div style={{ padding: '14px 20px 0' }}>
          <MBanner
            tone="warn"
            title="Location not auto-verified"
            body="You punched in by hand — we couldn't confirm you're inside the site geofence. Your foreman sees this as a manual punch."
          />
        </div>

        <div style={{ padding: '20px' }}>
          <MButtonStack>
            <MButton variant="primary" data-size="worker" onClick={() => navigate('/scope')}>
              See today's scope
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/today')}>
              Wrong project? Tap to fix
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

const ms: Record<string, CSSProperties> = {
  eyebrow: {
    fontFamily: 'var(--m-num)',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--m-accent)',
  },
  bignum: {
    fontFamily: 'var(--m-font-display)',
    fontSize: 72,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 0.9,
    marginTop: 14,
    color: 'var(--m-ink)',
  },
  micro: {
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    textAlign: 'center',
    color: 'var(--m-ink-4)',
    marginTop: 12,
  },
}

/** Geofence sketch — construction-site grid with a dashed fence and a
 *  pulsing on-site marker. Brutalist v2 framing: hard 2px border, no radius.
 *
 *  `offFence` renders the geofence-miss state for the manual fallback: the
 *  marker sits OUTSIDE the dashed fence in a muted tone, the pulse is gone,
 *  and the legend reads "OFF SITE · LOCATION NOT VERIFIED". */
function GeofenceMap({ offFence = false }: { offFence?: boolean }) {
  const reducedMotion = usePrefersReducedMotion()
  const markerColor = offFence ? 'var(--m-ink-3)' : 'var(--m-accent)'
  return (
    <div
      style={{
        margin: '24px 20px',
        height: 220,
        border: '2px solid var(--m-line)',
        background: 'var(--m-card-soft)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <svg viewBox="0 0 280 220" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="wk-clockin-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" stroke="var(--m-line-2)" strokeWidth="0.5" fill="none" />
          </pattern>
        </defs>
        <rect width="280" height="220" fill="url(#wk-clockin-grid)" />
        <path d="M0 100 L280 80" stroke="var(--m-line-2)" strokeWidth="14" />
        <path d="M180 0 L165 220" stroke="var(--m-line-2)" strokeWidth="10" />
        <rect x="50" y="120" width="50" height="40" fill="var(--m-line-2)" stroke="var(--m-ink-3)" strokeWidth="1" />
        <rect x="200" y="100" width="46" height="40" fill="var(--m-line-2)" stroke="var(--m-ink-3)" strokeWidth="1" />
        <rect
          x="90"
          y="80"
          width="100"
          height="100"
          fill="none"
          stroke={offFence ? 'var(--m-line)' : 'var(--m-accent)'}
          strokeWidth="2"
          strokeDasharray="4 4"
        />
        {offFence ? (
          /* Off-fence: a muted marker parked outside the fence — no pulse,
             signalling the punch wasn't location-verified. */
          <rect x="232" y="42" width="16" height="16" fill={markerColor} stroke="var(--m-line)" strokeWidth="2" />
        ) : (
          <>
            <circle cx="140" cy="130" r="28" fill="var(--m-accent)" opacity="0.25">
              {reducedMotion ? null : (
                <>
                  <animate attributeName="r" values="20;30;20" dur="2.4s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.3;0.1;0.3" dur="2.4s" repeatCount="indefinite" />
                </>
              )}
            </circle>
            <rect x="132" y="122" width="16" height="16" fill="var(--m-accent)" stroke="var(--m-line)" strokeWidth="2" />
          </>
        )}
        <text x="14" y="206" fontFamily="var(--m-num)" fontSize="9" fill={markerColor} fontWeight="600">
          {offFence ? 'OFF SITE · LOCATION NOT VERIFIED' : 'ON SITE · INSIDE FENCE'}
        </text>
      </svg>
    </div>
  )
}
