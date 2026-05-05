import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * `MLargeHead` from `mobile-primitives.jsx` — iOS large title.
 *
 * Spec from `.m-largehead`:
 *   - padding 6/20/18, border-bottom line.
 *   - title 30/700 -0.02em line-1.05.
 *   - sub 14 ink-3 (mt-1).
 *   - optional `right` slot aligned to flex-end.
 */
export interface LargeHeadProps {
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
  className?: string
}

export function LargeHead({ title, sub, right, className }: LargeHeadProps) {
  return (
    <div className={cn('px-5 pt-1.5 pb-4 border-b border-line', className)}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-[30px] font-bold tracking-[-0.02em] leading-[1.05]">{title}</div>
          {sub ? <div className="text-[14px] text-ink-3 mt-1">{sub}</div> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
    </div>
  )
}
