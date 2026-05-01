import { cn } from '@/lib/cn'

/**
 * The canonical AI mark.
 *
 * Confidence is **ordinal**, never numeric. The four states map to
 * placeholder / low / medium / high. Hard rule from `AI Layer.html`:
 * the mark never animates on idle.
 */
export type SparkState = 'dim' | 'muted' | 'accent' | 'strong'

const STATE_COLOR: Record<SparkState, string> = {
  dim: 'text-ink-4',
  muted: 'text-ink-3',
  accent: 'text-accent',
  strong: 'text-accent-ink',
}

export interface SparkProps {
  state?: SparkState
  size?: number
  className?: string
  'aria-label'?: string
}

export function Spark({ state = 'accent', size = 14, className, ...rest }: SparkProps) {
  const ariaLabel = rest['aria-label'] ?? 'AI signal'
  return (
    <span
      data-state={state}
      role="img"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center justify-center shrink-0', STATE_COLOR[state], className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="-50 -50 100 100" width={size} height={size} aria-hidden="true">
        <path
          d="M0 -40 L10 -10 L40 0 L10 10 L0 40 L-10 10 L-40 0 L-10 -10 Z"
          fill="currentColor"
        />
      </svg>
    </span>
  )
}
