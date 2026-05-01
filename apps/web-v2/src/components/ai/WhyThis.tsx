import type { ReactNode } from 'react'
import { Spark } from './Spark'
import { cn } from '@/lib/cn'

/**
 * Phase-0 shell of the "Why this?" overlay.
 *
 * Final content lands in Phase 5 — this primitive locks the shape
 * (eyebrow + title + body + footer attribution) so screens built in
 * Phase 1/2/3 can wire a `<WhyThis/>` slot today.
 */
export interface WhyThisProps {
  title: string
  attribution: string
  className?: string
  children?: ReactNode
}

export function WhyThis({ title, attribution, className, children }: WhyThisProps) {
  return (
    <div
      className={cn(
        'bg-paper border border-line rounded-[14px] px-6 py-5 flex flex-col gap-3',
        className,
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-ink flex items-center gap-1.5">
        <Spark state="strong" size={12} aria-label="" />
        Why this?
      </div>
      <h3 className="text-base font-semibold tracking-tight text-ink">{title}</h3>
      {children ? <div className="text-[13px] text-ink-2 leading-relaxed">{children}</div> : null}
      <div className="text-[11px] text-ink-3 mt-1">{attribution}</div>
    </div>
  )
}
