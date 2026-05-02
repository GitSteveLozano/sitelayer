/// <reference types="vitest" />
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Test config for apps/web-v2.
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
      // Vitest defaults to running in the workspace root. Pinning the
      // root keeps test discovery scoped to web-v2 even when invoked
      // from the monorepo root.
      root: fileURLToPath(new URL('.', import.meta.url)),
    },
  }),
)
