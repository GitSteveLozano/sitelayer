import { NavLink } from 'react-router-dom'
import { TABS } from './tabs'
import { cn } from '@/lib/cn'

/**
 * Desktop side rail — the same five destinations as the mobile tab bar.
 *
 * The design rule is "desktop is the same product, wider, with a side
 * rail." Don't invent a different IA here — mobile and desktop share the
 * `TABS` registry.
 */
export function DesktopSideRail() {
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'hidden lg:flex flex-col w-[212px] shrink-0',
        'bg-bg border-r border-line',
        'pt-6 px-3 pb-4',
      )}
    >
      <div className="px-3 pb-4 flex items-center gap-2">
        <div
          aria-hidden="true"
          className="w-7 h-7 rounded-md bg-accent-soft border border-line flex items-center justify-center"
        >
          <span className="text-accent font-bold text-[11px] tracking-tight">SL</span>
        </div>
        <span className="text-sm font-semibold tracking-tight">Sitelayer</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {TABS.map((tab) => (
          <li key={tab.to}>
            <NavLink
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  isActive
                    ? 'bg-accent-soft text-accent-ink'
                    : 'text-ink-2 hover:text-ink hover:bg-card-soft',
                )
              }
            >
              <tab.icon width={18} height={18} strokeWidth={1.8} aria-hidden="true" />
              <span>{tab.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
