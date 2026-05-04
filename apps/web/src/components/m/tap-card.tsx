/**
 * Tappable card primitive. Used wherever a stacked card needs to be the
 * tap target (project card, equipment tile, dispatch row). Renders as a
 * <button> so keyboard / screen-reader semantics are correct, with the
 * card styling driven by inline style props.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type MTapCardProps = {
  children: ReactNode
  borderLeft?: string
  onClick?: () => void
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'>

export function MTapCard({ children, borderLeft, onClick, style, className, ...rest }: MTapCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      style={{
        background: 'var(--m-card)',
        border: '1px solid var(--m-line)',
        borderLeft,
        borderRadius: 12,
        padding: '12px 14px',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        width: '100%',
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
