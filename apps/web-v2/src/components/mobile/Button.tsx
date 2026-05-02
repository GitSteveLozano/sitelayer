import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Mobile button — matches `.m-btn` variants from the design system
 * (mobile-tokens.css). Tactile, large hit-area, never use on dense
 * desktop tables.
 *
 * `destructive` mirrors iOS' convention: solid red fill + white text,
 * used for irreversible commits (delete, void, post-to-QBO with no
 * undo). Pair with `<ConfirmSheet destructive />`.
 */
export type ButtonVariant = 'primary' | 'ink' | 'ghost' | 'quiet' | 'destructive'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white border-transparent active:opacity-90',
  ink: 'bg-ink text-white border-transparent active:opacity-90',
  ghost: 'bg-transparent text-ink border-line-2 active:bg-card-soft',
  quiet: 'bg-card-soft text-ink border-transparent active:bg-line',
  destructive: 'bg-bad text-white border-transparent active:opacity-90',
}

export interface MobileButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
  /** Full-width — default is true on mobile to reach the 44px tap target. */
  fullWidth?: boolean
  /** Smaller secondary action; reduces padding + font. */
  size?: 'md' | 'sm'
  children: ReactNode
}

export function MobileButton({
  variant = 'primary',
  fullWidth = true,
  size = 'md',
  type = 'button',
  className,
  children,
  ...rest
}: MobileButtonProps) {
  // Mobile spec from mobile-tokens.css `.m-btn`: 50px tall md (full
  // width), 36px tall sm. Padding 0/20 md, 0/14 sm. Radius 14/10.
  const sizeClass = size === 'sm' ? 'h-9 px-3.5 text-sm rounded-[10px]' : 'h-[50px] px-5 text-base rounded-[14px]'
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-semibold border',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        sizeClass,
        fullWidth && size === 'md' ? 'w-full' : '',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
