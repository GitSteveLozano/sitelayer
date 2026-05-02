import type { ReactNode } from 'react'
import { Spark } from './Spark'
import { cn } from '@/lib/cn'

/**
 * `MAiEyebrow` from `mobile-primitives.jsx`. Replaces "Heads up" /
 * "Did you know" labels above an intelligence-layer card.
 *
 * Spec from `.m-ai-eyebrow`:
 *   - 10/700 accent-ink, uppercase tracking 0.08em.
 *   - small spark glyph (size 11) on the left.
 *   - tone="warn" tints to amber-ink (#8a5a14) and uses spark state="strong".
 *
 * Always pair with a StripeCard or AgentSurface — never standalone.
 */
export type AiEyebrowTone = 'accent' | 'warn'

const TONE: Record<AiEyebrowTone, string> = {
  accent: 'text-accent-ink',
  warn: 'text-[#8a5a14]',
}

export interface AiEyebrowProps {
  tone?: AiEyebrowTone
  children: ReactNode
  className?: string
}

export function AiEyebrow({ tone = 'accent', children, className }: AiEyebrowProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em]',
        TONE[tone],
        className,
      )}
    >
      <Spark state={tone === 'warn' ? 'strong' : 'accent'} size={11} aria-label="" />
      {children}
    </span>
  )
}
