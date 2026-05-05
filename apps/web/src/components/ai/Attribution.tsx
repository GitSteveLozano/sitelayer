import { Spark, type SparkState } from './Spark'
import { cn } from '@/lib/cn'

/**
 * Inline source attribution — quiet, monospaced, always present on
 * AI-sourced fields.
 *
 * Hard rule from `AI Layer.html`: every AI-sourced value names what it
 * learned from. "Based on 7 closed jobs." Not "AI suggestion." Not "AI."
 * Specificity is the trust signal.
 */
export interface AttributionProps {
  /** Short sentence — past tense, names the source. */
  source: string
  /** The qualifier inside the sentence (e.g. "7 closed jobs"). */
  emphasis?: string
  state?: SparkState
  className?: string
}

export function Attribution({ source, emphasis, state = 'accent', className }: AttributionProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] leading-snug text-ink-3', className)}>
      <Spark state={state} size={12} aria-label="AI source" />
      {emphasis ? (
        <span>
          {source} <strong className="font-semibold text-ink-2">{emphasis}</strong>
        </span>
      ) : (
        <span>{source}</span>
      )}
    </span>
  )
}
