import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'

/**
 * Sticky banner shown when push has been denied at the OS level.
 * The Settings → Notifications page already explains how to re-grant,
 * but field users won't necessarily wander there. This banner shows
 * once after denial and links straight to the page that documents the
 * recovery path. Dismissed-state persists for 7 days.
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
    <div className="flex items-center justify-between gap-2 px-4 py-2 bg-warn-soft border-b border-line text-[12px]">
      <div className="text-ink-2">Notifications are blocked — you won't get clock-in or approval pings.</div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => {
            window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
            setShow(false)
          }}
          className="text-ink-3 px-2 py-1"
        >
          Hide
        </button>
        <Link to="/more" className="text-accent font-semibold px-2 py-1">
          Fix
        </Link>
      </div>
    </div>
  )
}
