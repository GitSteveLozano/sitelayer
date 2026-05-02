import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/lib/auth'
import { AppShell } from '@/components/shell/AppShell'
import { ColdStartSplash } from '@/components/shell/ColdStartSplash'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'
import { SafariLandingScreen, useShouldShowSafariLanding } from '@/screens/onboarding'

const HomeRoute = lazy(() => import('@/routes/home'))
const ProjectsRoute = lazy(() => import('@/routes/projects'))
const TimeRoute = lazy(() => import('@/routes/time'))
const RentalsRoute = lazy(() => import('@/routes/rentals'))
const MoreRoute = lazy(() => import('@/routes/more'))
const LogRoute = lazy(() => import('@/routes/log'))
const ScheduleRoute = lazy(() => import('@/routes/schedule'))
const LiveCrewRoute = lazy(() => import('@/routes/live-crew'))
const PhotoRoute = lazy(() => import('@/routes/photo'))
const BidAccuracyRoute = lazy(() => import('@/routes/bid-accuracy'))
const FinancialRoute = lazy(() => import('@/routes/financial'))
const OnboardingRoute = lazy(() => import('@/routes/onboarding'))
const LocationPrimeRoute = lazy(() => import('@/routes/permissions-location'))
const NotificationsPrimeRoute = lazy(() => import('@/routes/permissions-notifications'))

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

function NotFound() {
  return (
    <PlaceholderScreen eyebrow="404" title="Not found">
      No screen at this path. Use the tab bar.
    </PlaceholderScreen>
  )
}

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
                <Route element={<AppShell />}>
                  <Route path="/" element={<HomeRoute />} />
                  <Route path="/projects/*" element={<ProjectsRoute />} />
                  <Route path="/time/*" element={<TimeRoute />} />
                  <Route path="/rentals/*" element={<RentalsRoute />} />
                  <Route path="/more/*" element={<MoreRoute />} />
                  <Route path="/log" element={<LogRoute />} />
                  <Route path="/schedule" element={<ScheduleRoute />} />
                  <Route path="/live-crew" element={<LiveCrewRoute />} />
                  <Route path="/photo" element={<PhotoRoute />} />
                  <Route path="/bid-accuracy" element={<BidAccuracyRoute />} />
                  <Route path="/financial/*" element={<FinancialRoute />} />
                  <Route path="/onboarding" element={<OnboardingRoute />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
                {/* Permission primes render outside AppShell — they're
                    full-screen takeovers without bottom-tab chrome. */}
                <Route path="/permissions/location" element={<LocationPrimeRoute />} />
                <Route path="/permissions/notifications" element={<NotificationsPrimeRoute />} />
              </Routes>
            </FirstRunGate>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  )
}
