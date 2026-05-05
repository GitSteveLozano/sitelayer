import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/lib/auth'
import { ColdStartSplash } from '@/components/shell/ColdStartSplash'
import { SafariLandingScreen, useShouldShowSafariLanding } from '@/screens/onboarding'

// Canonical mobile shell from PR #229. Promoted from /m/* to the app
// root on 2026-05-05 (Option A) when the desktop AppShell was retired —
// production is mobile-first, so the role-aware shell with bottom tabs
// is what every user sees by default.
const MRoute = lazy(() => import('@/routes/m'))
const MPreviewRoute = lazy(() => import('@/views/m-preview').then((m) => ({ default: m.MPreviewView })))

// Specialized full-screen routes that don't fit the bottom-tab chrome.
// These must match before the mobile-shell catch-all below.
const MoreRoute = lazy(() => import('@/routes/more'))
const FinancialRoute = lazy(() => import('@/routes/financial'))
const BidAccuracyRoute = lazy(() => import('@/routes/bid-accuracy'))
const PhotoRoute = lazy(() => import('@/routes/photo'))
const LiveCrewRoute = lazy(() => import('@/routes/live-crew'))
const OnboardingRoute = lazy(() => import('@/routes/onboarding'))
const LocationPrimeRoute = lazy(() => import('@/routes/permissions-location'))
const NotificationsPrimeRoute = lazy(() => import('@/routes/permissions-notifications'))

// Project deep routes — drawing/measure/contract surfaces that need the
// full viewport. Mounted at the root so they take precedence over the
// mobile shell's `projects/:projectId/*` catch-all.
const ProjectSetupScreen = lazy(() =>
  import('@/screens/projects/setup').then((m) => ({ default: m.ProjectSetupScreen })),
)
const TakeoffCanvasScreen = lazy(() =>
  import('@/screens/projects/takeoff-canvas').then((m) => ({ default: m.TakeoffCanvasScreen })),
)
const TakeoffSummaryScreen = lazy(() =>
  import('@/screens/projects/takeoff-summary').then((m) => ({ default: m.TakeoffSummaryScreen })),
)
const TakeoffDetailScreen = lazy(() =>
  import('@/screens/projects/takeoff-detail').then((m) => ({ default: m.TakeoffDetailScreen })),
)
const PhotoMeasureScreen = lazy(() =>
  import('@/screens/projects/photo-measure').then((m) => ({ default: m.PhotoMeasureScreen })),
)
const ProjectRentalContractScreen = lazy(() =>
  import('@/screens/inventory-admin').then((m) => ({ default: m.ProjectRentalContractScreen })),
)

// Single client for the whole app. v2 uses TanStack Query for fetching
// and caching; offline-aware mutations land in Phase 1.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

// Vite injects `import.meta.env.BASE_URL` at build time from the `base`
// option. When deployed to gh-pages this is `/sitelayer/`; locally it's
// `/`. React Router needs the basename without the trailing slash.
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '')

/**
 * First-visit gate. iOS Safari users that haven't installed get the
 * full-screen `splash-landing` on top of the rest of the app until
 * they tap Skip / Add to Home Screen. Everywhere else returns
 * children unchanged.
 */
function FirstRunGate({ children }: { children: React.ReactNode }) {
  const landing = useShouldShowSafariLanding()
  if (!landing.ready) return <ColdStartSplash />
  if (landing.show) return <SafariLandingScreen onSkip={landing.skip} />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={ROUTER_BASENAME}>
          <Suspense fallback={<ColdStartSplash />}>
            <FirstRunGate>
              <Routes>
                {/* Project deep routes that need the full viewport. */}
                <Route path="/projects/:id/setup" element={<ProjectSetupScreen />} />
                <Route path="/projects/:id/takeoff/:measurementId" element={<TakeoffDetailScreen />} />
                <Route path="/projects/:id/takeoff-canvas" element={<TakeoffCanvasScreen />} />
                <Route path="/projects/:id/takeoff-summary" element={<TakeoffSummaryScreen />} />
                <Route path="/projects/:id/photo-measure" element={<PhotoMeasureScreen />} />
                <Route path="/projects/:id/rental-contract" element={<ProjectRentalContractScreen />} />

                {/* Admin / specialized full-screen routes — no bottom-tab
                    chrome. Linked from the mobile shell's More tab and
                    elsewhere; a future iteration may pull them inside
                    the shell. */}
                <Route path="/more/*" element={<MoreRoute />} />
                <Route path="/financial/*" element={<FinancialRoute />} />
                <Route path="/bid-accuracy" element={<BidAccuracyRoute />} />
                <Route path="/photo" element={<PhotoRoute />} />
                <Route path="/live-crew" element={<LiveCrewRoute />} />

                {/* Onboarding + permission primes — full-screen takeovers. */}
                <Route path="/onboarding" element={<OnboardingRoute />} />
                <Route path="/permissions/location" element={<LocationPrimeRoute />} />
                <Route path="/permissions/notifications" element={<NotificationsPrimeRoute />} />

                {/* Dev-only primitive showcase. */}
                <Route path="/m-preview" element={<MPreviewRoute />} />

                {/* Legacy alias — original mount of the mobile shell. */}
                <Route path="/m/*" element={<MRoute basePath="/m" />} />

                {/* Mobile shell — canonical UX, claims everything else. */}
                <Route path="/*" element={<MRoute />} />
              </Routes>
            </FirstRunGate>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  )
}
