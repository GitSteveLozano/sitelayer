import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * `MSectionH` from `mobile-primitives.jsx` — uppercase section header
 * with an optional accent action link on the right.
 *
 * Spec from `.m-section-h`:
 *   - 11/600 ink-3 uppercase tracking 0.06em.
 *   - padding 18/20/8 (cuts the visual gap between section header and
 *     the rows that follow it).
 *   - link slot: 13/500 accent, normal-case, no tracking.
 */
export interface SectionHProps {
  children: ReactNode
  link?: ReactNode
  onLinkClick?: () => void
  className?: string
}

export function SectionH({ children, link, onLinkClick, className }: SectionHProps) {
  return (
    <div className={cn('px-5 pt-[18px] pb-2', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{children}</span>
        {link ? (
          <button
            type="button"
            onClick={onLinkClick}
            className="text-[13px] font-medium text-accent normal-case tracking-normal"
          >
            {link}
          </button>
        ) : null}
      </div>
    </div>
  )
}
