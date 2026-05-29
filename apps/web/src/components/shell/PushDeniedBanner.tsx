import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'

/**
 * Sticky banner shown when push has been denied at the OS level.
 * The Settings → Notifications page already explains how to re-grant,
 * but field users won't necessarily wander there. This banner shows
 * once after denial and links straight to the page that documents the
 * recovery path. Dismissed-state persists for 7 days.
 *
 * v2 brutalist (aligned to V2StatePermDenied): hard 2px ink borders,
 * square accent status block, mono UPPERCASE labels, square "Fix" /
 * "Hide" actions. All colors are `--m-*` tokens so the worker dark
 * theme inverts it cleanly.
 */
const DISMISS_KEY = 'sitelayer.v2.push-denied-dismissed-at'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function PushDeniedBanner() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'denied') return
    const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0)
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return
    setShow(true)
  }, [])

  if (!show) return null

  return (
    <div
      className="flex items-center gap-3"
      style={{
        padding: '12px 20px',
        background: 'var(--m-card-soft)',
        borderTop: '2px solid var(--m-ink)',
        borderBottom: '2px solid var(--m-ink)',
      }}
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        style={{ width: 14, height: 14, background: 'var(--m-accent)', border: '2px solid var(--m-ink)', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink)',
          }}
        >
          Notifications blocked
        </div>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.03em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
            marginTop: 3,
          }}
        >
          No clock-in or approval pings
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => {
            window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
            setShow(false)
          }}
          style={{
            background: 'transparent',
            border: '1.5px solid var(--m-ink)',
            color: 'var(--m-ink)',
            borderRadius: 0,
            padding: '5px 10px',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Hide
        </button>
        <Link
          to="/more"
          style={{
            background: 'var(--m-accent)',
            border: '1.5px solid var(--m-ink)',
            color: 'var(--m-accent-ink)',
            padding: '5px 12px',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            textDecoration: 'none',
          }}
        >
          Fix
        </Link>
      </div>
    </div>
  )
}
