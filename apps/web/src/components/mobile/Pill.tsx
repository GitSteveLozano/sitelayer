import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type PillTone = 'default' | 'accent' | 'good' | 'bad' | 'warn' | 'info'

const TONES: Record<PillTone, string> = {
  default: 'bg-card-soft text-ink-2',
  accent: 'bg-accent-soft text-accent-ink',
  good: 'bg-good-soft text-good',
  bad: 'bg-bad-soft text-bad',
  warn: 'bg-warn-soft text-warn',
  info: 'bg-info-soft text-info',
}

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone
  /** Show a small filled dot before the label (status indicator). */
  withDot?: boolean
  children: ReactNode
}

export function Pill({ tone = 'default', withDot, className, children, ...rest }: PillProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {withDot ? <span className="w-[5px] h-[5px] rounded-full bg-current shrink-0" aria-hidden="true" /> : null}
      {children}
    </span>
  )
}
