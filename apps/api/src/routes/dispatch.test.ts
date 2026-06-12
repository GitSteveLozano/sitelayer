import { describe, it, expect } from 'vitest'
import { DISPATCH_ROUTE_TABLE, PLATFORM_ADMIN_ROUTE_TABLE, buildDispatchTable } from './dispatch.js'

/**
 * Route-table-identity conformance test (PROJECT_DECOMPOSITION_PLAN.md §6
 * Seam 1, §8 risk 1).
 *
 * "Earlier entries win" is load-bearing across the dispatch cascade — a
 * mis-ordered registration silently shadows routes. This snapshot freezes
 * the resolution order that existed BEFORE the registry refactor (the
 * hand-maintained array in registration order) and asserts the
 * registry-built table reproduces it EXACTLY.
 *
 * If you are adding a route: insert its name at the position where it must
 * resolve (its `order` value in dispatch.ts must sort it to the same
 * position — lower order = earlier = wins). If this test fails, the
 * registry's order numbers no longer produce the resolution order this
 * snapshot says they should — fix the order numbers, do NOT blindly
 * regenerate the snapshot.
 */
const EXPECTED_DISPATCH_ORDER: readonly string[] = [
  'platform-admin',
  'company-roles',
  'system',
  'ops-diagnostics',
  'agent-tools',
  'customers',
  'workers',
  'payment-reminders',
  'pricing-profiles',
  'pricing-overrides',
  'bonus-rules',
  'audit-events',
  'company-export',
  'dispatch-lanes',
  'audit-escrow',
  'worker-issues',
  'project-briefs',
  'capture-sessions',
  'support-packets',
  // Must precede work-requests: /api/work-requests/obstructions wins
  // against the /api/work-requests/:id detail matcher.
  'obstructions',
  'work-requests',
  'issues',
  'qbo-mappings',
  'sync',
  'qbo',
  'service-items',
  'cost-library',
  // Must precede projects: /api/projects/voice-intent* wins against the
  // project handler's GET /^\/api\/projects\/[^/]+$/ matcher.
  'voice-intent',
  'projects',
  'project-assignments',
  'material-bills',
  'takeoff-drafts',
  'takeoff-measurements',
  'takeoff-tags',
  'conditions',
  'blueprint-pages',
  'blueprint-diffs',
  'takeoff-import',
  'assemblies',
  'qbo-custom-fields',
  // Must precede the inventory catalog CRUD in rental-inventory so the
  // more-specific utilization path matches first.
  'inventory-utilization',
  'bid-accuracy',
  'ai-insights',
  'ai-chat',
  'rental-inventory',
  'scaffold-ops',
  'scaffold-tags',
  'damage-charges',
  'shipments',
  'payroll-exports',
  'customer-portal-links',
  'rental-shares-admin',
  'companycam',
  // Must precede rentals: the canonical workflow paths short-circuit the
  // generic CRUD routes.
  'rental-events',
  'rentals',
  'rental-requests',
  'schedules',
  'crew-schedule-events',
  'labor-entries',
  'clock',
  'daily-logs',
  'labor-burden',
  'time-review-runs',
  'project-lifecycle',
  'change-orders',
  'guardrails',
  'inventory-service-tickets',
  'project-billing-milestones',
  'project-lost-reasons',
  'messaging',
  'labor-payroll-runs',
  'estimate-shares-admin',
  'inventory-forecast',
  'push-subscriptions',
  'notification-preferences',
  'notifications',
  'takeoff-write',
  'estimate',
  'estimate-pushes',
  'budget',
  'workflow-event-log',
  'analytics',
  'blueprints',
  'debug-trace',
  'anchors',
]

/**
 * Same gate for the tenantless platform-admin cascade: admin-jobs and
 * platform-grants MUST precede admin, which claims the whole /api/admin/*
 * namespace and 404s unknown subpaths.
 */
const EXPECTED_PLATFORM_ADMIN_ORDER: readonly string[] = ['admin-jobs', 'platform-grants', 'admin']

describe('dispatch route table identity (Seam 1 conformance gate)', () => {
  it('reproduces the pre-registry resolution order exactly', () => {
    expect(DISPATCH_ROUTE_TABLE.map((r) => r.name)).toEqual(EXPECTED_DISPATCH_ORDER)
  })

  it('reproduces the platform-admin resolution order exactly', () => {
    expect(PLATFORM_ADMIN_ROUTE_TABLE.map((r) => r.name)).toEqual(EXPECTED_PLATFORM_ADMIN_ORDER)
  })

  it('route names are unique', () => {
    const names = DISPATCH_ROUTE_TABLE.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('order values are unique — a duplicate order is an ambiguous registration', () => {
    // Stable sort would make a tie deterministic-by-registration-position,
    // which is exactly the implicit coupling the registry exists to kill.
    // Fail loudly instead so the author picks an explicit slot.
    const orders = DISPATCH_ROUTE_TABLE.map((r) => r.order)
    expect(new Set(orders).size).toBe(orders.length)
    const adminOrders = PLATFORM_ADMIN_ROUTE_TABLE.map((r) => r.order)
    expect(new Set(adminOrders).size).toBe(adminOrders.length)
  })

  it('the assembled table is sorted ascending by order (lower order = earlier = wins)', () => {
    const orders = DISPATCH_ROUTE_TABLE.map((r) => r.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('every route has a handle function', () => {
    for (const r of [...DISPATCH_ROUTE_TABLE, ...PLATFORM_ADMIN_ROUTE_TABLE]) {
      expect(typeof r.handle, `route ${r.name}`).toBe('function')
    }
  })
})

describe('buildDispatchTable', () => {
  const noop = async () => false

  it('sorts by the explicit order field, not registration position', () => {
    const table = buildDispatchTable([
      { name: 'c', order: 30, handle: noop },
      { name: 'a', order: 10, handle: noop },
      { name: 'b', order: 20, handle: noop },
    ])
    expect(table.map((r) => r.name)).toEqual(['a', 'b', 'c'])
  })

  it('a mis-ordered registration fails the identity check loudly', () => {
    // Simulate a future agent registering a route with an order that lands
    // it BEFORE a route it must not shadow: the assembled name sequence
    // diverges from the snapshot-style expectation and the diff names the
    // offending route.
    const table = buildDispatchTable([
      { name: 'work-requests', order: 20, handle: noop },
      { name: 'obstructions', order: 30, handle: noop }, // wrong slot: must precede work-requests
    ])
    expect(table.map((r) => r.name)).not.toEqual(['obstructions', 'work-requests'])
  })

  it('is a stable sort — equal orders keep registration order', () => {
    const table = buildDispatchTable([
      { name: 'first', order: 10, handle: noop },
      { name: 'second', order: 10, handle: noop },
    ])
    expect(table.map((r) => r.name)).toEqual(['first', 'second'])
  })

  it('does not mutate the registry it is given', () => {
    const registry = [
      { name: 'b', order: 20, handle: noop },
      { name: 'a', order: 10, handle: noop },
    ]
    buildDispatchTable(registry)
    expect(registry.map((r) => r.name)).toEqual(['b', 'a'])
  })
})
