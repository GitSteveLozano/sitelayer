import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import type { ActiveCompany } from './auth-types.js'

// Stub `withMutationTx` so the helper runs its update callback without ever
// touching pg. We're testing the dispatch logic in versioned-update.ts —
// not the transaction wrapping itself, which has its own coverage path.
vi.mock('./mutation-tx.js', async () => {
  return {
    withMutationTx: vi.fn(async <T>(fn: (client: PoolClient) => Promise<T>) => {
      // Pass a sentinel PoolClient — the update callback should not exercise
      // any of its methods in these tests (it returns the row or null directly).
      return fn({} as PoolClient)
    }),
    recordMutationLedger: vi.fn(),
  }
})

import { patchVersionedEntity, deleteVersionedEntity, type VersionedUpdateCtx } from './versioned-update.js'
import * as mutationTx from './mutation-tx.js'

const company: ActiveCompany = {
  id: 'co-1',
  slug: 'la-ops',
  name: 'LA Ops',
  created_at: '2026-01-01T00:00:00Z',
  role: 'admin',
}

type CtxWithMocks = {
  ctx: VersionedUpdateCtx
  sendJson: ReturnType<typeof vi.fn>
  checkVersion: ReturnType<typeof vi.fn>
}

function makeCtx(): CtxWithMocks {
  const sendJson = vi.fn()
  const checkVersion = vi.fn()
  const ctx: VersionedUpdateCtx = {
    company,
    sendJson: (status: number, body: unknown) => sendJson(status, body),
    checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) =>
      checkVersion(table, where, params, expectedVersion) as Promise<boolean>,
  }
  return { ctx, sendJson, checkVersion }
}

describe('patchVersionedEntity', () => {
  beforeEach(() => {
    vi.mocked(mutationTx.withMutationTx).mockClear()
  })

  afterEach(() => {
    vi.mocked(mutationTx.withMutationTx).mockClear()
  })

  it('sends 200 with the updated row when the update callback returns a row', async () => {
    const { ctx, sendJson, checkVersion } = makeCtx()
    const row = { id: 'c-1', name: 'Acme', version: 5 }
    const update = vi.fn().mockResolvedValue(row)

    const result = await patchVersionedEntity({
      ctx,
      body: { expected_version: 4 },
      entityType: 'customer',
      entityName: 'customer',
      table: 'customers',
      id: 'c-1',
      update,
    })

    expect(result).toBe(true)
    expect(update).toHaveBeenCalledWith(expect.any(Object), 4)
    expect(sendJson).toHaveBeenCalledWith(200, row)
    expect(checkVersion).not.toHaveBeenCalled()
  })

  it('returns true (without sendJson 404) when checkVersion returns false (it already sent a 409)', async () => {
    const { ctx, sendJson, checkVersion } = makeCtx()
    checkVersion.mockResolvedValue(false)
    const update = vi.fn().mockResolvedValue(null)

    const result = await patchVersionedEntity({
      ctx,
      body: { expected_version: 7 },
      entityType: 'customer',
      entityName: 'customer',
      table: 'customers',
      id: 'c-1',
      update,
    })

    expect(result).toBe(true)
    expect(checkVersion).toHaveBeenCalledTimes(1)
    expect(sendJson).not.toHaveBeenCalled()
  })

  it('sends 404 when the update callback returns null and checkVersion returns true', async () => {
    const { ctx, sendJson, checkVersion } = makeCtx()
    checkVersion.mockResolvedValue(true)
    const update = vi.fn().mockResolvedValue(null)

    await patchVersionedEntity({
      ctx,
      body: {},
      entityType: 'customer',
      entityName: 'customer',
      table: 'customers',
      id: 'missing-id',
      update,
    })

    expect(checkVersion).toHaveBeenCalledWith(
      'customers',
      'company_id = $1 and id = $2 and deleted_at is null',
      ['co-1', 'missing-id'],
      null,
    )
    expect(sendJson).toHaveBeenCalledWith(404, { error: 'customer not found' })
  })

  it('parses expected_version from body.version when expected_version is absent', async () => {
    const { ctx } = makeCtx()
    const update = vi.fn().mockResolvedValue({ id: 'x', version: 2 })

    await patchVersionedEntity({
      ctx,
      body: { version: 1 },
      entityType: 'worker',
      entityName: 'worker',
      table: 'workers',
      id: 'w-1',
      update,
    })

    expect(update).toHaveBeenCalledWith(expect.any(Object), 1)
  })

  it('parses expected_version to null when both keys are missing', async () => {
    const { ctx, checkVersion } = makeCtx()
    checkVersion.mockResolvedValue(true)
    const update = vi.fn().mockResolvedValue(null)

    await patchVersionedEntity({
      ctx,
      body: {},
      entityType: 'worker',
      entityName: 'worker',
      table: 'workers',
      id: 'w-1',
      update,
    })

    expect(update).toHaveBeenCalledWith(expect.any(Object), null)
    expect(checkVersion).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Array), null)
  })

  it('honors a custom checkVersionWhere fragment when provided', async () => {
    const { ctx, checkVersion } = makeCtx()
    checkVersion.mockResolvedValue(true)
    const update = vi.fn().mockResolvedValue(null)

    await patchVersionedEntity({
      ctx,
      body: { expected_version: 3 },
      entityType: 'bonus_rule',
      entityName: 'bonus rule',
      table: 'bonus_rules',
      id: 'br-1',
      checkVersionWhere: 'company_id = $1 and id = $2',
      update,
    })

    expect(checkVersion).toHaveBeenCalledWith('bonus_rules', 'company_id = $1 and id = $2', ['co-1', 'br-1'], 3)
  })
})

describe('deleteVersionedEntity', () => {
  beforeEach(() => {
    vi.mocked(mutationTx.withMutationTx).mockClear()
  })

  it('sends 200 with the deleted row on success', async () => {
    const { ctx, sendJson } = makeCtx()
    const row = { id: 'c-1', deleted_at: '2026-01-01T00:00:00Z' }
    const del = vi.fn().mockResolvedValue(row)

    await deleteVersionedEntity({
      ctx,
      body: { expected_version: 2 },
      entityType: 'customer',
      entityName: 'customer',
      table: 'customers',
      id: 'c-1',
      delete: del,
    })

    expect(del).toHaveBeenCalledWith(expect.any(Object), 2)
    expect(sendJson).toHaveBeenCalledWith(200, row)
  })

  it('treats missing body as expectedVersion=null and still calls checkVersion on a null delete', async () => {
    const { ctx, sendJson, checkVersion } = makeCtx()
    checkVersion.mockResolvedValue(true)
    const del = vi.fn().mockResolvedValue(null)

    await deleteVersionedEntity({
      ctx,
      entityType: 'customer',
      entityName: 'customer',
      table: 'customers',
      id: 'missing',
      delete: del,
    })

    expect(del).toHaveBeenCalledWith(expect.any(Object), null)
    expect(checkVersion).toHaveBeenCalledWith(
      'customers',
      'company_id = $1 and id = $2 and deleted_at is null',
      ['co-1', 'missing'],
      null,
    )
    expect(sendJson).toHaveBeenCalledWith(404, { error: 'customer not found' })
  })

  it('returns true silently when checkVersion already sent a 409', async () => {
    const { ctx, sendJson, checkVersion } = makeCtx()
    checkVersion.mockResolvedValue(false)
    const del = vi.fn().mockResolvedValue(null)

    const result = await deleteVersionedEntity({
      ctx,
      body: { expected_version: 1 },
      entityType: 'customer',
      entityName: 'customer',
      table: 'customers',
      id: 'c-1',
      delete: del,
    })

    expect(result).toBe(true)
    expect(sendJson).not.toHaveBeenCalled()
  })
})
