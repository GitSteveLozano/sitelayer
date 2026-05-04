import type { ReactNode } from 'react'
import type { MTone } from './list.js'

export type MPillProps = {
  tone?: MTone | undefined
  dot?: boolean | undefined
  children: ReactNode
}

/**
 * Inline status badge. 11px, optional tones. Set `dot` to render a 5px
 * leading dot in the same color.
 */
export function MPill({ tone, dot, children }: MPillProps) {
  return (
    <span className="m-pill" data-tone={tone}>
      {dot ? <span className="m-dot" /> : null}
      {children}
    </span>
  )
}

export type MChipProps = {
  active?: boolean | undefined
  outline?: boolean | undefined
  children: ReactNode
  onClick?: (() => void) | undefined
  count?: number | undefined
}

/**
 * Filter / category chip. Used in horizontally-scrolling chip rows.
 * Active chips invert to accent fill on white text; outline gives a
 * neutral border for inactive groups.
 */
export function MChip({ active, outline, children, onClick, count }: MChipProps) {
  return (
    <button
      type="button"
      className="m-chip"
      data-active={active ? 'true' : undefined}
      data-outline={outline ? 'true' : undefined}
      onClick={onClick}
    >
      {children}
      {typeof count === 'number' ? <span style={{ opacity: 0.7, fontWeight: 400 }}>{count}</span> : null}
    </button>
  )
}

export function MChipRow({ children }: { children: ReactNode }) {
  return <div className="m-chip-row">{children}</div>
}
