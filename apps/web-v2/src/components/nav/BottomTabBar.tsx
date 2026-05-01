import { NavLink } from 'react-router-dom'
import { TABS } from './tabs'
import { cn } from '@/lib/cn'

/**
 * Mobile bottom tab bar — the primary nav surface from `Mobile.html`.
 *
 * Active state uses brand amber per the design; the inactive ink-3 is
 * the canonical token. Honours `safe-area-inset-bottom` so the home
 * indicator on iOS doesn't cover the labels.
 */
export function BottomTabBar() {
  return (
    <nav
      role="tablist"
      aria-label="Primary"
      className={cn(
        'fixed bottom-0 inset-x-0 z-30 flex items-stretch',
        'bg-bg border-t border-line',
        'pt-1.5 pb-[calc(env(safe-area-inset-bottom,0px)+6px)]',
      )}
    >
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/'}
          role="tab"
          className={({ isActive }) =>
            cn(
              'flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5',
              'px-1 py-1.5 text-[10px] font-medium',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm',
              isActive ? 'text-accent' : 'text-ink-3',
            )
          }
        >
          {({ isActive }) => (
            <>
              <tab.icon width={22} height={22} strokeWidth={isActive ? 2 : 1.8} aria-hidden="true" />
              <span>{tab.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
