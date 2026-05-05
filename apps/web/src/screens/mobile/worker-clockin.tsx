/**
 * Auto clock-in confirmation screen — `wk-clockin`. Shows after a successful
 * geofence-triggered clock-in. The override window is 2 minutes; per the
 * design handoff this is the most-important worker surface (the value prop).
 *
 * The map preview is intentionally simple — just the geofence circle with
 * a pulsing dot. Real implementations can layer a static map tile from a
 * provider; for now a CSS gradient + SVG dot is enough.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MButtonStack, MI, MTopBar } from '../../components/m/index.js'
import { timeOfDay } from './format.js'

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
        <div style={{ position: 'relative' }}>
          <MapPreview />
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              padding: '4px 10px',
              borderRadius: 999,
              background: 'rgba(0,0,0,0.55)',
              color: '#f3ecdf',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            You're on site
          </div>
        </div>
        <div style={{ padding: '24px 24px 8px', textAlign: 'center' }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: '0 auto 18px',
              borderRadius: 28,
              background: 'rgba(44, 138, 85, 0.15)',
              color: 'var(--m-green)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MI.Check size={28} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>You're clocked in</div>
          <div className="m-quiet-sm" style={{ marginTop: 6 }}>
            Walked into the geofence at <strong style={{ color: 'var(--m-accent-ink)' }}>{timeOfDay(punchedAt)}</strong>{' '}
            · auto-clocked.
          </div>
        </div>
        <div style={{ padding: '0 16px' }}>
          <MButtonStack>
            <MButton variant="primary" onClick={() => navigate('/scope')}>
              See today's scope
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/today')}>
              Wrong project? Tap to fix · {secondsLeft}s
            </MButton>
          </MButtonStack>
          <div className="m-quiet-sm" style={{ textAlign: 'center', marginTop: 12 }}>
            Closes automatically in {secondsLeft} seconds.
          </div>
        </div>
      </MBody>
    </>
  )
}

function MapPreview() {
  return (
    <div
      style={{
        height: 180,
        background:
          'radial-gradient(circle at 50% 60%, rgba(217,144,74,0.15), transparent 50%), linear-gradient(180deg, #221c14 0%, #1a1610 100%)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <svg width="100%" height="100%" viewBox="0 0 360 180" style={{ position: 'absolute', inset: 0 }}>
        <circle cx="180" cy="100" r="56" fill="none" stroke="rgba(217,144,74,0.5)" strokeDasharray="4 6" />
        <circle cx="180" cy="100" r="8" fill="var(--m-accent)" />
        <circle cx="180" cy="100" r="14" fill="none" stroke="rgba(217,144,74,0.5)">
          <animate attributeName="r" values="8;22;8" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0;0.7" dur="2.4s" repeatCount="indefinite" />
        </circle>
      </svg>
    </div>
  )
}
