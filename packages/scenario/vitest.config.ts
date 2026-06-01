import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// Alias @sitelayer/* to their `src` entrypoints so tests run against source
// (no dist build required) — mirrors apps/api/vitest.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      '@sitelayer/workflows': fileURLToPath(new URL('../../packages/workflows/src/index.ts', import.meta.url)),
    },
  },
})
