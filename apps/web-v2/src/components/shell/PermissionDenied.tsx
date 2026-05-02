import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Permission-denied surface from Sitemap §13 ("Location is off").
 * Same shape as ErrorState but the chip is amber-soft (warn, not bad —
 * permission is recoverable) and the actions are explicit:
 *
 *   - "Open settings" — primary, when we can deep-link to the OS UI.
 *   - "Continue without {capability}" — secondary, gracefully degrades.
 *
 * Used for camera (BarcodeScanner), geolocation (auto-clock-in,
 * dispatch), notifications (push). The capability prop is shown in the
 * default "Continue without …" copy.
 */
export interface PermissionDeniedProps {
  title: ReactNode
  body?: ReactNode
  /** "Open settings" action — caller wires the deep-link or instruction. */
  openSettings?: ReactNode
  /** "Continue without …" — graceful degrade path. */
  continueAction?: ReactNode
  className?: string
}

export function PermissionDenied({ title, body, openSettings, continueAction, className }: PermissionDeniedProps) {
  return (
    <div className={cn('flex flex-col items-center text-center px-8 py-12', className)}>
      <div
        aria-hidden="true"
        className="w-16 h-16 rounded-[20px] bg-warn-soft text-warn flex items-center justify-center mb-4"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          width="28"
          height="28"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M5.5 5.5l13 13" />
        </svg>
      </div>
      <div className="text-[15px] font-semibold">{title}</div>
      {body ? <p className="text-[13px] text-ink-3 mt-1.5 max-w-[28ch] leading-relaxed">{body}</p> : null}
      {openSettings || continueAction ? (
        <div className="mt-5 w-full max-w-[280px] flex flex-col gap-2">
          {openSettings}
          {continueAction}
        </div>
      ) : null}
    </div>
  )
}
