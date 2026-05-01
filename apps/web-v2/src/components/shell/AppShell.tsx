import { Outlet } from 'react-router-dom'
import { BottomTabBar } from '@/components/nav/BottomTabBar'
import { DesktopSideRail } from '@/components/nav/DesktopSideRail'

/**
 * Top-level layout. Mobile = bottom tab bar; desktop ≥ 1024px = side rail.
 *
 * The body is a single scroll container with bottom padding equal to the
 * tab bar's height — the design shows screens scrolling underneath the
 * tabbar, never around it.
 */
export function AppShell() {
  return (
    <div className="min-h-dvh flex bg-sand text-ink">
      <DesktopSideRail />
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto pb-[calc(env(safe-area-inset-bottom,0px)+72px)] lg:pb-0">
          <Outlet />
        </div>
        <div className="lg:hidden">
          <BottomTabBar />
        </div>
      </main>
    </div>
  )
}
