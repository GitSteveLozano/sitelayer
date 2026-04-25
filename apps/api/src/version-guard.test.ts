import { describe, expect, it, vi } from 'vitest'
import { assertVersion, type VersionGuardPool, type VersionGuardResponder } from './version-guard.js'

function makeRes() {
  const writeHead = vi.fn<VersionGuardResponder['writeHead']>()
  const end = vi.fn<VersionGuardResponder['end']>()
  // Cast through unknown — we only consume the two methods the guard uses.
  return { writeHead, end } as unknown as VersionGuardResponder & {
    writeHead: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
}

function makePool(versions: Array<number | string>): VersionGuardPool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: versions.map((version) => ({ version })) }))
  return { query }
}

describe('assertVersion', () => {
  it('passes through when expectedVersion is null without querying the pool', async () => {
    const pool = makePool([])
    const res = makeRes()
    const ok = await assertVersion(pool, 'pricing_profiles', 'company_id = $1 and id = $2', ['c1', 'p1'], null, res)
    expect(ok).toBe(true)
    expect(pool.query).not.toHaveBeenCalled()
    expect(res.writeHead).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  it('passes through when the row is missing (handler is responsible for 404)', async () => {
    const pool = makePool([])
    const res = makeRes()
    const ok = await assertVersion(pool, 'pricing_profiles', 'company_id = $1 and id = $2', ['c1', 'p1'], 3, res)
    expect(ok).toBe(true)
    expect(pool.query).toHaveBeenCalledWith('select version from pricing_profiles where company_id = $1 and id = $2', [
      'c1',
      'p1',
    ])
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('passes through when the version matches', async () => {
    const pool = makePool([5])
    const res = makeRes()
    const ok = await assertVersion(pool, 'projects', 'company_id = $1 and id = $2', ['c1', 'p1'], 5, res)
    expect(ok).toBe(true)
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('coerces string versions before comparing', async () => {
    const pool = makePool(['7'])
    const res = makeRes()
    const ok = await assertVersion(pool, 'projects', 'company_id = $1 and id = $2', ['c1', 'p1'], 7, res)
    expect(ok).toBe(true)
  })

  it('emits a 409 with current_version when versions differ', async () => {
    const pool = makePool([4])
    const res = makeRes()
    const ok = await assertVersion(pool, 'rentals', 'company_id = $1 and id = $2', ['c1', 'r1'], 3, res)
    expect(ok).toBe(false)
    expect(res.writeHead).toHaveBeenCalledTimes(1)
    expect(res.writeHead).toHaveBeenCalledWith(409, expect.objectContaining({ 'content-type': expect.any(String) }))
    expect(res.end).toHaveBeenCalledTimes(1)
    const endMock = res.end as ReturnType<typeof vi.fn>
    const firstCall = endMock.mock.calls[0]
    if (!firstCall) throw new Error('expected end() to be called')
    const body = JSON.parse(String(firstCall[0]))
    expect(body).toEqual({ error: 'version conflict', current_version: 4 })
  })

  it('routes the 409 through a custom sendJson when provided', async () => {
    const pool = makePool([10])
    const res = makeRes()
    const sendJson = vi.fn()
    const ok = await assertVersion(pool, 'rentals', 'company_id = $1 and id = $2', ['c1', 'r1'], 9, res, { sendJson })
    expect(ok).toBe(false)
    expect(sendJson).toHaveBeenCalledWith(res, 409, { error: 'version conflict', current_version: 10 })
    expect(res.writeHead).not.toHaveBeenCalled()
  })
})
