/// <reference types="vitest" />
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Test config for apps/web. Mirrors apps/web-v2 so future component tests
// have a DOM available without per-file pragmas.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      globals: false,
      root: fileURLToPath(new URL('.', import.meta.url)),
    },
  }),
)
