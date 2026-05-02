/// <reference types="vitest" />
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Smoke-test config for apps/web-v2.
//
// The goal at this stage is narrow: catch broken imports, missing exports,
// and accidental top-level-throw regressions across the lazy route bundle.
// We deliberately don't pull in jsdom or @testing-library here — the
// route modules are pure ESM, and module-load tests already trip on the
// regressions we've actually been seeing in post-cutover polish PRs (e.g.
// undefined token references through eager imports). When a future PR
// needs to render trees, switch `environment` to `jsdom` and add the
// testing-library deps.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}'],
      globals: false,
      // Vitest defaults to running in the workspace root. Pinning the
      // root keeps test discovery scoped to web-v2 even when invoked
      // from the monorepo root.
      root: fileURLToPath(new URL('.', import.meta.url)),
    },
  }),
)
