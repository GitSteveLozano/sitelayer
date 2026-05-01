import { describe, expect, it } from 'vitest'
import { inspectEnv, validateRequiredEnvVars } from './env-validate.js'

const requiredEnv = {
  DATABASE_URL: 'postgres://sitelayer:sitelayer@db.internal:5432/sitelayer_prod',
  CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
  CLERK_ISSUER: 'https://clerk.sandolab.xyz',
  CLERK_WEBHOOK_SECRET: 'whsec_real',
  DO_SPACES_KEY: 'spaces-key',
  DO_SPACES_SECRET: 'spaces-secret',
  DO_SPACES_BUCKET: 'sitelayer-blueprints-prod',
  SENTRY_DSN: 'https://key@sentry.io/123',
}

const prodOnlyEnv = {
  QBO_CLIENT_ID: 'qbo-client-id',
  QBO_CLIENT_SECRET: 'qbo-client-secret',
  QBO_REDIRECT_URI: 'https://sitelayer.sandolab.xyz/api/integrations/qbo/callback',
  QBO_SUCCESS_REDIRECT_URI: 'https://sitelayer.sandolab.xyz/?qbo=connected',
}

function silentLogger() {
  return {
    warn: () => undefined,
    error: () => undefined,
  }
}

describe('env validation', () => {
  it('reports all required vars as errors for an empty env', () => {
    const { warnings, errors } = inspectEnv({})
    expect(warnings).toHaveLength(0)
    expect(errors.map((error) => error.var).sort()).toEqual([
      'CLERK_ISSUER',
      'CLERK_JWT_KEY',
      'CLERK_WEBHOOK_SECRET',
      'DATABASE_URL',
      'DO_SPACES_BUCKET',
      'DO_SPACES_KEY',
      'DO_SPACES_SECRET',
      'SENTRY_DSN',
    ])
    expect(errors.every((error) => error.kind === 'missing')).toBe(true)
  })

  it('returns zero errors when all always-required vars are set', () => {
    const { warnings, errors } = inspectEnv(requiredEnv)
    expect(warnings).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  it('warns when a required var is set to PLACEHOLDER', () => {
    const { warnings, errors } = inspectEnv({
      ...requiredEnv,
      SENTRY_DSN: 'PLACEHOLDER',
    })
    expect(errors).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      var: 'SENTRY_DSN',
      value: 'PLACEHOLDER',
      kind: 'sentinel_default',
    })
  })

  it('reports production-only vars as errors when NODE_ENV=production', () => {
    const { errors } = inspectEnv({
      ...requiredEnv,
      ...prodOnlyEnv,
      NODE_ENV: 'production',
      QBO_CLIENT_ID: undefined,
    })
    expect(errors.map((error) => error.var)).toEqual(['QBO_CLIENT_ID'])
  })

  it('does not require production-only vars when NODE_ENV=development', () => {
    const { warnings, errors } = inspectEnv({
      ...requiredEnv,
      NODE_ENV: 'development',
    })
    expect(warnings).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  it('throws in enforce mode when errors exist', () => {
    expect(() =>
      validateRequiredEnvVars(silentLogger(), {
        SITELAYER_ENV_ENFORCE: '1',
      }),
    ).toThrow(/Sitelayer env validation failed/)
  })

  it('calls object logger methods with the logger as this', () => {
    const calls: unknown[] = []
    const logger = {
      marker: 'bound',
      warn(this: { marker: string }, payload: unknown) {
        expect(this.marker).toBe('bound')
        calls.push(payload)
      },
    }

    validateRequiredEnvVars(logger, { ...requiredEnv, SENTRY_DSN: 'PLACEHOLDER' })

    expect(calls).toHaveLength(1)
  })
})
