import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * `MRow` from `mobile-primitives.jsx` — the workhorse list-row primitive.
 *
 * Spec from `.m-list-row` in mobile-tokens.css:
 *   - min-height 52px, padding 12/14, gap 12, border-bottom line.
 *   - leading 32×32 radius-8 chip with optional tone.
 *   - headline 15/500, supporting 12 ink-3 (mt-2px).
 *   - trailing 13 ink-3 with chev (14px ink-4) when tappable.
 *
 * Tap surface is the entire row — never put inner buttons inside.
 */
export type RowLeadingTone = 'default' | 'accent' | 'green' | 'red' | 'amber' | 'blue'

const LEADING_TONES: Record<RowLeadingTone, string> = {
  default: 'bg-card-soft text-ink-2',
  accent: 'bg-accent-soft text-accent',
  green: 'bg-good-soft text-good',
  red: 'bg-bad-soft text-bad',
  amber: 'bg-warn-soft text-warn',
  blue: 'bg-info-soft text-info',
}

export interface RowProps {
  leading?: ReactNode
  leadingTone?: RowLeadingTone
  headline: ReactNode
  supporting?: ReactNode
  trailing?: ReactNode
  /** Show the chevron at the end. Defaults true when `onClick` is provided. */
  chev?: boolean
  onClick?: () => void
  /** Drop the bottom border (e.g. last row in an inset list). */
  noBorder?: boolean
  className?: string
}

export function Row({
  leading,
  leadingTone = 'default',
  headline,
  supporting,
  trailing,
  chev,
  onClick,
  noBorder,
  className,
}: RowProps) {
  const showChev = chev ?? Boolean(onClick)
  const Element = onClick ? 'button' : 'div'
  return (
    <Element
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 px-3.5 py-3 min-h-[52px] w-full text-left',
        noBorder ? '' : 'border-b border-line last:border-b-0',
        onClick ? 'active:bg-card-soft' : '',
        className,
      )}
    >
      {leading !== undefined ? (
        <span
          className={cn(
            'inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0',
            LEADING_TONES[leadingTone],
          )}
          aria-hidden="true"
        >
          {leading}
        </span>
      ) : null}
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] font-medium truncate">{headline}</span>
        {supporting ? <span className="block text-[12px] text-ink-3 mt-0.5">{supporting}</span> : null}
      </span>
      {trailing || showChev ? (
        <span className="flex items-center gap-1.5 shrink-0 text-[13px] text-ink-3">
          {trailing}
          {showChev ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              width="14"
              height="14"
              className="text-ink-4"
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          ) : null}
        </span>
      ) : null}
    </Element>
  )
}
