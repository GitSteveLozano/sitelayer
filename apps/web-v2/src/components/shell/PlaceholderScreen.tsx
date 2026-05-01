import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Phase-0 placeholder screen. Anchors the IA so navigation works even
 * though no feature is wired. Every screen this replaces will land its
 * real design in Phase 1+.
 */
export interface PlaceholderScreenProps {
  eyebrow: string
  title: string
  /** Reference id from `Sitemap.html` (e.g. "wk-today", "prj-list"). */
  designId?: string
  children?: ReactNode
  className?: string
}

export function PlaceholderScreen({ eyebrow, title, designId, children, className }: PlaceholderScreenProps) {
  return (
    <div className={cn('px-5 pt-8 pb-12 max-w-3xl', className)}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{eyebrow}</div>
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">{title}</h1>
      {designId ? (
        <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-ink-3 font-mono">
          <span className="px-1.5 py-0.5 rounded bg-card-soft border border-line">Mobile.html#a-{designId}</span>
        </div>
      ) : null}
      {children ? <div className="mt-6 text-[14px] text-ink-2">{children}</div> : null}
    </div>
  )
}
