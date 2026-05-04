import { MI } from './icons.js'
import type { ReactNode } from 'react'

export type MTopBarProps = {
  back?: boolean
  title: string
  sub?: string
  eyebrow?: string
  actionLabel?: string
  actionIcon?: ReactNode
  onBack?: () => void
  onAction?: () => void
}

/**
 * Top app bar. 52px min-height, 1px bottom border. Back button is a
 * 36×36 circular tap target; the action slot mirrors it on the right.
 */
export function MTopBar({
  back,
  title,
  sub,
  eyebrow,
  actionLabel,
  actionIcon,
  onBack,
  onAction,
}: MTopBarProps) {
  return (
    <div className="m-topbar">
      {back ? (
        <button
          type="button"
          className="m-topbar-back"
          aria-label="Back"
          onClick={onBack}
        >
          <MI.ChevLeft size={22} />
        </button>
      ) : null}
      <div className="m-topbar-title">
        {eyebrow ? <div className="m-topbar-eyebrow">{eyebrow}</div> : null}
        <div className="m-h1">{title}</div>
        {sub ? <div className="m-sub">{sub}</div> : null}
      </div>
      {actionIcon || actionLabel ? (
        <button
          type="button"
          className="m-topbar-action"
          aria-label={actionLabel ?? 'Action'}
          onClick={onAction}
        >
          {actionIcon}
        </button>
      ) : null}
    </div>
  )
}
