import { cn } from '@/lib/cn'

/**
 * Skeleton loaders. Sitemap §13 shows a stack of muted cards as the
 * loading shape for prj-list — use the same pattern for any list
 * surface during initial fetch.
 *
 * Two surfaces:
 *   - `<Skeleton />` — single bar, custom dimensions for inline shapes.
 *   - `<SkeletonRows count={n} />` — n stacked card-shaped placeholders
 *     matching the Row primitive's geometry (avatar + headline + supporting).
 *
 * Animation is a low-amplitude opacity pulse — the AI Rules ban
 * marketing-y shimmer/streaming animations, but a subtle pulse on
 * skeletons is canon iOS / Android.
 */
export interface SkeletonProps {
  className?: string
  /** Height (h-* class). Defaults to 12px. */
  h?: string
  /** Width (w-* class). Defaults to full. */
  w?: string
  /** Override the default rounded-md. */
  rounded?: string
}

export function Skeleton({ className, h = 'h-3', w = 'w-full', rounded = 'rounded-md' }: SkeletonProps) {
  return <span aria-hidden="true" className={cn('block bg-card-soft animate-pulse', h, w, rounded, className)} />
}

export interface SkeletonRowsProps {
  count?: number
  className?: string
}

export function SkeletonRows({ count = 3, className }: SkeletonRowsProps) {
  return (
    <div role="status" aria-label="Loading" aria-busy="true" className={cn('px-4 space-y-2', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-card border border-line rounded-[12px] px-3.5 py-3 flex items-center gap-3">
          <span aria-hidden="true" className="block w-8 h-8 rounded-lg bg-card-soft animate-pulse" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <Skeleton h="h-3" w="w-2/3" />
            <Skeleton h="h-2.5" w="w-1/2" />
          </div>
          <Skeleton h="h-3" w="w-12" />
        </div>
      ))}
    </div>
  )
}
