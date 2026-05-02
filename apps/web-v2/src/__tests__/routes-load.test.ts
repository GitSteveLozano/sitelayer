import { describe, expect, test } from 'vitest'

// Smoke-load every top-level lazy route registered in App.tsx. The point is
// not to verify behavior — it's to catch broken imports, missing exports,
// and accidental top-level throws before they reach the prod bundle. The
// post-cutover polish queue had several "looks fine in PR, breaks in prod"
// regressions that these would have caught at PR time.
//
// When adding a new top-level route to App.tsx, add it here too.

const ROUTES: ReadonlyArray<readonly [string, () => Promise<{ default: unknown }>]> = [
  ['home', () => import('@/routes/home')],
  ['projects', () => import('@/routes/projects')],
  ['time', () => import('@/routes/time')],
  ['rentals', () => import('@/routes/rentals')],
  ['more', () => import('@/routes/more')],
  ['log', () => import('@/routes/log')],
  ['schedule', () => import('@/routes/schedule')],
  ['live-crew', () => import('@/routes/live-crew')],
  ['bid-accuracy', () => import('@/routes/bid-accuracy')],
  ['financial', () => import('@/routes/financial')],
  ['onboarding', () => import('@/routes/onboarding')],
]

describe('apps/web-v2 lazy routes', () => {
  test.each(ROUTES)('%s route module exposes a default React component', async (_name, importFn) => {
    const mod = await importFn()
    expect(mod.default).toBeDefined()
    expect(typeof mod.default).toBe('function')
  })
})
