import type { OpsOnsiteDiagnosticSessionRecord } from '@/lib/api'

const OPS_DIAGNOSTIC_CONTROL_STORAGE_KEY = 'sitelayer.ops-diagnostic-control.v1'
const OPS_DIAGNOSTIC_CONTROL_FRAGMENT_KEY = 'ops_control'

export type StoredOpsDiagnosticControl = {
  session_id: string
  control_token: string
  expires_at: string
  company_slug?: string
}

export type OpsDiagnosticControlTransfer = {
  session_id: string
  transfer_token: string
  expires_at: string
  company_slug?: string
}

export function readOpsDiagnosticControl(companySlug: string, nowMs = Date.now()): StoredOpsDiagnosticControl | null {
  const storage = sessionStorageSafe()
  if (!storage) return null
  const key = opsDiagnosticControlStorageKey(companySlug)
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  const parsed = parseStoredOpsDiagnosticControl(raw)
  if (!parsed) {
    clearOpsDiagnosticControl(companySlug)
    return null
  }
  if (Date.parse(parsed.expires_at) <= nowMs) {
    clearOpsDiagnosticControl(companySlug)
    return null
  }
  return parsed
}

export function persistOpsDiagnosticControl(
  companySlug: string,
  session: OpsOnsiteDiagnosticSessionRecord,
  controlToken: string,
): void {
  writeOpsDiagnosticControl(companySlug, {
    session_id: session.id,
    control_token: controlToken,
    expires_at: session.expires_at,
  })
}

export function clearOpsDiagnosticControl(companySlug: string): void {
  const storage = sessionStorageSafe()
  if (!storage) return
  try {
    storage.removeItem(opsDiagnosticControlStorageKey(companySlug))
  } catch {
    /* storage disabled */
  }
}

export function createOpsDiagnosticControlTransferUrl(
  companySlug: string,
  session: OpsOnsiteDiagnosticSessionRecord,
  transferToken: string,
  href: string = currentHref(),
): string | null {
  if (!transferToken.trim()) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const params = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
  params.set(
    OPS_DIAGNOSTIC_CONTROL_FRAGMENT_KEY,
    encodeTransferPayload({
      session_id: session.id,
      transfer_token: transferToken,
      expires_at: session.expires_at,
      company_slug: companySlug,
    }),
  )
  url.hash = params.toString()
  return url.toString()
}

export function importOpsDiagnosticControlFromUrl(
  companySlug: string,
  nowMs = Date.now(),
  href: string = currentHref(),
  stripFragment = true,
): OpsDiagnosticControlTransfer | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const params = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
  const raw = params.get(OPS_DIAGNOSTIC_CONTROL_FRAGMENT_KEY)
  if (!raw) return null
  const parsed = parseOpsDiagnosticControlTransfer(decodeTransferPayload(raw))
  if (stripFragment) stripControlFragment(url, params)
  if (!parsed) return null
  if (parsed.company_slug && parsed.company_slug !== companySlug) return null
  if (Date.parse(parsed.expires_at) <= nowMs) return null
  return parsed
}

function writeOpsDiagnosticControl(companySlug: string, control: StoredOpsDiagnosticControl): void {
  const storage = sessionStorageSafe()
  if (!storage || !control.control_token.trim()) return
  try {
    storage.setItem(opsDiagnosticControlStorageKey(companySlug), JSON.stringify(control))
  } catch {
    /* storage disabled: active control remains in memory only */
  }
}

function encodeTransferPayload(payload: OpsDiagnosticControlTransfer): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeTransferPayload(raw: string): string | null {
  try {
    const base64 = raw
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(raw.length / 4) * 4, '=')
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function parseOpsDiagnosticControlTransfer(raw: string | null): OpsDiagnosticControlTransfer | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Partial<OpsDiagnosticControlTransfer>
  if (!candidate.session_id?.trim() || !candidate.transfer_token?.trim() || !candidate.expires_at?.trim()) return null
  if (Number.isNaN(Date.parse(candidate.expires_at))) return null
  return {
    session_id: candidate.session_id,
    transfer_token: candidate.transfer_token,
    expires_at: candidate.expires_at,
    ...(candidate.company_slug?.trim() ? { company_slug: candidate.company_slug } : {}),
  }
}

function parseStoredOpsDiagnosticControl(raw: string | null): StoredOpsDiagnosticControl | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Partial<StoredOpsDiagnosticControl>
  if (!candidate.session_id?.trim() || !candidate.control_token?.trim() || !candidate.expires_at?.trim()) return null
  if (Number.isNaN(Date.parse(candidate.expires_at))) return null
  return {
    session_id: candidate.session_id,
    control_token: candidate.control_token,
    expires_at: candidate.expires_at,
    ...(candidate.company_slug?.trim() ? { company_slug: candidate.company_slug } : {}),
  }
}

function stripControlFragment(url: URL, params: URLSearchParams): void {
  if (typeof window === 'undefined') return
  params.delete(OPS_DIAGNOSTIC_CONTROL_FRAGMENT_KEY)
  const hash = params.toString()
  const next = `${url.pathname}${url.search}${hash ? `#${hash}` : ''}`
  try {
    window.history.replaceState(window.history.state, '', next)
  } catch {
    /* navigation history unavailable */
  }
}

function currentHref(): string {
  if (typeof window === 'undefined') return 'http://localhost/'
  return window.location.href
}

function opsDiagnosticControlStorageKey(companySlug: string): string {
  return `${OPS_DIAGNOSTIC_CONTROL_STORAGE_KEY}:${encodeURIComponent(companySlug || 'default')}`
}

function sessionStorageSafe(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}
