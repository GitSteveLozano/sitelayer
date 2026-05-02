import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * `MBanner` from `mobile-primitives.jsx` — inline alert / status banner.
 *
 * Spec from `.m-banner`:
 *   - margin 10/16, padding 12/14, radius 12 (--m-r).
 *   - border 1px tone-soft-30, bg tone-soft.
 *   - icon (color = tone), title 13/600, body 12 ink-2 (mt-0.5).
 *   - optional action slot on the right.
 *
 * Default tone = warn (amber). Use `info`/`error`/`ok` per design.
 */
export type BannerTone = 'warn' | 'info' | 'error' | 'ok'

const TONE_BG: Record<BannerTone, string> = {
  warn: 'bg-warn-soft border-warn/30',
  info: 'bg-info-soft border-info/30',
  error: 'bg-bad-soft border-bad/30',
  ok: 'bg-good-soft border-good/30',
}

const TONE_ICON: Record<BannerTone, string> = {
  warn: 'text-warn',
  info: 'text-info',
  error: 'text-bad',
  ok: 'text-good',
}

const DEFAULT_ICONS: Record<BannerTone, ReactNode> = {
  warn: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      width="18"
      height="18"
    >
      <path d="M12 3l10 18H2L12 3zM12 10v5M12 18v.01" />
    </svg>
  ),
  error: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      width="18"
      height="18"
    >
      <path d="M12 3l10 18H2L12 3zM12 10v5M12 18v.01" />
    </svg>
  ),
  info: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      width="18"
      height="18"
    >
      <path d="M6 16V11a6 6 0 1112 0v5l1.5 2.5h-15L6 16zM10 21h4" />
    </svg>
  ),
  ok: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="18"
      height="18"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  ),
}

export interface BannerProps {
  tone?: BannerTone
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  /** Override the default tone icon. */
  icon?: ReactNode
  className?: string
}

export function Banner({ tone = 'warn', title, children, action, icon, className }: BannerProps) {
  return (
    <div
      role="status"
      className={cn('mx-4 my-2.5 px-3.5 py-3 rounded-[12px] border flex items-start gap-2.5', TONE_BG[tone], className)}
    >
      <span className={cn('shrink-0 mt-0.5', TONE_ICON[tone])} aria-hidden="true">
        {icon ?? DEFAULT_ICONS[tone]}
      </span>
      <div className="flex-1 min-w-0">
        {title ? <div className="text-[13px] font-semibold leading-snug">{title}</div> : null}
        {children ? <div className="text-[12px] text-ink-2 leading-snug mt-0.5">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
