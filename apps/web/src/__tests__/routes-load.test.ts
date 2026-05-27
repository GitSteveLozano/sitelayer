import { describe, expect, test } from 'vitest'

// Smoke-load every top-level lazy route registered in App.tsx. The point is
// not to verify behavior -- it's to catch broken imports, missing exports,
// and accidental top-level throws before they reach the prod bundle. The
// post-cutover polish queue had several "looks fine in PR, breaks in prod"
// regressions that these would have caught at PR time.
//
// When adding a new top-level route to App.tsx, add it here too.

const ROUTES: ReadonlyArray<readonly [string, () => Promise<{ default: unknown }>]> = [
  ['workspace', () => import('@/routes/workspace')],
  ['more', () => import('@/routes/more')],
  ['live-crew', () => import('@/routes/live-crew')],
  ['bid-accuracy', () => import('@/routes/bid-accuracy')],
  ['financial', () => import('@/routes/financial')],
  ['onboarding', () => import('@/routes/onboarding')],
  ['permissions-location', () => import('@/routes/permissions-location')],
  ['permissions-notifications', () => import('@/routes/permissions-notifications')],
]

describe('apps/web lazy routes', () => {
  test.each(ROUTES)('%s route module exposes a default React component', async (_name, importFn) => {
    const mod = await importFn()
    expect(mod.default).toBeDefined()
    expect(typeof mod.default).toBe('function')
  })
})

// Full-screen screen routes mounted in App.tsx via a named export (not a
// routes/* default). Same intent: catch broken imports / missing exports for
// reachable top-level routes before they hit prod.
describe('apps/web full-screen route screens', () => {
  test('scaffold designer screen (/scaffold-designer) loads and exports its component', async () => {
    const mod = await import('@/screens/scaffold/scaffold-designer')
    expect(typeof mod.ScaffoldDesignerScreen).toBe('function')
  })

  test('project BOMs screen (/projects/:id/boms) loads and exports its component', async () => {
    const mod = await import('@/screens/scaffold/project-boms')
    expect(typeof mod.ProjectBomsScreen).toBe('function')
  })
})
