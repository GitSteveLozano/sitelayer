import type { ComponentType, SVGProps } from 'react'

export type MBottomTabSpec = {
  id: string
  label: string
  Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  badge?: number | null
}

export type MBottomTabsProps = {
  tabs: readonly MBottomTabSpec[]
  activeId: string
  onSelect: (id: string) => void
}

/**
 * 4-tab or 5-tab bottom bar. Icons 22×22, 10px label, accent for active.
 * Per the persona docs, worker has 4 tabs, foreman has 5; pass whichever
 * shape — the bar adapts.
 */
export function MBottomTabs({ tabs, activeId, onSelect }: MBottomTabsProps) {
  return (
    <nav className="m-bottombar" aria-label="Primary">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="m-bottombar-tab"
          data-active={tab.id === activeId ? 'true' : undefined}
          onClick={() => onSelect(tab.id)}
          aria-label={tab.label}
        >
          <tab.Icon size={22} />
          <span>{tab.label}</span>
          {tab.badge ? <span className="m-tab-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </nav>
  )
}
