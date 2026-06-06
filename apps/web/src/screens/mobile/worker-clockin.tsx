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
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, type BootstrapResponse } from '@/lib/api'
import { MBanner, MBody, MButton, MButtonStack, MStat, MStatStrip, MTopBar } from '../../components/m/index.js'
import { useGeofence, haversineDistanceMeters } from '../../lib/geofence.js'
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

/** Why the worker is punching by hand instead of riding the geofence.
 *  Rides along as a `notes` tag on the manual clock-in so the foreman can
 *  see the provenance of the punch. */
type ManualReason = 'early' | 'no_gps' | 'outside' | 'other'

const MANUAL_REASONS: ReadonlyArray<{ key: ManualReason; label: string }> = [
  { key: 'early', label: 'Early' },
  { key: 'no_gps', label: 'No GPS' },
  { key: 'outside', label: 'Outside' },
  { key: 'other', label: 'Other' },
]

/**
 * Manual clock-in ENTRY form — `wk-clockin` geofence-MISS fallback
 * (`V2WorkerClockInManual`, msg46). The worker reaches here from the
 * off-clock card's "Clock in manually" button when the geofence didn't
 * (or can't) auto-punch them. Unlike the auto-success surface, this is a
 * PRE-punch form: an "AUTO CLOCK-IN MISSED" explainer, a "WHERE ARE YOU?"
 * site picker (bootstrap projects sorted by live GPS distance), and a
 * "WHY MANUAL?" reason grid. The CLOCK IN button writes the punch with an
 * explicit `project_id` + reason note (source stays 'manual'), then lands
 * on the auto-confirm surface.
 */
export function WorkerClockinManual({
  bootstrap,
  companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const geo = useGeofence({ enabled: true })
  const [projectId, setProjectId] = useState<string | null>(null)
  const [reason, setReason] = useState<ManualReason | null>(null)
  const [busy, setBusy] = useState(false)

  // Candidate sites: active projects first, sorted by live distance when a
  // GPS reading is available. Distance is best-effort — without a fix or a
  // site fence we still list the site so a hand-punch is always possible.
  const sites = useMemo(() => {
    const projects = bootstrap?.projects ?? []
    const here = geo.position
    const withDistance = projects.map((p) => {
      const lat = p.site_lat != null ? Number(p.site_lat) : NaN
      const lng = p.site_lng != null ? Number(p.site_lng) : NaN
      const meters =
        here && Number.isFinite(lat) && Number.isFinite(lng)
          ? haversineDistanceMeters({ lat: here.lat, lng: here.lng }, { lat, lng })
          : null
      return {
        id: p.id,
        name: p.name,
        scope: p.division_code || null,
        active: /progress|active/i.test(p.status),
        meters,
      }
    })
    return withDistance.sort((a, b) => {
      if (a.meters != null && b.meters != null) return a.meters - b.meters
      if (a.meters != null) return -1
      if (b.meters != null) return 1
      if (a.active !== b.active) return a.active ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [bootstrap?.projects, geo.position])

  // Default the selection to the nearest / first site so the primary
  // button can read "CLOCK IN · <site>" without a forced extra tap.
  useEffect(() => {
    if (projectId === null && sites.length > 0) setProjectId(sites[0]!.id)
  }, [projectId, sites])

  const selected = sites.find((s) => s.id === projectId) ?? null

  const onClockIn = async () => {
    if (!projectId || busy) return
    setBusy(true)
    try {
      const body: Record<string, unknown> = { project_id: projectId, source: 'manual' }
      if (geo.position) {
        body.lat = geo.position.lat
        body.lng = geo.position.lng
        if (Number.isFinite(geo.position.accuracyMeters)) body.accuracy_m = geo.position.accuracyMeters
      }
      if (reason) body.notes = `manual clock-in · ${reason}`
      const res = await apiPost<{ clockEvent?: unknown }>('/api/clock/in', body, companySlug)
      if (res.clockEvent) navigate('/clockin')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <MTopBar back title="Manual clock-in" onBack={() => navigate('/today')} />
      <MBody>
        <div style={{ padding: '16px 20px 0' }}>
          <MBanner
            tone="attention"
            title="Auto clock-in missed"
            body="GPS still warming up or you're outside the fence. Your foreman reviews this entry."
          />
        </div>

        <div style={{ padding: '20px 20px 8px' }}>
          <div style={ms.sectionLabel}>Where are you?</div>
        </div>
        <div style={{ borderTop: '2px solid var(--m-line)' }}>
          {sites.length === 0 ? (
            <div className="m-quiet-sm" style={{ padding: '16px 20px' }}>
              No sites available to clock in to.
            </div>
          ) : (
            sites.map((s) => {
              const active = s.id === projectId
              const miles = s.meters != null ? `${(s.meters / 1609.34).toFixed(1)} MI` : null
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setProjectId(s.id)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 12,
                    padding: '16px 20px',
                    border: 'none',
                    borderBottom: '2px solid var(--m-line)',
                    background: active ? 'var(--m-accent)' : 'transparent',
                    color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    font: 'inherit',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 16,
                      height: 16,
                      flexShrink: 0,
                      border: `2px solid ${active ? 'var(--m-accent-ink)' : 'var(--m-line)'}`,
                      background: active ? 'var(--m-accent-ink)' : 'transparent',
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        fontFamily: 'var(--m-font-display)',
                        fontWeight: 700,
                        fontSize: 16,
                        textTransform: 'uppercase',
                        letterSpacing: '-0.01em',
                        display: 'block',
                      }}
                    >
                      {s.name}
                    </span>
                    {s.scope ? (
                      <span style={ms.siteSub}>{s.scope}</span>
                    ) : s.active ? (
                      <span style={ms.siteSub}>Active</span>
                    ) : null}
                  </span>
                  {miles ? (
                    <span
                      className="num"
                      style={{
                        fontFamily: 'var(--m-num)',
                        fontWeight: 700,
                        fontSize: 13,
                        letterSpacing: '0.04em',
                      }}
                    >
                      {miles}
                    </span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>

        <div style={{ padding: '20px 20px 8px' }}>
          <div style={ms.sectionLabel}>Why manual?</div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 10,
            padding: '0 20px',
          }}
        >
          {MANUAL_REASONS.map((r) => {
            const active = reason === r.key
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => setReason(active ? null : r.key)}
                className="m-topbar-eyebrow"
                style={{
                  padding: '12px 14px',
                  border: '2px solid var(--m-line)',
                  background: active ? 'var(--m-accent)' : 'transparent',
                  color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                  cursor: 'pointer',
                  textAlign: 'center',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontSize: 12,
                }}
              >
                {r.label}
              </button>
            )
          })}
        </div>

        <div style={{ padding: '20px' }}>
          <MButton variant="primary" data-size="worker" onClick={onClockIn} disabled={busy || !projectId}>
            {busy ? 'Clocking in…' : selected ? `Clock in · ${selected.name}` : 'Clock in'}
          </MButton>
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
  sectionLabel: {
    fontFamily: 'var(--m-num)',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--m-ink-3)',
  },
  siteSub: {
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--m-ink-3)',
    display: 'block',
    marginTop: 3,
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
            <rect
              x="132"
              y="122"
              width="16"
              height="16"
              fill="var(--m-accent)"
              stroke="var(--m-line)"
              strokeWidth="2"
            />
          </>
        )}
        <text x="14" y="206" fontFamily="var(--m-num)" fontSize="9" fill={markerColor} fontWeight="600">
          {offFence ? 'OFF SITE · LOCATION NOT VERIFIED' : 'ON SITE · INSIDE FENCE'}
        </text>
      </svg>
    </div>
  )
}
