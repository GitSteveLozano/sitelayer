export const CAPTURE_SESSION_STORAGE_KEY = 'sitelayer.capture-session'

export type CaptureSessionMode = 'trace' | 'feedback' | 'desktop' | 'native' | 'manual_upload'

export type CaptureSessionState = {
  id: string
  mode: CaptureSessionMode
  started_at: string
  consent_version?: string
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0')
}

function readState(): CaptureSessionState | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(CAPTURE_SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CaptureSessionState>
    if (typeof parsed.id !== 'string' || !parsed.id.trim()) return null
    const state: CaptureSessionState = {
      id: parsed.id,
      mode: parsed.mode ?? 'trace',
      started_at: parsed.started_at ?? new Date().toISOString(),
    }
    if (typeof parsed.consent_version === 'string') state.consent_version = parsed.consent_version
    return state
  } catch {
    return null
  }
}

function writeState(state: CaptureSessionState): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(CAPTURE_SESSION_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* storage disabled: capture remains best-effort */
  }
}

export function getActiveCaptureSession(): CaptureSessionState | null {
  return readState()
}

export function getActiveCaptureSessionId(): string | null {
  return readState()?.id ?? null
}

export function startLocalCaptureSession(args: {
  id?: string
  mode?: CaptureSessionMode
  consent_version?: string
} = {}): CaptureSessionState {
  const state: CaptureSessionState = {
    id: args.id ?? uuid(),
    mode: args.mode ?? 'trace',
    started_at: new Date().toISOString(),
  }
  if (args.consent_version) state.consent_version = args.consent_version
  writeState(state)
  return state
}

export function ensureLocalCaptureSession(args: {
  mode?: CaptureSessionMode
  consent_version?: string
} = {}): CaptureSessionState {
  const existing = readState()
  if (existing) return existing
  return startLocalCaptureSession(args)
}

export function clearLocalCaptureSession(): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(CAPTURE_SESSION_STORAGE_KEY)
  } catch {
    /* storage disabled */
  }
}

export function applyCaptureSessionHeader(headers: Headers): void {
  if (headers.has('x-sitelayer-capture-session-id')) return
  const id = getActiveCaptureSessionId()
  if (id) headers.set('x-sitelayer-capture-session-id', id)
}

export function currentCaptureRoutePath(): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.pathname}${window.location.search || ''}`.split('?')[0] ?? ''
}
