import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// Same chunking strategy as apps/web/vite.config.ts so the SPA's critical
// path stays small and vendor caches survive across deploys where only app
// code changed. Order matters — more specific patterns first.
//
// Clerk + React 19: Clerk reaches into React internals (`React.Activity`
// is a React 19 transition API). When Clerk lands in its own chunk and
// React lands in `vendor-react`, the chunk-load order can leave Clerk
// holding an undefined reference to React at the moment it tries to
// register, throwing "Cannot set properties of undefined (setting
// 'Activity')". Fix: bundle Clerk alongside React in `vendor-react`
// so they share one resolved module instance.
function manualChunks(id: string): string | undefined {
  const normalized = id.replace(/\\/g, '/')
  if (!normalized.includes('/node_modules/')) return undefined
  if (normalized.includes('/@sentry/')) return 'vendor-sentry'
  if (normalized.includes('/@tanstack/')) return 'vendor-tanstack'
  if (normalized.includes('/react-router')) return 'vendor-router'
  if (normalized.includes('/@clerk/') || normalized.includes('/scheduler/') || /\/react(?:-dom)?\//.test(normalized)) {
    return 'vendor-react'
  }
  if (normalized.includes('/three/')) return 'vendor-three'
  if (normalized.includes('/lucide-react/')) return 'vendor-icons'
  return undefined
}

function readAllowedHosts(): true | string[] | undefined {
  const raw = process.env.VITE_ALLOWED_HOSTS?.trim()
  if (!raw) return undefined
  if (raw === 'true') return true
  return raw
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
}

// `VITE_BASE` lets the gh-pages build produce `/sitelayer/`-prefixed
// asset URLs without a separate vite config. Local + droplet builds
// keep the default `/`.
const base = process.env.VITE_BASE ?? '/'
const baseNoTrailing = base.endsWith('/') ? base.slice(0, -1) : base

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      // Phase 0 ships the install/offline-shell substrate only. Background
      // sync for the offline mutation queue is a Phase 1 concern.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/icon.svg', 'icons/maskable.svg'],
      manifest: {
        name: 'Sitelayer',
        short_name: 'Sitelayer',
        description: 'Construction operations — takeoff, time, rentals, sync.',
        theme_color: '#d9904a',
        background_color: '#f5f1ec',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache the app shell aggressively, never cache /api/* (that path
        // owns its own freshness via TanStack Query in Phase 1).
        navigateFallback: `${baseNoTrailing}/index.html`,
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // 2026-05-10: a redirect response got baked into the precache during
        // a deploy cutover. The SW served it on navigations, and Chrome
        // rejected it ("a redirected response was used for a request whose
        // redirect mode is not 'follow'"), which made /projects, /financial,
        // etc. show "This site can't be reached" until the user did a manual
        // reload. The three flags below evict that bad state on the next
        // deploy and on every subsequent deploy: cleanupOutdatedCaches drops
        // the stale precache, skipWaiting + clientsClaim take over open tabs
        // immediately instead of waiting for the next page-close, and
        // disableDevLogs keeps the console clean in prod.
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'fonts-css' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts-files',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
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
      '@sitelayer/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@sitelayer/workflows': fileURLToPath(new URL('../../packages/workflows/src/index.ts', import.meta.url)),
    },
  },
  server: (() => {
    const allowedHosts = readAllowedHosts()
    return {
      host: '0.0.0.0',
      port: 3100,
      ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    }
  })(),
})
