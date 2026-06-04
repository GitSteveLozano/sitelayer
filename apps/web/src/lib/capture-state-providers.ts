import { uploadCaptureArtifact, type CaptureArtifactUploadResponse } from './api/capture-sessions'

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type CaptureStateSnapshotReason =
  | 'issue_opened'
  | 'issue_submitted'
  | 'recording_stopped'
  | 'screen_recording_stopped'
  | 'clip_boundary'

export type CaptureStateProviderInput = {
  captureSessionId: string
  reason: CaptureStateSnapshotReason
  metadata: Record<string, unknown>
}

export type CaptureStateProviderSnapshot = {
  schema: string
  payload: unknown
  kind?: 'state_snapshot' | 'screen_context'
  piiLevel?: 'low' | 'internal' | 'private' | 'restricted'
  metadata?: Record<string, unknown>
}

export type CaptureStateProvider = (
  input: CaptureStateProviderInput,
) => CaptureStateProviderSnapshot | null | Promise<CaptureStateProviderSnapshot | null>

export type CaptureStateProviderUploadResult = {
  id: string
  status: 'uploaded' | 'skipped' | 'failed'
  artifact?: CaptureArtifactUploadResponse
  error?: string
}

export type CaptureStateProviderUploadOptions = {
  reason: CaptureStateSnapshotReason
  metadata?: Record<string, unknown>
  upload?: typeof uploadCaptureArtifact
}

const MAX_STRING_LENGTH = 10_000
const MAX_JSON_DEPTH = 8
const SENSITIVE_KEYS = new Set([
  'access_token',
  'authorization',
  'cookie',
  'csrf',
  'password',
  'refresh_token',
  'secret',
  'session_token',
  'storage_key',
  'token',
])

const providers = new Map<string, CaptureStateProvider>()

export function registerCaptureStateProvider(id: string, provider: CaptureStateProvider): () => void {
  providers.set(id, provider)
  return () => {
    if (providers.get(id) === provider) providers.delete(id)
  }
}

export async function uploadRegisteredCaptureStateSnapshots(
  captureSessionId: string,
  options: CaptureStateProviderUploadOptions,
): Promise<CaptureStateProviderUploadResult[]> {
  const entries = Array.from(providers.entries())
  const upload = options.upload ?? uploadCaptureArtifact
  const results: CaptureStateProviderUploadResult[] = []
  for (const [id, provider] of entries) {
    try {
      const snapshot = await provider({
        captureSessionId,
        reason: options.reason,
        metadata: options.metadata ?? {},
      })
      if (!snapshot) {
        results.push({ id, status: 'skipped' })
        continue
      }
      const artifact = await upload(captureSessionId, {
        kind: snapshot.kind ?? 'state_snapshot',
        file: stateSnapshotBlob(id, options.reason, snapshot),
        fileName: `${safeFilePart(id)}-${snapshot.kind ?? 'state_snapshot'}.json`,
        pii_level: snapshot.piiLevel ?? 'internal',
        access_policy: 'support_only',
        metadata: {
          ...(options.metadata ?? {}),
          ...(snapshot.metadata ?? {}),
          source: 'capture_state_provider',
          artifact_type: `capture.${snapshot.kind ?? 'state_snapshot'}`,
          provider_id: id,
          reason: options.reason,
          schema: snapshot.schema,
        },
      })
      results.push({ id, status: 'uploaded', artifact })
    } catch (error) {
      results.push({
        id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export function __resetCaptureStateProvidersForTests(): void {
  providers.clear()
}

function stateSnapshotBlob(
  providerId: string,
  reason: CaptureStateSnapshotReason,
  snapshot: CaptureStateProviderSnapshot,
): Blob {
  return new Blob(
    [
      JSON.stringify({
        schema_version: 1,
        artifact_type: `capture.${snapshot.kind ?? 'state_snapshot'}`,
        captured_at: new Date().toISOString(),
        provider_id: providerId,
        reason,
        schema: snapshot.schema,
        payload: sanitizeJsonValue(snapshot.payload, 0, new WeakSet<object>()) ?? null,
      }),
    ],
    { type: 'application/json' },
  )
}

function sanitizeJsonValue(value: unknown, depth: number, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return sanitizeString(value)
  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH) return []
    return value
      .map((entry) => sanitizeJsonValue(entry, depth + 1, seen))
      .filter((entry): entry is JsonValue => entry !== undefined)
  }
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return undefined
  if (depth >= MAX_JSON_DEPTH) return {}
  seen.add(value)
  const out: JsonObject = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) continue
    const sanitized = sanitizeJsonValue(entry, depth + 1, seen)
    if (sanitized !== undefined) out[key] = sanitized
  }
  seen.delete(value)
  return out
}

function sanitizeString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value
}

function safeFilePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
