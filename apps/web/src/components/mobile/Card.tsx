import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Mobile card primitive — matches `.pmb-card` from the design.
 * Use as the base container for any standalone block on a phone screen.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tight?: boolean
  /** Render the accent treatment (used by AI-flavoured surfaces). */
  active?: boolean
  children: ReactNode
}

export function Card({ className, tight, active, children, ...rest }: CardProps) {
  return (
    <div
      data-active={active ? 'true' : undefined}
      className={cn(
        'bg-card rounded border border-line',
        tight ? 'px-3.5 py-3' : 'px-4 py-3.5',
        active && 'border-accent shadow-card',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
