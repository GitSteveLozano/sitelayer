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
  // The PDFium (EmbedPDF) engine + WASM glue is heavy third-party code that is
  // lazy-loaded only when a plan-set PDF is opened on the takeoff surface. Keep
  // it in its own `vendor-pdf` chunk — like `vendor-three`, it's vendor code,
  // so it's exempt from the lazy *app*-chunk budget and stays off the PWA
  // precache (see the workbox config below).
  if (normalized.includes('/@embedpdf/')) return 'vendor-pdf'
  // rrweb (@rrweb/record + rrweb-snapshot) is heavy third-party recording
  // code pulled in only by the feedback-capture dock. Keep it in its own
  // lazy `vendor-rrweb` chunk — like vendor-three/vendor-pdf it's vendor
  // code, so it's exempt from the lazy *app*-chunk budget and only downloads
  // when the (lazily-mounted) dock loads, never on the eager critical path.
  if (normalized.includes('/@rrweb/') || normalized.includes('/rrweb-snapshot/') || normalized.includes('/rrweb/')) {
    return 'vendor-rrweb'
  }
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
  // Baked-in build identity so the client can detect when the server has a
  // newer build (see src/pwa/version-guard.ts). The deploy passes
  // APP_BUILD_SHA / GIT_SHA into the web build; falls back to 'dev' locally,
  // where the version guard is a no-op.
  define: {
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(
      process.env.VITE_BUILD_SHA ?? process.env.APP_BUILD_SHA ?? process.env.GIT_SHA ?? 'dev',
    ),
  },
  plugins: [
    react(),
    VitePWA({
      // autoUpdate (NOT 'prompt'): paired with skipWaiting/clientsClaim below so
      // a new deploy's SW activates and claims open tabs immediately. The actual
      // page refresh to the new assets is driven by the controllerchange handler
      // in src/pwa/register.ts. 'prompt' + skipWaiting was self-defeating — the
      // SW never entered "waiting", so onNeedRefresh never fired and the banner
      // never showed, leaving open tabs on the stale bundle until a manual reload.
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/icon.svg', 'icons/maskable.svg'],
      manifest: {
        name: 'Sitelayer',
        short_name: 'Sitelayer',
        description: 'Construction operations — takeoff, time, rentals, sync.',
        theme_color: '#ffd400',
        background_color: '#ede7da',
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
        // Keep the heavy `vendor-three` chunk (~538KB, the 3D takeoff scene)
        // OUT of the precache manifest. It's already lazy-loaded
        // (TakeoffPreviewScreen is `lazy()` in App.tsx), so the app shell
        // never references it — but the default glob would still bake all
        // 538KB into every install, forcing workers/foremen who never open
        // the 3D preview to download it on first install. Exclude it here and
        // serve it via the `runtimeCaching` rule below so it's fetched (and
        // cached for offline) only when a user actually opens the preview.
        globIgnores: ['**/vendor-three*.js', '**/vendor-pdf*.js'],
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
            // The excluded `vendor-three` chunk is fetched on demand the first
            // time the 3D takeoff preview opens. CacheFirst keeps it offline
            // once downloaded (content-hashed filename → cache key changes on
            // every rebuild, so there's no stale-bundle risk).
            urlPattern: /\/assets\/vendor-three[^/]*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'vendor-three',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // The excluded `vendor-pdf` chunk (PDFium/EmbedPDF engine) is
            // fetched on demand the first time a plan PDF is opened on the
            // takeoff surface, then kept offline. Content-hashed filename →
            // cache key rotates every rebuild, so there's no stale-bundle risk.
            urlPattern: /\/assets\/vendor-pdf[^/]*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'vendor-pdf',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
    // Vite 8 / Rolldown computes a much broader entry modulepreload graph than
    // Rollup did — it eagerly preloaded ~13 route-level util chunks (cn, auth,
    // queue, daily-logs, crud-factory, keys, instrument, capture-session, ...)
    // that belong on the lazy path. That blew the 160KB initial-eager budget
    // (field-device first-load weight). Trim the preload set to the heavy
    // vendor chunks so the route utils load on-demand, matching the Rollup
    // behavior the budget was tuned against.
    modulePreload: {
      resolveDependencies: (_filename, deps) => deps.filter((dep) => dep.includes('vendor-')),
    },
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
      '@sitelayer/formula-evaluator': fileURLToPath(
        new URL('../../packages/formula-evaluator/src/index.ts', import.meta.url),
      ),
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
