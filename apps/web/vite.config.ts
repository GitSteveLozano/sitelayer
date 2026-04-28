import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Split heavy third-party deps into their own chunks so the SPA's critical
// path stays small and the browser can cache vendor bundles across deploys
// where only app code changed. Order matters: more specific patterns first
// (e.g. @clerk before generic react), so a re-exported react surface inside
// @clerk lands in vendor-clerk, not vendor-react.
function manualChunks(id: string): string | undefined {
  const normalized = id.replace(/\\/g, '/')
  if (!normalized.includes('/node_modules/')) return undefined
  if (normalized.includes('/@clerk/')) return 'vendor-clerk'
  if (normalized.includes('/@sentry/')) return 'vendor-sentry'
  if (normalized.includes('/@radix-ui/')) return 'vendor-radix'
  if (normalized.includes('/react-router')) return 'vendor-router'
  if (normalized.includes('/scheduler/') || /\/react(?:-dom)?\//.test(normalized)) return 'vendor-react'
  if (normalized.includes('/lucide-react/')) return 'vendor-icons'
  return undefined
}

export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.VITE_CACHE_DIR ?? '.vite-cache',
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  build: {
    sourcemap:
      process.env.SENTRY_SOURCEMAPS === '1' ||
      Boolean(process.env.SENTRY_AUTH_TOKEN) ||
      Boolean(process.env.SENTRY_RELEASE),
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Resolve workspace @sitelayer/domain directly to its TS source so the
      // preview/dev container's `npm run dev:web` doesn't require the
      // dist/ artifact to exist. Production builds compile this via the
      // standard React plugin, same as our local `src/` files. If we add
      // more workspace deps to the SPA, mirror them here.
      '@sitelayer/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
})
