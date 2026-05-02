import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Avatar } from '@/components/mobile'
import { useOnlineStatus } from '@/lib/offline/online-status'
import { useRole, type Role } from '@/lib/role'
import { cn } from '@/lib/cn'
import { NAV_GROUPS, type NavItem } from './nav-items'

/**
 * Slide-out navigation drawer from `Sitemap.html` § 02 panel 3.
 *
 * Layout:
 *   - Avatar header — name, role, "Synced · X" status. Tapping opens
 *     the project switcher (panel 4) via `onAvatarTap`.
 *   - Grouped nav rows from `nav-items.ts` (primary / workflow /
 *     workspace / you).
 *
 * Triggered from the overflow `⋯` in `TopAppBar`. Slides from the left
 * on mobile and is full-height; click-outside / ESC dismisses.
 */
export interface NavDrawerProps {
  open: boolean
  onClose: () => void
  /** Tap-target on the avatar header — typically opens the project switcher sheet. */
  onAvatarTap?: () => void
  /**
   * Display name + role. We don't pull `useUser()` from Clerk here so
   * the drawer also works in the no-Clerk dev path; the parent passes
   * the resolved name in.
   */
  displayName?: string
  /** Subline under the name, e.g. "Owner · Sitelayer Co". */
  subline?: string
  initials?: string
}

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  foreman: 'Foreman',
  worker: 'Worker',
}

export function NavDrawer({
  open,
  onClose,
  onAvatarTap,
  displayName,
  subline,
  initials,
}: NavDrawerProps) {
  const role = useRole()
  const online = useOnlineStatus()
  const sheetRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const lastPath = useRef(location.pathname)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    sheetRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Close on route change so navigating from the drawer doesn't leave
  // the overlay covering the destination screen.
  useEffect(() => {
    if (open && location.pathname !== lastPath.current) {
      onClose()
    }
    lastPath.current = location.pathname
  }, [location.pathname, open, onClose])

  if (!open) return null

  const resolvedName = displayName ?? 'Signed-in user'
  const resolvedSubline = subline ?? `${ROLE_LABEL[role]} · Sitelayer`
  const resolvedInitials =
    initials ??
    (resolvedName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('') ||
      'SL')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
      className="fixed inset-0 z-40 flex bg-black/45"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={sheetRef}
        tabIndex={-1}
        className={cn(
          'w-[300px] max-w-[88vw] h-full bg-bg flex flex-col outline-none',
          'shadow-[6px_0_24px_rgba(0,0,0,0.18)]',
          'pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-[calc(env(safe-area-inset-bottom,0px)+12px)]',
        )}
      >
        {/* Avatar header — taps open the project switcher (Panel 4). */}
        <button
          type="button"
          onClick={onAvatarTap}
          className={cn(
            'mx-3 mb-3 px-3 py-3 rounded-[16px] text-left',
            'flex items-center gap-3',
            'bg-card-soft active:bg-line/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
          disabled={!onAvatarTap}
        >
          <Avatar size="lg" tone="amber" initials={resolvedInitials} />
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold tracking-tight truncate">{resolvedName}</div>
            <div className="text-[11px] text-ink-3 truncate mt-0.5">{resolvedSubline}</div>
            <div className="mt-1.5 inline-flex items-center gap-1.5 text-[11px]">
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block w-1.5 h-1.5 rounded-full',
                  online ? 'bg-good' : 'bg-warn',
                )}
              />
              <span className={online ? 'text-good' : 'text-warn'}>
                {online ? 'Synced' : 'Offline · queued'}
              </span>
            </div>
          </div>
          {onAvatarTap ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="16"
              height="16"
              className="text-ink-4 shrink-0"
              aria-hidden="true"
            >
              <path d="M7 10l5 5 5-5" />
            </svg>
          ) : null}
        </button>

        <nav aria-label="Drawer" className="flex-1 min-h-0 overflow-y-auto px-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.key} className={group.title ? 'mt-3' : ''}>
              {group.title ? (
                <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                  {group.title}
                </div>
              ) : null}
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <li key={item.key}>
                    <DrawerRow item={item} onClose={onClose} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </div>
  )
}

function DrawerRow({ item, onClose }: { item: NavItem; onClose: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onClose}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-3 py-2.5 rounded-md text-[14px] font-medium',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          isActive ? 'bg-accent-soft text-accent-ink' : 'text-ink-2 hover:text-ink hover:bg-card-soft',
        )
      }
    >
      <item.icon width={18} height={18} strokeWidth={1.8} aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate">{item.label}</span>
      {item.detail ? <span className="text-[11px] text-ink-3 truncate">{item.detail}</span> : null}
      {item.badge !== undefined ? (
        <span className="num inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-accent text-white text-[10px] font-semibold">
          {item.badge}
        </span>
      ) : null}
    </NavLink>
  )
}
