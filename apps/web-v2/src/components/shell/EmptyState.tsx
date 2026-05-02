import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Centred empty-state surface from Sitemap §13. Used when a list /
 * collection has zero rows and the user hasn't filtered them away —
 * this is the "haven't started yet" message, not the "no matches" one.
 *
 * Spec: large rounded illustration chip (accent-soft / accent-ink)
 * over a 13/600 title + 12 ink-3 body, then 1–2 buttons stacked.
 *
 * Pair with `EmptyState.icon` slot for a domain-specific illustration
 * (folder for projects, ruler for takeoff, etc.) — falls back to a
 * generic empty-folder mark when omitted.
 */
export interface EmptyStateProps {
  title: ReactNode
  body?: ReactNode
  icon?: ReactNode
  primaryAction?: ReactNode
  secondaryAction?: ReactNode
  className?: string
}

export function EmptyState({ title, body, icon, primaryAction, secondaryAction, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center text-center px-8 py-12', className)}>
      <div
        aria-hidden="true"
        className="w-16 h-16 rounded-[20px] bg-accent-soft text-accent-ink flex items-center justify-center mb-4"
      >
        {icon ?? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="28" height="28">
            <path d="M3 7l9-4 9 4-9 4-9-4z" />
            <path d="M3 7v10l9 4 9-4V7" />
            <path d="M12 11v10" />
          </svg>
        )}
      </div>
      <div className="text-[15px] font-semibold">{title}</div>
      {body ? <p className="text-[13px] text-ink-3 mt-1.5 max-w-[28ch]">{body}</p> : null}
      {primaryAction || secondaryAction ? (
        <div className="mt-5 w-full max-w-[280px] flex flex-col gap-2">
          {primaryAction}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  )
}
