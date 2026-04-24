import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.VITE_CACHE_DIR ?? '.vite-cache',
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  build: {
    sourcemap:
      process.env.SENTRY_SOURCEMAPS === '1' ||
      Boolean(process.env.SENTRY_AUTH_TOKEN) ||
      Boolean(process.env.SENTRY_RELEASE),
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
