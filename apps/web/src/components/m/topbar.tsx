import { MI } from './icons.js'
import type { ReactNode } from 'react'

export type MTopBarProps = {
  back?: boolean | undefined
  /** Use a modal-dismiss "X" in the left button instead of the back chevron. */
  backVariant?: 'back' | 'close' | undefined
  backLabel?: string | undefined
  title: string
  sub?: string | undefined
  eyebrow?: string | undefined
  actionLabel?: string | undefined
  actionIcon?: ReactNode | undefined
  onBack?: (() => void) | undefined
  onAction?: (() => void) | undefined
}

/**
 * Top app bar. 56px min-height, 2px bottom border. The left button is a
 * 48×48 square tap target (back chevron, or a close "X" for modal-style
 * full-screen flows); the action slot mirrors it on the right.
 */
export function MTopBar({
  back,
  backVariant = 'back',
  backLabel,
  title,
  sub,
  eyebrow,
  actionLabel,
  actionIcon,
  onBack,
  onAction,
}: MTopBarProps) {
  const isClose = backVariant === 'close'
  return (
    <div className="m-topbar">
      {back ? (
        <button
          type="button"
          className="m-topbar-back"
          aria-label={backLabel ?? (isClose ? 'Close' : 'Back')}
          onClick={onBack}
        >
          {isClose ? <MI.X size={22} /> : <MI.ChevLeft size={22} />}
        </button>
      ) : null}
      <div className="m-topbar-title">
        {eyebrow ? <div className="m-topbar-eyebrow">{eyebrow}</div> : null}
        <div className="m-h1">{title}</div>
        {sub ? <div className="m-sub">{sub}</div> : null}
      </div>
      {actionIcon || actionLabel ? (
        <button type="button" className="m-topbar-action" aria-label={actionLabel ?? 'Action'} onClick={onAction}>
          {actionIcon}
        </button>
      ) : null}
    </div>
  )
}
