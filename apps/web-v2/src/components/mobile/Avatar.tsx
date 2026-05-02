import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * `MAvatar` + `MAvatarGroup` from `mobile-primitives.jsx`.
 *
 * Spec from `.m-avatar`:
 *   - md (default) 32×32, radius 50%, font 12/600.
 *   - sm 24×24, font 10. lg 44×44, font 14.
 *   - tones: 1=accent (default), 2=blue, 3=green, 4=red, 5=amber.
 *
 * `AvatarGroup` overlaps -8px and rings each non-first avatar with a
 * 2px border in the page bg color so the stack reads cleanly on any
 * surface.
 */
export type AvatarSize = 'sm' | 'md' | 'lg'
export type AvatarTone = 'accent' | 'blue' | 'green' | 'red' | 'amber'

const SIZE: Record<AvatarSize, string> = {
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-[12px]',
  lg: 'w-11 h-11 text-[14px]',
}

const TONE: Record<AvatarTone, string> = {
  accent: 'bg-accent-soft text-accent-ink',
  blue: 'bg-info-soft text-info',
  green: 'bg-good-soft text-good',
  red: 'bg-bad-soft text-bad',
  amber: 'bg-warn-soft text-warn',
}

export interface AvatarProps {
  initials?: string
  size?: AvatarSize
  tone?: AvatarTone
  ring?: boolean
  className?: string
  children?: ReactNode
}

export function Avatar({ initials, size = 'md', tone = 'accent', ring, className, children }: AvatarProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full font-semibold shrink-0',
        SIZE[size],
        TONE[tone],
        ring ? 'ring-2 ring-bg' : '',
        className,
      )}
    >
      {children ?? initials}
    </span>
  )
}

export interface AvatarGroupProps {
  /** Each item becomes one Avatar; tones cycle through the 5-color palette. */
  items: Array<{ initials: string; tone?: AvatarTone }>
  size?: AvatarSize
  /** Cap; remaining items render as a "+N" chip. */
  max?: number
  className?: string
}

const TONE_CYCLE: AvatarTone[] = ['accent', 'blue', 'green', 'red', 'amber']

export function AvatarGroup({ items, size = 'sm', max = 4, className }: AvatarGroupProps) {
  const shown = items.slice(0, max)
  const rest = items.length - shown.length
  return (
    <div className={cn('inline-flex', className)}>
      {shown.map((it, i) => (
        <span key={i} className={cn(i === 0 ? '' : '-ml-2')}>
          <Avatar
            initials={it.initials}
            size={size}
            tone={it.tone ?? TONE_CYCLE[i % TONE_CYCLE.length] ?? 'accent'}
            ring={i > 0}
          />
        </span>
      ))}
      {rest > 0 ? (
        <span className="-ml-2">
          <Avatar size={size} tone="accent" ring>
            +{rest}
          </Avatar>
        </span>
      ) : null}
    </div>
  )
}
