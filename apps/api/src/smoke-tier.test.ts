import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Drives scripts/smoke-tier.sh against a mock of the tier API so the
 * post-deploy smoke is covered by the deterministic gate (unit stage).
 *
 * IMPORTANT: the smoke script is run with `spawnSync`, which BLOCKS this
 * thread's event loop until the script exits. So the mock API CANNOT live
 * in-process (it would never get a turn to answer curl). We run it as a
 * SEPARATE node child process, scripted by env-driven scenario knobs, and read
 * its chosen port from its stdout.
 *
 * The smoke script normally hits https://<host>/... ; we point it at the mock
 * with SMOKE_SCHEME=http and the mock's 127.0.0.1:<port> as <host>, pinning
 * SMOKE_TIER explicitly (the host has no "demo" substring).
 */

const SMOKE_SCRIPT = fileURLToPath(new URL('../../../scripts/smoke-tier.sh', import.meta.url))

// A tiny configurable mock tier-API server. Behaviour is driven entirely by
// MOCK_* env so each test scenario is just a different env set. Writes its
// listening port as `PORT=<n>` on the first stdout line.
const MOCK_SERVER_SRC = `
import http from 'node:http'
const sha = process.env.MOCK_SHA || 'abc1234'
const sessionStatus = Number(process.env.MOCK_SESSION_STATUS || '200')
const bootstrapStatus = Number(process.env.MOCK_BOOTSTRAP_STATUS || '200')
const accessCode = process.env.MOCK_ACCESS_CODE || ''
const demoMode = process.env.MOCK_DEMO_MODE || 'normal' // normal | absent
const healthStatus = Number(process.env.MOCK_HEALTH_STATUS || '200')
const server = http.createServer((req, res) => {
  const url = req.url || ''
  const json = (s, b) => { res.statusCode = s; res.setHeader('content-type','application/json'); res.end(JSON.stringify(b)) }
  if (req.method === 'GET' && url === '/health') return json(healthStatus, { ok: healthStatus === 200 })
  if (req.method === 'GET' && url === '/api/version') return json(200, { build_sha: sha })
  if (req.method === 'GET' && url === '/api/session') return json(sessionStatus, { user: {} })
  if (req.method === 'GET' && url === '/api/bootstrap') return json(bootstrapStatus, { company: {} })
  if (req.method === 'POST' && url === '/api/demo/sign-in-link') {
    if (demoMode === 'absent') return json(404, { error: 'not found' })
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let p = {}
      try { p = JSON.parse(raw || '{}') } catch { return json(400, { error: 'bad' }) }
      if (!accessCode) return json(503, { error: 'demo sign-in not configured (DEMO_ACCESS_CODE unset)' })
      if (p.accessCode !== accessCode) return json(401, { error: 'invalid access code' })
      return json(200, { role: p.role, redirect_url: 'http://x/sign-in?__clerk_ticket=t', expires_in_seconds: 86400 })
    })
    return
  }
  json(404, { error: 'not found' })
})
server.listen(0, '127.0.0.1', () => { process.stdout.write('PORT=' + server.address().port + '\\n') })
`

let tmpDir: string | null = null
function mockServerPath(): string {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'sitelayer-smoke-mock.'))
  const p = join(tmpDir, 'mock-server.mjs')
  writeFileSync(p, MOCK_SERVER_SRC)
  return p
}

type Mock = { host: string; child: ChildProcess; stop: () => void }

async function startMock(mockEnv: Record<string, string>): Promise<Mock> {
  const child = spawn(process.execPath, [mockServerPath()], {
    env: { ...process.env, ...mockEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mock server did not report a port')), 10_000)
    let buf = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const m = buf.match(/PORT=(\d+)/)
      if (m) {
        clearTimeout(t)
        resolve(Number(m[1]))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(t)
      reject(new Error(`mock server exited early (code ${code})`))
    })
  })
  return { host: `127.0.0.1:${port}`, child, stop: () => child.kill('SIGKILL') }
}

function runSmoke(
  host: string,
  args: string[],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SMOKE_SCRIPT, host, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      SMOKE_SCHEME: 'http',
      SMOKE_CURL_MAX_TIME: '10',
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('smoke-tier.sh', () => {
  let mock: Mock | null = null
  afterEach(() => {
    if (mock) mock.stop()
    mock = null
  })

  it('passes a healthy dev tier with a matching SHA', async () => {
    mock = await startMock({ MOCK_SHA: 'abc1234def' })
    const r = runSmoke(mock.host, ['abc1234def'], { SMOKE_TIER: 'dev' })
    expect(r.stdout).toContain('OK  /health 200')
    expect(r.stdout).toContain('build_sha=abc1234 matches deployed SHA')
    expect(r.stdout).toContain('OK  /api/session 200')
    expect(r.stdout).toContain('OK  /api/bootstrap 200')
    expect(r.stdout).toContain('all checks passed')
    // dev tier does NOT run the demo sign-in-link check.
    expect(r.stdout).not.toContain('/api/demo/sign-in-link')
    expect(r.code).toBe(0)
  })

  it('matches the SHA on a short-prefix basis (live sha longer than expected)', async () => {
    mock = await startMock({ MOCK_SHA: 'abc1234def5678' })
    const r = runSmoke(mock.host, ['abc1234'], { SMOKE_TIER: 'dev' })
    expect(r.stdout).toContain('matches deployed SHA')
    expect(r.code).toBe(0)
  })

  it('FAILS when /api/version build_sha does not match the deployed SHA', async () => {
    mock = await startMock({ MOCK_SHA: 'aaaaaaa' })
    const r = runSmoke(mock.host, ['bbbbbbb'], { SMOKE_TIER: 'dev' })
    expect(r.stderr).toContain('does NOT match deployed')
    expect(r.code).toBe(1)
  })

  it('FAILS when /health is not 200', async () => {
    mock = await startMock({ MOCK_HEALTH_STATUS: '503', MOCK_SHA: 'abc1234' })
    const r = runSmoke(mock.host, ['abc1234'], { SMOKE_TIER: 'dev' })
    expect(r.stderr).toContain('/health returned HTTP 503')
    expect(r.code).toBe(1)
  })

  it('accepts a 401 on /api/session + /api/bootstrap (alive but Clerk-gated)', async () => {
    mock = await startMock({ MOCK_SHA: 'abc1234', MOCK_SESSION_STATUS: '401', MOCK_BOOTSTRAP_STATUS: '401' })
    const r = runSmoke(mock.host, ['abc1234'], { SMOKE_TIER: 'dev' })
    expect(r.stdout).toContain('/api/session 401 (alive, Clerk-gated')
    expect(r.stdout).toContain('/api/bootstrap 401 (alive, Clerk-gated')
    expect(r.code).toBe(0)
  })

  it('FAILS when /api/session returns a 5xx (not alive)', async () => {
    mock = await startMock({ MOCK_SHA: 'abc1234', MOCK_SESSION_STATUS: '500' })
    const r = runSmoke(mock.host, ['abc1234'], { SMOKE_TIER: 'dev' })
    expect(r.stderr).toContain('/api/session returned HTTP 500')
    expect(r.code).toBe(1)
  })

  it('demo tier: mints a sign-in-link when DEMO_ACCESS_CODE is set', async () => {
    mock = await startMock({ MOCK_SHA: 'abc1234', MOCK_ACCESS_CODE: 'stucco-demo' })
    const r = runSmoke(mock.host, ['abc1234'], { SMOKE_TIER: 'demo', DEMO_ACCESS_CODE: 'stucco-demo' })
    expect(r.stdout).toContain('/api/demo/sign-in-link 200 (mint returned redirect_url)')
    expect(r.stdout).toContain('all checks passed')
    expect(r.code).toBe(0)
  })

  it('demo tier: skips the mint gracefully when DEMO_ACCESS_CODE is unset but route is wired (401/503)', async () => {
    // accessCode unset on server -> route answers 503 to an empty code.
    mock = await startMock({ MOCK_SHA: 'abc1234' })
    const r = runSmoke(mock.host, ['abc1234'], { SMOKE_TIER: 'demo' })
    expect(r.stdout).toContain('SKIP /api/demo/sign-in-link mint (DEMO_ACCESS_CODE unset); route wired')
    expect(r.stdout).toContain('all checks passed')
    expect(r.code).toBe(0)
  })

  it('demo tier: FAILS when the demo route is structurally absent (404)', async () => {
    mock = await startMock({ MOCK_SHA: 'abc1234', MOCK_DEMO_MODE: 'absent' })
    const r = runSmoke(mock.host, ['abc1234'], { SMOKE_TIER: 'demo' })
    expect(r.stderr).toContain('/api/demo/sign-in-link not wired')
    expect(r.code).toBe(1)
  })

  it('passes /api/version without an expected SHA (no comparison)', async () => {
    mock = await startMock({ MOCK_SHA: 'abc1234' })
    const r = runSmoke(mock.host, [], { SMOKE_TIER: 'dev' })
    expect(r.stdout).toContain('no expected SHA to compare')
    expect(r.code).toBe(0)
  })

  it('exits 2 with usage when no host is given', () => {
    const result = spawnSync('bash', [SMOKE_SCRIPT], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: scripts/smoke-tier.sh')
  })
})

process.on('exit', () => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})
