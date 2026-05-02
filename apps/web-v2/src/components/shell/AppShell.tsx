import { Outlet } from 'react-router-dom'
import { BottomTabBar } from '@/components/nav/BottomTabBar'
import { DesktopSideRail } from '@/components/nav/DesktopSideRail'
import { InstallPromptBanner } from './InstallPromptBanner'
import { OfflineBanner } from './OfflineBanner'
import { PushDeniedBanner } from './PushDeniedBanner'
import { UpdateBanner } from './UpdateBanner'

/**
 * Top-level layout. Mobile = bottom tab bar; desktop ≥ 1024px = side rail.
 *
 * OfflineBanner sits at the top of the scroll container so it's visible
 * on every screen without intruding when the user is online + the
 * queue is empty (it returns null in that case).
 *
 * iOS Add-to-Home-Screen used to show as a thin banner here
 * (`IosInstallHint`); the full-screen `splash-landing` takeover (App.tsx
 * `FirstRunGate`) handles that case better, so the banner was retired.
 */
export function AppShell() {
  return (
    <div className="min-h-dvh flex bg-sand text-ink">
      <DesktopSideRail />
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto pb-[calc(env(safe-area-inset-bottom,0px)+72px)] lg:pb-0">
          <OfflineBanner />
          <UpdateBanner />
          <InstallPromptBanner />
          <PushDeniedBanner />
          <Outlet />
        </div>
        <div className="lg:hidden">
          <BottomTabBar />
        </div>
      </main>
    </div>
  )
}
