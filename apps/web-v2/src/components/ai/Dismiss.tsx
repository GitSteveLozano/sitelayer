import { cn } from '@/lib/cn'

/**
 * One-tap dismiss control for any AI suggestion.
 *
 * Hard rule from `AI Layer.html`: dismiss is **signal**, not deletion.
 * The cohort model uses dismissals to learn — never silently drop them.
 * Callers must report the dismissal to the API; this component just
 * fires the click handler.
 */
export interface DismissProps {
  onDismiss: () => void
  className?: string
  /** Accessible label. The visual is just an X. */
  label?: string
}

export function Dismiss({ onDismiss, className, label = 'Dismiss suggestion' }: DismissProps) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center shrink-0',
        'w-[22px] h-[22px] rounded-full border border-line bg-transparent text-ink-3',
        'hover:bg-card-soft hover:text-ink',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
        className,
      )}
    >
      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </svg>
    </button>
  )
}
