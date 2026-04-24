import { describe, expect, it } from 'vitest'
import { createLogger, getRequestContext, runWithRequestContext } from './index.js'

describe('request context', () => {
  it('scopes context to the callback', () => {
    expect(getRequestContext()).toBeUndefined()

    const result = runWithRequestContext({ requestId: 'req_1', companySlug: 'acme' }, () => {
      expect(getRequestContext()).toMatchObject({ requestId: 'req_1', companySlug: 'acme' })
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(getRequestContext()).toBeUndefined()
  })
})

describe('createLogger', () => {
  it('adds service bindings', () => {
    const logger = createLogger('api', { enabled: false })

    expect(logger.bindings()).toMatchObject({ service: 'api' })
  })
})
