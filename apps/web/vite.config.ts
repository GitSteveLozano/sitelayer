import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

function manualChunks(id: string): string | undefined {
  const normalized = id.replace(/\\/g, '/')
  if (!normalized.includes('/node_modules/')) return undefined
  if (normalized.includes('/@clerk/')) return 'vendor-clerk'
  if (normalized.includes('/@sentry/')) return 'vendor-sentry'
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
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
})
