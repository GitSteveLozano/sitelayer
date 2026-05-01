import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/lib/auth'
import { AppShell } from '@/components/shell/AppShell'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'

const HomeRoute = lazy(() => import('@/routes/home'))
const ProjectsRoute = lazy(() => import('@/routes/projects'))
const TimeRoute = lazy(() => import('@/routes/time'))
const RentalsRoute = lazy(() => import('@/routes/rentals'))
const MoreRoute = lazy(() => import('@/routes/more'))
const LogRoute = lazy(() => import('@/routes/log'))

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

function Loading() {
  return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading…</div>
}

function NotFound() {
  return (
    <PlaceholderScreen eyebrow="404" title="Not found">
      No screen at this path. Use the tab bar.
    </PlaceholderScreen>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<HomeRoute />} />
                <Route path="/projects/*" element={<ProjectsRoute />} />
                <Route path="/time/*" element={<TimeRoute />} />
                <Route path="/rentals/*" element={<RentalsRoute />} />
                <Route path="/more/*" element={<MoreRoute />} />
                <Route path="/log" element={<LogRoute />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  )
}
