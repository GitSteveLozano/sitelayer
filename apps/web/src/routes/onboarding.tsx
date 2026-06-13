import { Navigate } from 'react-router-dom'
import { useIsDesktop } from '@/lib/use-is-desktop'

/**
 * Legacy /onboarding entry. The pre-design 3-step Tailwind wizard
 * (screens/onboarding/wizard.tsx) was retired by the 2026-06-12
 * design-fidelity audit (M01/D16): first-run users now land on the DESIGNED
 * flows instead — the desktop account-setup wizard at /welcome (dsg__68-72)
 * or the mobile owner flow at /owner/onboarding (msg__01-03). This route is
 * kept only so stale links/bookmarks to /onboarding resolve.
 */
export default function OnboardingRoute() {
  const isDesktop = useIsDesktop()
  return <Navigate to={isDesktop ? '/welcome' : '/owner/onboarding'} replace />
}
