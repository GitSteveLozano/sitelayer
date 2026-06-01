import { useEffect, useState } from 'react'
import { request } from '@/lib/api/client'

/**
 * Persistent "viewing as X" banner (design §7). Whenever the current session is
 * acting on behalf of someone else — a prod Clerk actor-token impersonation
 * (`mode: 'impersonate'`) or the dev act-as override (`mode: 'act_as'`) — this
 * shows a sticky red strip naming the subject and the real actor, so the
 * operator can never forget they aren't looking at their own account.
 *
 * Reads /api/session (which now surfaces `mode` + `impersonated_by`). Renders
 * nothing for a normal self session. Mounted inside AppShell so it's on every
 * screen, mirroring OfflineBanner.
 */

interface SessionInfo {
  mode?: string
  impersonated_by?: string | null
  user?: { id?: string }
}

export function ImpersonationBanner() {
  const [info, setInfo] = useState<SessionInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    request<SessionInfo>('/api/session')
      .then((data) => {
        if (!cancelled) setInfo(data)
      })
      .catch(() => {
        // No session / not signed in — no banner.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!info || (info.mode !== 'impersonate' && info.mode !== 'act_as')) return null

  const subject = info.user?.id ?? 'this user'
  const actor = info.impersonated_by ?? 'an admin'
  const devSuffix = info.mode === 'act_as' ? ' · dev act-as' : ''

  return (
    <div
      className="sticky top-0 z-40 px-5 py-3 flex items-center gap-3"
      style={{
        background: 'var(--m-red)',
        color: '#fff',
        borderBottom: '2px solid var(--m-ink)',
        fontFamily: 'var(--m-num)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
      role="status"
      aria-live="polite"
      data-testid="impersonation-banner"
      data-mode={info.mode}
    >
      <span className="shrink-0" style={{ width: 14, height: 14, background: '#fff' }} aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate">
        Viewing as {subject} — impersonated by {actor}
        {devSuffix}
      </span>
    </div>
  )
}
