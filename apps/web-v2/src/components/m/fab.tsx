/**
 * Floating action button (Android-style). Lives at the bottom-right of
 * a screen above the bottom-tab bar. Use the `extended` variant to
 * include a label inline with the icon.
 */
import type { ReactNode } from 'react'

export type MFabProps = {
  onClick?: () => void
  ariaLabel?: string
  extended?: boolean
  children: ReactNode
}

export function MFab({ onClick, ariaLabel, extended, children }: MFabProps) {
  return (
    <button
      type="button"
      className={`m-fab${extended ? ' m-fab-extended' : ''}`}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  )
}
