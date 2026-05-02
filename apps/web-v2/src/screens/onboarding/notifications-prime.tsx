import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useNotificationPermission } from '@/lib/permissions'

/**
 * `prm-notifications` — Sitemap §1 panel 4 ("Notifications prime").
 *
 * Frame the push ask before the OS dialog appears. Shows four
 * categories with default-on toggles so the user explicitly agrees to
 * the kinds of pings they'll get rather than a binary "allow / deny"
 * choice. Tapping "Allow notifications" triggers the real native
 * prompt; categories the user toggled off are remembered locally so
 * future emit code can suppress them client-side.
 *
 * Reachable at /permissions/notifications?next=/some/path.
 */
export const NOTIF_PREFS_KEY = 'sitelayer.v2.notif-prefs'

const CATEGORIES: ReadonlyArray<{
  id: 'assignment' | 'schedule' | 'approval' | 'tips'
  title: string
  detail: string
  icon: 'cal' | 'warn' | 'bell' | 'spark'
  defaultOn: boolean
}> = [
  {
    id: 'assignment',
    title: "Tomorrow's assignment",
    detail: 'At 5 PM the day before',
    icon: 'cal',
    defaultOn: true,
  },
  {
    id: 'schedule',
    title: 'Schedule changes',
    detail: 'If your day changes day-of',
    icon: 'warn',
    defaultOn: true,
  },
  {
    id: 'approval',
    title: 'Approval requests',
    detail: 'Time + logs that need review',
    icon: 'bell',
    defaultOn: true,
  },
  {
    id: 'tips',
    title: 'Tips & feature drops',
    detail: 'Once a month, if at all',
    icon: 'spark',
    defaultOn: false,
  },
]

export function NotificationsPrimeScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next') ?? '/'
  const { state, request } = useNotificationPermission()
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return Object.fromEntries(CATEGORIES.map((c) => [c.id, c.defaultOn]))
    try {
      const raw = window.localStorage.getItem(NOTIF_PREFS_KEY)
      if (raw) return { ...Object.fromEntries(CATEGORIES.map((c) => [c.id, c.defaultOn])), ...JSON.parse(raw) }
    } catch {
      // Fall back to defaults on any parse error.
    }
    return Object.fromEntries(CATEGORIES.map((c) => [c.id, c.defaultOn]))
  })
  const [busy, setBusy] = useState(false)

  const toggle = (id: string) => setPrefs((p) => ({ ...p, [id]: !p[id] }))

  const onAllow = async () => {
    setBusy(true)
    try {
      window.localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(prefs))
      await request()
    } finally {
      setBusy(false)
      navigate(next, { replace: true })
    }
  }

  const onSkip = () => {
    window.localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(prefs))
    navigate(next, { replace: true })
  }

  return (
    <div className="min-h-dvh flex flex-col bg-paper text-ink">
      <div className="px-5 pt-[calc(env(safe-area-inset-top,0px)+24px)] pb-2 flex items-center gap-3">
        <button type="button" onClick={onSkip} className="text-[14px] text-ink-3 font-medium" aria-label="Back">
          ‹
        </button>
        <span className="text-[13px] text-ink-2 font-medium">Stay in the loop</span>
      </div>

      <div className="px-5 pt-4">
        <h1 className="font-display text-[26px] font-bold tracking-tight leading-tight">
          Get notified when work changes.
        </h1>
        <p className="text-[13px] text-ink-3 mt-2 max-w-[36ch] leading-relaxed">
          We'll only ping you for things you'd want to interrupt your day.
        </p>
      </div>

      <ul className="px-4 pt-4 space-y-2">
        {CATEGORIES.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => toggle(c.id)}
              className="w-full flex items-center gap-3 px-4 py-3 bg-card rounded-[12px] border border-line text-left active:bg-card-soft"
            >
              <CategoryIcon kind={c.icon} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold leading-tight">{c.title}</div>
                <div className="text-[11px] text-ink-3 mt-0.5">{c.detail}</div>
              </div>
              <Toggle on={prefs[c.id] ?? false} />
            </button>
          </li>
        ))}
      </ul>

      <div className="flex-1" />

      <div className="px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-3">
        {state === 'denied' ? (
          <div className="text-[12px] text-bad text-center mb-2">
            Notifications are blocked at the OS level. Re-enable in Settings → Notifications.
          </div>
        ) : null}
        <button
          type="button"
          onClick={onAllow}
          disabled={busy || state === 'unsupported' || state === 'denied'}
          className="w-full h-[52px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center disabled:opacity-50"
        >
          {busy ? 'Asking…' : 'Allow notifications'}
        </button>
        <button type="button" onClick={onSkip} className="block w-full text-[12px] text-ink-3 font-medium py-2 mt-1">
          Maybe later
        </button>
      </div>
    </div>
  )
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex w-9 h-5 rounded-full p-0.5 shrink-0 transition-colors ${
        on ? 'bg-good' : 'bg-card-soft border border-line'
      }`}
    >
      <span
        className={`block w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-4' : ''}`}
      />
    </span>
  )
}

function CategoryIcon({ kind }: { kind: 'cal' | 'warn' | 'bell' | 'spark' }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    width: 18,
    height: 18,
    'aria-hidden': true,
  }
  if (kind === 'cal')
    return (
      <span className="w-9 h-9 rounded-md bg-accent-soft text-accent-ink flex items-center justify-center shrink-0">
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v4M16 3v4" />
        </svg>
      </span>
    )
  if (kind === 'warn')
    return (
      <span className="w-9 h-9 rounded-md bg-warn-soft text-warn flex items-center justify-center shrink-0">
        <svg {...common}>
          <path d="M12 3l10 18H2L12 3z" />
          <path d="M12 10v5M12 18v.01" />
        </svg>
      </span>
    )
  if (kind === 'bell')
    return (
      <span className="w-9 h-9 rounded-md bg-accent-soft text-accent-ink flex items-center justify-center shrink-0">
        <svg {...common}>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9z" />
          <path d="M10 21a2 2 0 0 0 4 0" />
        </svg>
      </span>
    )
  return (
    <span className="w-9 h-9 rounded-md bg-card-soft text-ink-2 flex items-center justify-center shrink-0">
      <svg {...common}>
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3" />
      </svg>
    </span>
  )
}
