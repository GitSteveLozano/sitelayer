/// <reference types="vitest" />
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Test config for apps/web.
//
// Default environment is jsdom so component render tests (mounting
// primitives, asserting on the resulting DOM) work without per-file
// pragmas. The original route-load smoke tests run cleanly in jsdom
// too — they just don't touch the document.
//
// When a future test needs node env (e.g. server-side rendering, no
// DOM globals), add `// @vitest-environment node` at the top of that
// file rather than splitting the config.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      globals: false,
      // The routes-load smoke test imports @/routes/workspace, which
      // transitively pulls the heavy desktop-v2 + three.js graph and can
      // exceed Vitest's 5000ms default under full-suite load. Bump the
      // per-test timeout so it's deterministic rather than load-flaky.
      testTimeout: 30000,
      // The merge verifier pins gates to a bounded CPU set while the full
      // workspace suite is running. Keep web's jsdom-heavy tests below that
      // ceiling so npm workspace runs do not fail from worker oversubscription.
      maxWorkers: 4,
      // Vitest defaults to running in the workspace root. Pinning the
      // root keeps test discovery scoped to web even when invoked
      // from the monorepo root.
      root: fileURLToPath(new URL('.', import.meta.url)),
    },
  }),
)
