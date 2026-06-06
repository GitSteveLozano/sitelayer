import type { ComponentType, ReactNode, SVGProps } from 'react'

export type MQuickActionProps = {
  Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  label: ReactNode
  onClick?: () => void
}

/**
 * Quick-action tile. Used in 4-up grids — 36×36 icon tile + 11px label.
 */
export function MQuickAction({ Icon, label, onClick }: MQuickActionProps) {
  return (
    <button type="button" className="m-qa" onClick={onClick}>
      <span className="m-qa-icon">
        <Icon size={18} />
      </span>
      <span className="m-qa-label">{label}</span>
    </button>
  )
}

export function MQuickActionGrid({ children }: { children: ReactNode }) {
  return <div className="m-qa-grid">{children}</div>
}
