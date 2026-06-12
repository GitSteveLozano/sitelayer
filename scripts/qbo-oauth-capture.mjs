#!/usr/bin/env node
// One-shot QBO OAuth capture — replaces the Intuit OAuth Playground.
//
// Why: the Playground requires driving developer.intuit.com by hand and
// copy-pasting a refresh token that rotates on every exchange. The grant
// itself is plain OAuth2 authorization_code against a localhost redirect
// (QBO_REDIRECT_URI is registered as
// http://localhost:3001/api/integrations/qbo/callback), so everything except
// the human sign-in is scriptable:
//
//   1. prints the appcenter.intuit.com authorize URL (operator clicks it,
//      signs in with the sandbox owner, approves once);
//   2. listens on the registered localhost redirect and catches
//      ?code=&realmId=;
//   3. exchanges the code for tokens at oauth.platform.intuit.com;
//   4. writes QBO_SANDBOX_REFRESH_TOKEN + QBO_SANDBOX_REALM_ID into the env
//      file IN PLACE (never prints either).
//
// Usage:
//   node scripts/qbo-oauth-capture.mjs [--env-file .env.local]
//
// Reads QBO_SANDBOX_CLIENT_ID / QBO_SANDBOX_CLIENT_SECRET / QBO_REDIRECT_URI
// from the env file (or process env). Exits 0 on success — then run
// `QBO_SMOKE_ENV_FILE=.env.local bash scripts/qbo-sandbox-smoke.sh`.
// The local api must NOT be running (this script owns port 3001 briefly).

import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const envFileArg = process.argv.indexOf('--env-file')
const ENV_FILE = envFileArg !== -1 ? process.argv[envFileArg + 1] : '.env.local'

function readEnvFile(path) {
  const out = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^(?:export )?([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m) out[m[1]] = m[2]
    }
  } catch {
    /* fall through to process.env */
  }
  return out
}

const fileEnv = readEnvFile(ENV_FILE)
const env = (k) => process.env[k] ?? fileEnv[k]

const CLIENT_ID = env('QBO_SANDBOX_CLIENT_ID') ?? env('QBO_CLIENT_ID')
const CLIENT_SECRET = env('QBO_SANDBOX_CLIENT_SECRET') ?? env('QBO_CLIENT_SECRET')
const REDIRECT_URI = env('QBO_REDIRECT_URI') ?? 'http://localhost:3001/api/integrations/qbo/callback'
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`FAIL: QBO_SANDBOX_CLIENT_ID / QBO_SANDBOX_CLIENT_SECRET not found (env or ${ENV_FILE})`)
  process.exit(1)
}

const url = new URL(REDIRECT_URI)
const PORT = Number(url.port || 80)
const CALLBACK_PATH = url.pathname
const STATE = randomBytes(16).toString('hex')

const authorizeUrl =
  'https://appcenter.intuit.com/connect/oauth2' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  '&response_type=code' +
  '&scope=com.intuit.quickbooks.accounting' +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&state=${STATE}`

console.log('[qbo-oauth-capture] listening on', REDIRECT_URI)
console.log('[qbo-oauth-capture] OPEN THIS URL and sign in with the sandbox owner:')
console.log(authorizeUrl)

const server = createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`)
  if (reqUrl.pathname !== CALLBACK_PATH) {
    res.writeHead(404).end('not the callback path')
    return
  }
  const code = reqUrl.searchParams.get('code')
  const realmId = reqUrl.searchParams.get('realmId')
  const state = reqUrl.searchParams.get('state')
  if (!code || state !== STATE) {
    res.writeHead(400).end('missing code or state mismatch — re-run the script')
    return
  }
  try {
    const tokenResp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    })
    const body = await tokenResp.json()
    if (!tokenResp.ok || !body.refresh_token) {
      console.error('[qbo-oauth-capture] FAIL: token exchange', tokenResp.status, JSON.stringify(body).slice(0, 200))
      res.writeHead(500).end('token exchange failed — see terminal')
      server.close()
      process.exit(2)
    }
    // Update the env file in place; never print token values.
    let content = readFileSync(ENV_FILE, 'utf8')
    const setVar = (k, v) => {
      const re = new RegExp(`^((?:export )?${k})=.*$`, 'm')
      content = re.test(content) ? content.replace(re, `$1=${v}`) : content + `\n${k}=${v}\n`
    }
    setVar('QBO_SANDBOX_REFRESH_TOKEN', body.refresh_token)
    if (realmId) setVar('QBO_SANDBOX_REALM_ID', realmId)
    writeFileSync(ENV_FILE, content, { mode: 0o600 })
    console.log(`[qbo-oauth-capture] OK: refresh token${realmId ? ' + realm ' + realmId : ''} written to ${ENV_FILE}`)
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end('<h2>QBO sandbox connected — tokens captured. You can close this tab.</h2>')
    setTimeout(() => {
      server.close()
      process.exit(0)
    }, 200)
  } catch (err) {
    console.error('[qbo-oauth-capture] FAIL:', err?.message ?? err)
    res.writeHead(500).end('exchange error — see terminal')
    server.close()
    process.exit(2)
  }
})
server.listen(PORT, '127.0.0.1')
// Give the operator 30 minutes, then give up so the port is freed.
setTimeout(() => {
  console.error('[qbo-oauth-capture] TIMEOUT: no callback within 30min')
  server.close()
  process.exit(3)
}, 30 * 60_000).unref()
