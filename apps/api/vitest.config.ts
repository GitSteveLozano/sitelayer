import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@sitelayer/config': fileURLToPath(new URL('../../packages/config/src/index.ts', import.meta.url)),
      '@sitelayer/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@sitelayer/queue': fileURLToPath(new URL('../../packages/queue/src/index.ts', import.meta.url)),
    },
  },
})
