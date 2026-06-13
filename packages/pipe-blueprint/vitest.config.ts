import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@sitelayer/capture-schema': fileURLToPath(new URL('../capture-schema/src/index.ts', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['@sitelayer/capture-schema'],
  },
})
