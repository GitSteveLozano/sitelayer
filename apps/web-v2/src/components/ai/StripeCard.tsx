import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Tier-2 AI surface: a card with a left accent stripe.
 *
 * Used when AI has a single observation worth a row of UI but not a
 * standalone agent surface. The stripe is the only signal that this
 * card is AI-sourced — no badges, no chrome.
 */
export type StripeTone = 'accent' | 'warn' | 'good'

const TONE_BORDER: Record<StripeTone, string> = {
  accent: 'border-l-accent',
  warn: 'border-l-warn',
  good: 'border-l-good',
}

export interface StripeCardProps {
  tone?: StripeTone
  className?: string
  children: ReactNode
}

export function StripeCard({ tone = 'accent', className, children }: StripeCardProps) {
  return (
    <div
      data-tone={tone}
      className={cn(
        'bg-card border border-line border-l-[3px] rounded shadow-card px-4 py-3.5',
        TONE_BORDER[tone],
        className,
      )}
    >
      {children}
    </div>
  )
}
