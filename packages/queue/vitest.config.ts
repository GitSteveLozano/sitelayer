import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@sitelayer/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
    },
  },
})
