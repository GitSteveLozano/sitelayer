import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SignedIn, SignedOut, SignIn, SignUp } from '@clerk/clerk-react'
import { AuthProvider, isClerkConfigured } from '@/lib/auth'
import { ColdStartSplash } from '@/components/shell/ColdStartSplash'
import { RoleSwitcher } from '@/components/dev/RoleSwitcher'
import {
  InstallPromptSheet,
  PostInstallSplash,
  SafariLandingScreen,
  useShouldShowSafariLanding,
} from '@/screens/onboarding'

/**
 * The dev role-switcher is gated by two independent checks so it
 * never escapes into a real deployment:
 *   1. `!isClerkConfigured()` -- once a Clerk publishable key is wired
 *      the SPA is on real auth and the override loses authority.
 *   2. `import.meta.env.MODE !== 'production'` -- Vite drops this branch
 *      from the production bundle entirely (dead-code elimination on
 *      the `false` literal).
 * The API enforces the matching guarantee on its side (auth.ts).
 */
const SHOW_ROLE_SWITCHER = !isClerkConfigured() && import.meta.env.MODE !== 'production'

// Authenticated workspace router. It resolves the caller's company first,
// then picks the admin shell or the field shell from permissions.
const WorkspaceRoute = lazy(() => import('@/routes/workspace'))

// Canonical field shell from PR #229. `/m/*` remains as a legacy alias
// for links that pointed directly at the mobile shell before the
// admin-first workspace router became the root.
const MRoute = lazy(() => import('@/routes/m'))
const MPreviewRoute = lazy(() => import('@/screens/mobile-preview').then((m) => ({ default: m.MPreviewView })))

// Specialized full-screen routes that don't fit the bottom-tab chrome.
// These must match before the mobile-shell catch-all below. /more is
// intentionally not in this list -- it's wired as a tab in m-shell so
// the bottom-tab chrome stays visible from settings/catalog/integrations.
const FinancialRoute = lazy(() => import('@/routes/financial'))
const BidAccuracyRoute = lazy(() => import('@/routes/bid-accuracy'))
const PhotoRoute = lazy(() => import('@/routes/photo'))
const LiveCrewRoute = lazy(() => import('@/routes/live-crew'))
const OnboardingRoute = lazy(() => import('@/routes/onboarding'))
const LocationPrimeRoute = lazy(() => import('@/routes/permissions-location'))
const NotificationsPrimeRoute = lazy(() => import('@/routes/permissions-notifications'))

// Project deep routes -- drawing/measure/contract surfaces that need the
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
const TakeoffPreviewScreen = lazy(() =>
  import('@/screens/projects/takeoff-preview').then((m) => ({ default: m.TakeoffPreviewScreen })),
)
const ScaffoldDesignerScreen = lazy(() =>
  import('@/screens/scaffold/scaffold-designer').then((m) => ({ default: m.ScaffoldDesignerScreen })),
)
const ProjectBomsScreen = lazy(() =>
  import('@/screens/scaffold/project-boms').then((m) => ({ default: m.ProjectBomsScreen })),
)
const ChangeOrdersScreen = lazy(() =>
  import('@/screens/mobile/change-orders').then((m) => ({ default: m.MobileChangeOrders })),
)
const TakeoffDetailScreen = lazy(() =>
  import('@/screens/projects/takeoff-detail').then((m) => ({ default: m.TakeoffDetailScreen })),
)
const PhotoMeasureScreen = lazy(() =>
  import('@/screens/projects/photo-measure').then((m) => ({ default: m.PhotoMeasureScreen })),
)
const PortalEstimateView = lazy(() => import('@/portal/EstimateView').then((m) => ({ default: m.EstimateView })))
const PortalEstimateAcceptedView = lazy(() =>
  import('@/portal/EstimateAcceptedView').then((m) => ({ default: m.EstimateAcceptedView })),
)
const PortalRentalsView = lazy(() => import('@/portal/RentalsPortal').then((m) => ({ default: m.RentalsPortal })))
const PortalRentalsCart = lazy(() => import('@/portal/RentalsCart').then((m) => ({ default: m.RentalsCart })))
const PortalRentalsConfirm = lazy(() => import('@/portal/RentalsConfirm').then((m) => ({ default: m.RentalsConfirm })))
const TakeoffPreviewDemo = lazy(() =>
  import('@/screens/projects/takeoff-preview-demo').then((m) => ({ default: m.TakeoffPreviewDemo })),
)
const EstimateBuilderScreen = lazy(() =>
  import('@/screens/projects/estimate-builder').then((m) => ({ default: m.EstimateBuilderScreen })),
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
  // Once past the iOS gate the install + post-install surfaces sit on
  // top of the running shell. Both are self-gated (no-op when the
  // user has already seen them), so it's safe to mount them
  // unconditionally above the rest of the app.
  return (
    <>
      {children}
      <InstallPromptSheet />
      <PostInstallSplash />
    </>
  )
}

/**
 * Auth gate for the production tier. With `AUTH_ALLOW_HEADER_FALLBACK=0`
 * and a `CLERK_JWT_KEY` set on the API, every request needs a Clerk
 * Bearer token, so unauthenticated visitors must hit `<SignIn>` before
 * they can render the mobile shell. v1 had this gate; v2 dropped it
 * during the SPA refactor and added it back on 2026-05-05 once the
 * mobile shell promoted to the canonical root.
 *
 * When Clerk isn't configured (local dev without `VITE_CLERK_PUBLISHABLE_KEY`,
 * fixture mode), `ClerkProvider` isn't mounted -- `<SignedIn>`/`<SignedOut>`
 * would throw -- so we render children directly. The API's header
 * fallback path keeps that flow working.
 */
function ClerkAuthGate({ children }: { children: React.ReactNode }) {
  if (!isClerkConfigured()) return <>{children}</>
  return (
    <>
      <SignedOut>
        <UnauthShell />
      </SignedOut>
      <SignedIn>{children}</SignedIn>
    </>
  )
}

function UnauthShell() {
  return (
    <div
      style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}
    >
      <Routes>
        <Route path="/sign-in/*" element={<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />} />
        <Route path="/sign-up/*" element={<SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />} />
        <Route path="*" element={<Navigate to="/sign-in" replace />} />
      </Routes>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={ROUTER_BASENAME}>
          <Suspense fallback={<ColdStartSplash />}>
            <Routes>
              {/* Public client portal routes. Sales loop (signed estimate
                  share-link) and rentals customer portal. NO Clerk auth --
                  recipients hold an HMAC-signed token in the URL. Mounted
                  above FirstRunGate so customers don't see the iOS Safari
                  install prompt either. */}
              <Route path="/portal/estimates/:shareToken" element={<PortalEstimateView />} />
              <Route path="/portal/estimates/:shareToken/accepted" element={<PortalEstimateAcceptedView />} />
              <Route path="/portal/rentals/:shareToken" element={<PortalRentalsView />} />
              <Route path="/portal/rentals/:shareToken/cart" element={<PortalRentalsCart />} />
              <Route path="/portal/rentals/:shareToken/confirm" element={<PortalRentalsConfirm />} />
              <Route path="/demo/takeoff-preview-3d" element={<TakeoffPreviewDemo />} />

              {/* Authenticated app -- Clerk-gated. */}
              <Route
                path="/*"
                element={
                  <FirstRunGate>
                    <ClerkAuthGate>
                      <AppShellRoutes />
                    </ClerkAuthGate>
                  </FirstRunGate>
                }
              />
            </Routes>
          </Suspense>
          {SHOW_ROLE_SWITCHER ? <RoleSwitcher /> : null}
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  )
}

function AppShellRoutes() {
  return (
    <Routes>
      {/* Project deep routes that need the full viewport. */}
      <Route path="/projects/:id/setup" element={<ProjectSetupScreen />} />
      <Route path="/projects/:id/takeoff/:measurementId" element={<TakeoffDetailScreen />} />
      <Route path="/projects/:id/takeoff-canvas" element={<TakeoffCanvasScreen />} />
      <Route path="/projects/:id/takeoff-preview" element={<TakeoffPreviewScreen />} />
      <Route path="/projects/:id/boms" element={<ProjectBomsScreen />} />
      <Route path="/projects/:projectId/change-orders" element={<ChangeOrdersScreen />} />
      <Route path="/scaffold-designer" element={<ScaffoldDesignerScreen />} />
      <Route path="/projects/:id/takeoff-summary" element={<TakeoffSummaryScreen />} />
      <Route path="/projects/:id/photo-measure" element={<PhotoMeasureScreen />} />
      <Route path="/projects/:id/rental-contract" element={<ProjectRentalContractScreen />} />
      <Route path="/projects/:id/estimate-builder" element={<EstimateBuilderScreen />} />

      {/* Admin / specialized full-screen routes -- no bottom-tab
                      chrome. Linked from the mobile shell elsewhere. /more
                      lives inside the shell instead so the 5-tab IA stays
                      intact when the user is in settings/catalog. */}
      <Route path="/financial/*" element={<FinancialRoute />} />
      <Route path="/bid-accuracy" element={<BidAccuracyRoute />} />
      <Route path="/photo" element={<PhotoRoute />} />
      <Route path="/live-crew" element={<LiveCrewRoute />} />

      {/* Onboarding + permission primes -- full-screen takeovers. */}
      <Route path="/onboarding" element={<OnboardingRoute />} />
      <Route path="/permissions/location" element={<LocationPrimeRoute />} />
      <Route path="/permissions/notifications" element={<NotificationsPrimeRoute />} />

      {/* Dev-only primitive showcase. */}
      <Route path="/m-preview" element={<MPreviewRoute />} />

      {/* Legacy alias -- original mount of the mobile shell. */}
      <Route path="/m/*" element={<MRoute basePath="/m" />} />

      {/* Workspace shell -- canonical UX, claims everything else. */}
      <Route path="/*" element={<WorkspaceRoute />} />
    </Routes>
  )
}
