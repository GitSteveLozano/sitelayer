import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Centred error-state surface from Sitemap §13 (e.g. "Couldn't load
 * estimate" after a QBO 401). Same shape as EmptyState but the chip
 * uses bad-soft + the alert glyph.
 *
 * Two action slots:
 *   - `retry` — primary, "Try again". Fires the caller's refetch.
 *   - `secondary` — "Open offline copy", "Get help", etc.
 */
export interface ErrorStateProps {
  title: ReactNode
  body?: ReactNode
  retry?: ReactNode
  secondary?: ReactNode
  /** Tertiary action — "Get help" link or similar. Renders as a smaller text button below. */
  tertiary?: ReactNode
  className?: string
}

export function ErrorState({ title, body, retry, secondary, tertiary, className }: ErrorStateProps) {
  return (
    <div className={cn('flex flex-col items-center text-center px-8 py-12', className)}>
      <div
        aria-hidden="true"
        className="w-16 h-16 rounded-[20px] bg-bad-soft text-bad flex items-center justify-center mb-4"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          width="28"
          height="28"
        >
          <path d="M12 3l10 18H2L12 3zM12 10v5M12 18v.01" />
        </svg>
      </div>
      <div className="text-[15px] font-semibold">{title}</div>
      {body ? <p className="text-[13px] text-ink-3 mt-1.5 max-w-[28ch] leading-relaxed">{body}</p> : null}
      {retry || secondary || tertiary ? (
        <div className="mt-5 w-full max-w-[280px] flex flex-col gap-2">
          {retry}
          {secondary}
          {tertiary}
        </div>
      ) : null}
    </div>
  )
}
