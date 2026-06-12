import type { OpsOnsiteDiagnosticSessionRecord } from '@/lib/api'

const OPS_DIAGNOSTIC_CONTROL_STORAGE_KEY = 'sitelayer.ops-diagnostic-control.v1'

export type StoredOpsDiagnosticControl = {
  session_id: string
  control_token: string
  expires_at: string
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
  const storage = sessionStorageSafe()
  if (!storage || !controlToken.trim()) return
  const payload: StoredOpsDiagnosticControl = {
    session_id: session.id,
    control_token: controlToken,
    expires_at: session.expires_at,
  }
  try {
    storage.setItem(opsDiagnosticControlStorageKey(companySlug), JSON.stringify(payload))
  } catch {
    /* storage disabled: active control remains in memory only */
  }
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
  }
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
