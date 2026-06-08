import type { IncomingMessage } from 'node:http'
import type { Pool } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import type { Identity } from '../auth.js'
import { dispatchPlatformAdminRoutes } from './dispatch.js'

const ORIGINAL_SUPERADMIN_IDS = process.env.PLATFORM_SUPERADMIN_CLERK_IDS
const clerkAdmin: Identity = { userId: 'admin-sub', source: 'clerk' }

class FakePool {
  async query(): Promise<{ rows: unknown[] }> {
    return { rows: [] }
  }
}

function req(method: string): IncomingMessage {
  return { method } as IncomingMessage
}

function capture() {
  const calls: Array<{ status: number; body: unknown }> = []
  const sendJson = (status: number, body: unknown) => calls.push({ status, body })
  return { calls, sendJson }
}

afterEach(() => {
  if (ORIGINAL_SUPERADMIN_IDS === undefined) {
    delete process.env.PLATFORM_SUPERADMIN_CLERK_IDS
  } else {
    process.env.PLATFORM_SUPERADMIN_CLERK_IDS = ORIGINAL_SUPERADMIN_IDS
  }
})

describe('dispatchPlatformAdminRoutes', () => {
  it('handles /api/admin/* without requiring a resolved company context', async () => {
    process.env.PLATFORM_SUPERADMIN_CLERK_IDS = 'admin-sub'
    const { calls, sendJson } = capture()

    const handled = await dispatchPlatformAdminRoutes({
      req: req('GET'),
      url: new URL('http://x/api/admin/scenarios'),
      pool: new FakePool() as unknown as Pool,
      identity: clerkAdmin,
      tier: 'dev',
      sendJson,
      readBody: async () => ({}),
    })

    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(200)
    expect(Array.isArray((calls[0]?.body as { scenarios?: unknown[] }).scenarios)).toBe(true)
  })

  it('ignores non-admin paths', async () => {
    process.env.PLATFORM_SUPERADMIN_CLERK_IDS = 'admin-sub'
    const { calls, sendJson } = capture()

    const handled = await dispatchPlatformAdminRoutes({
      req: req('GET'),
      url: new URL('http://x/api/projects'),
      pool: new FakePool() as unknown as Pool,
      identity: clerkAdmin,
      tier: 'dev',
      sendJson,
      readBody: async () => ({}),
    })

    expect(handled).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
