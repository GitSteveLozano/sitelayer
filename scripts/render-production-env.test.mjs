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

test('renders optional context work dispatch configuration when provided', () => {
  const result = runRenderer({
    MESH_WORK_REQUEST_DISPATCH_URL: 'http://mesh-hetzner:8713/api/orchestrate/tasks',
    MESH_WORK_REQUEST_DISPATCH_TOKEN: 'mesh-work-secret',
    SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN: 'legacy-callback-secret',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.body, /MESH_WORK_REQUEST_DISPATCH_URL='http:\/\/mesh-hetzner:8713\/api\/orchestrate\/tasks'/)
  assert.match(result.body, /MESH_WORK_REQUEST_DISPATCH_TOKEN='mesh-work-secret'/)
  assert.match(result.body, /SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN='legacy-callback-secret'/)
  assert.match(result.body, /WORK_REQUEST_REVIEW_STALE_HOURS='48'/)
  assert.match(result.body, /WORK_REQUEST_AGENT_STALE_HOURS='24'/)
  assert.doesNotMatch(result.stdout, /mesh-work-secret/)
  assert.doesNotMatch(result.stdout, /legacy-callback-secret/)
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
