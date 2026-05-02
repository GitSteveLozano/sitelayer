import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Top app bar from `Sitemap.html` § 02 panel 2.
 *
 * Pattern: optional back chevron, title (with optional eyebrow), and a
 * right-aligned actions slot. The two canonical right-side actions are
 * **search** and **overflow**, but the slot is open so screens can drop
 * in custom buttons (e.g. an avatar that opens the drawer).
 *
 * Mounts inside the screen content (not in `AppShell`) because Home and
 * a handful of other surfaces use the `LargeHead` "Today" header
 * instead of a top bar — see Panel 1.
 */
export interface TopAppBarProps {
  title: ReactNode
  eyebrow?: ReactNode
  /** Show `←` back chevron. Defaults to history-back; pass `backTo` to override. */
  showBack?: boolean
  backTo?: string
  onBack?: () => void
  /** Convenience search action — renders a 🔍 button. */
  onSearch?: () => void
  /** Convenience overflow action — renders a `⋯` button. */
  onOverflow?: () => void
  /** Open slot for custom right-side actions (rendered before search/overflow). */
  actions?: ReactNode
  className?: string
}

export function TopAppBar({
  title,
  eyebrow,
  showBack,
  backTo,
  onBack,
  onSearch,
  onOverflow,
  actions,
  className,
}: TopAppBarProps) {
  const navigate = useNavigate()
  const handleBack = () => {
    if (onBack) return onBack()
    if (backTo) return navigate(backTo)
    navigate(-1)
  }

  return (
    <header
      className={cn(
        'sticky top-0 z-20 bg-bg/95 backdrop-blur',
        'border-b border-line',
        'pt-[calc(env(safe-area-inset-top,0px))]',
        className,
      )}
    >
      <div className="h-12 px-2 flex items-center gap-1">
        {showBack ? (
          <button
            type="button"
            onClick={handleBack}
            aria-label="Back"
            className="w-10 h-10 inline-flex items-center justify-center rounded-full text-ink hover:bg-card-soft active:bg-card-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="22"
              height="22"
              aria-hidden="true"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
        ) : (
          <span className="w-2" aria-hidden="true" />
        )}

        <div className="flex-1 min-w-0 px-1">
          {eyebrow ? (
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 leading-tight truncate">
              {eyebrow}
            </div>
          ) : null}
          <div className="text-[16px] font-semibold tracking-tight leading-tight truncate">{title}</div>
        </div>

        <div className="flex items-center">
          {actions}
          {onSearch ? (
            <button
              type="button"
              onClick={onSearch}
              aria-label="Search"
              className="w-10 h-10 inline-flex items-center justify-center rounded-full text-ink hover:bg-card-soft active:bg-card-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="20"
                height="20"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
            </button>
          ) : null}
          {onOverflow ? (
            <button
              type="button"
              onClick={onOverflow}
              aria-label="More options"
              className="w-10 h-10 inline-flex items-center justify-center rounded-full text-ink hover:bg-card-soft active:bg-card-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                width="20"
                height="20"
                aria-hidden="true"
              >
                <circle cx="5" cy="12" r="1.7" />
                <circle cx="12" cy="12" r="1.7" />
                <circle cx="19" cy="12" r="1.7" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  )
}
