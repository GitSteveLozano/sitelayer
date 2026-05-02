import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * `MQA` from `mobile-primitives.jsx` — quick-action grid button.
 *
 * Spec from `.m-qa`:
 *   - flex column, gap 6, padding 12/4, bg card-soft, radius 12.
 *   - icon chip 36×36, radius 10, bg card + line border, color accent.
 *   - label 11/500 line-1.2, centered.
 *
 * Compose in `<QuickActionGrid>` (4-up) for the home dashboards.
 */
export interface QuickActionProps {
  icon: ReactNode
  label: ReactNode
  onClick?: () => void
  className?: string
}

export function QuickAction({ icon, label, onClick, className }: QuickActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-1.5 px-1 py-3 bg-card-soft rounded-[12px] text-ink active:opacity-80',
        className,
      )}
    >
      <span className="inline-flex items-center justify-center w-9 h-9 rounded-[10px] bg-card border border-line text-accent shrink-0">
        {icon}
      </span>
      <span className="text-[11px] font-medium leading-tight text-center">{label}</span>
    </button>
  )
}

export interface QuickActionGridProps {
  children: ReactNode
  columns?: 3 | 4
  className?: string
}

export function QuickActionGrid({ children, columns = 4, className }: QuickActionGridProps) {
  return (
    <div className={cn('grid gap-2 px-4', columns === 3 ? 'grid-cols-3' : 'grid-cols-4', className)}>{children}</div>
  )
}
