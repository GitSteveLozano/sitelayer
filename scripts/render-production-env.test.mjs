import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

const script = 'scripts/render-production-env.mjs'

function runRenderer(envOverrides = {}, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'sitelayer-env-render.'))
  const output = join(dir, '.env')
  const result = spawnSync(process.execPath, [script, '--output', output, ...extraArgs], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      APP_IMAGE: 'registry.digitalocean.com/sitelayer/sitelayer:test',
      DATABASE_URL: 'postgres://user:pass@example.com:5432/sitelayer_prod',
      ALLOWED_ORIGINS: 'https://sitelayer.sandolab.xyz',
      QBO_CLIENT_ID: 'qbo-client-id',
      QBO_CLIENT_SECRET: 'qbo-client-secret',
      QBO_STATE_SECRET: 'qbo-state-secret',
      CLERK_SECRET_KEY: 'clerk-secret-key',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----',
      CLERK_ISSUER: 'https://clerk.sandolab.xyz',
      CLERK_WEBHOOK_SECRET: 'whsec_test',
      DO_SPACES_KEY: 'spaces-key',
      DO_SPACES_SECRET: 'spaces-secret',
      SENTRY_DSN: 'https://example@sentry.io/1',
      API_METRICS_TOKEN: 'metrics-token',
      ...envOverrides,
    },
    encoding: 'utf8',
  })

  const body = result.status === 0 ? readFileSync(output, 'utf8') : ''
  rmSync(dir, { recursive: true, force: true })
  return { ...result, body }
}

test('renders a quoted production dotenv file without printing values', () => {
  const result = runRenderer()

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.body, /DATABASE_URL='postgres:\/\/user:pass@example.com:5432\/sitelayer_prod'/)
  assert.match(result.body, /APP_IMAGE='registry.digitalocean.com\/sitelayer\/sitelayer:test'/)
  assert.match(result.body, /QBO_LIVE_ESTIMATE_PUSH='0'/)
  assert.match(result.body, /QBO_LIVE_RENTAL_INVOICE='0'/)
  assert.match(result.body, /NOTIFICATIONS_ENABLED='1'/)
  assert.doesNotMatch(result.stdout, /postgres:\/\/user/)
  assert.doesNotMatch(result.stdout, /metrics-token/)
})

test('turns escaped multiline secrets into compose-compatible multiline values', () => {
  const result = runRenderer()

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.body, /CLERK_JWT_KEY='-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----'/)
})

test('warns by default when required values are missing', () => {
  const result = runRenderer({ CLERK_WEBHOOK_SECRET: '' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CLERK_WEBHOOK_SECRET is missing/)
})

test('fails when enforcement is enabled and required values are missing', () => {
  const result = runRenderer({ CLERK_WEBHOOK_SECRET: '' }, ['--enforce'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Production env render failed: CLERK_WEBHOOK_SECRET/)
})
