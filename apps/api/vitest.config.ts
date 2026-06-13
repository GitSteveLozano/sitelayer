import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@sitelayer/config': fileURLToPath(new URL('../../packages/config/src/index.ts', import.meta.url)),
      '@sitelayer/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@sitelayer/formula-evaluator': fileURLToPath(
        new URL('../../packages/formula-evaluator/src/index.ts', import.meta.url),
      ),
      '@sitelayer/logger': fileURLToPath(new URL('../../packages/logger/src/index.ts', import.meta.url)),
      '@sitelayer/capture-schema': fileURLToPath(
        new URL('../../packages/capture-schema/src/index.ts', import.meta.url),
      ),
      '@sitelayer/pipe-blueprint': fileURLToPath(
        new URL('../../packages/pipe-blueprint/src/index.ts', import.meta.url),
      ),
      '@sitelayer/pipe-roomplan': fileURLToPath(new URL('../../packages/pipe-roomplan/src/index.ts', import.meta.url)),
      '@sitelayer/pipe-photogrammetry': fileURLToPath(
        new URL('../../packages/pipe-photogrammetry/src/index.ts', import.meta.url),
      ),
      '@sitelayer/pipe-drone': fileURLToPath(new URL('../../packages/pipe-drone/src/index.ts', import.meta.url)),
      '@sitelayer/queue': fileURLToPath(new URL('../../packages/queue/src/index.ts', import.meta.url)),
      '@sitelayer/scenario': fileURLToPath(new URL('../../packages/scenario/src/index.ts', import.meta.url)),
      '@sitelayer/workflows': fileURLToPath(new URL('../../packages/workflows/src/index.ts', import.meta.url)),
      '@sitelayer/projectkit-bridge': fileURLToPath(
        new URL('../../packages/projectkit-bridge/src/index.ts', import.meta.url),
      ),
    },
  },
  // Keep the @sitelayer/* workspace packages on the source-alias path above and
  // OUT of Vite's dep pre-bundler. Without this, the optimizer can resolve a
  // bare `@sitelayer/domain` to a STALE built `dist/index.js` (e.g. a sibling
  // worktree's node_modules symlink) that predates a newly added source module
  // — surfacing newer exports (capabilities.*) as `undefined` at module load.
  optimizeDeps: {
    exclude: [
      '@sitelayer/config',
      '@sitelayer/domain',
      '@sitelayer/formula-evaluator',
      '@sitelayer/logger',
      '@sitelayer/queue',
      '@sitelayer/capture-schema',
      '@sitelayer/pipe-blueprint',
      '@sitelayer/pipe-roomplan',
      '@sitelayer/pipe-photogrammetry',
      '@sitelayer/pipe-drone',
      '@sitelayer/scenario',
      '@sitelayer/workflows',
      '@sitelayer/projectkit-bridge',
    ],
  },
})
