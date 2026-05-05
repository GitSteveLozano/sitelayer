import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Tier-3 AI surface: an agent draft awaiting human review.
 *
 * Dashed border + corner banner ("Agent draft · review before sending")
 * is the canonical pre-flight pattern from `AI Layer.html`. Anything
 * inside this surface should be reviewable and rejectable; the user is
 * always the last hand on the wheel.
 *
 * Use this for: takeoff-to-bid suggestions, follow-up emails, voice-to-log
 * drafts. **Do not** use it as a chatbot container — that's on the
 * anti-list.
 */
export interface AgentSurfaceProps {
  /** Banner copy. Defaults to the canonical phrasing. */
  banner?: string
  className?: string
  children: ReactNode
}

export function AgentSurface({
  banner = 'Agent draft · review before sending',
  className,
  children,
}: AgentSurfaceProps) {
  return (
    <div
      className={cn(
        'relative bg-card-soft border-[1.5px] border-dashed border-accent rounded px-4 pt-3.5 pb-3 mt-3',
        className,
      )}
    >
      <span
        className="absolute -top-[9px] left-3 px-1.5 bg-bg text-accent-ink text-[9px] font-bold tracking-[0.1em] uppercase"
        aria-hidden="true"
      >
        {banner}
      </span>
      <span className="sr-only">{banner}.</span>
      {children}
    </div>
  )
}
