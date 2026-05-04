import type { ReactNode } from 'react'

export type MLargeHeadProps = {
  title: ReactNode
  sub?: ReactNode
  eyebrow?: ReactNode
  right?: ReactNode
}

/**
 * iOS-style large title block. 30px display, optional 14px subtitle, optional
 * eyebrow above and right slot for an avatar/button.
 */
export function MLargeHead({ title, sub, eyebrow, right }: MLargeHeadProps) {
  return (
    <div className="m-largehead">
      {eyebrow ? <div className="m-topbar-eyebrow">{eyebrow}</div> : null}
      <div className="m-largehead-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="m-h-display">{title}</div>
          {sub ? <div className="m-h-sub">{sub}</div> : null}
        </div>
        {right ? <div>{right}</div> : null}
      </div>
    </div>
  )
}
