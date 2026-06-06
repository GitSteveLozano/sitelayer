#!/usr/bin/env -S npx tsx
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type JsonRecord = Record<string, unknown>

type ArtifactRef = {
  kind: string
  uri: string
  content_type?: string
  pii_level: string
  access_policy: string
  metadata: JsonRecord
}

type EventRef = {
  event_type: string
  note: string
}

type UploadRef = {
  kind: string
  file_path: string
  content_type: string
  pii_level: string
  access_policy: string
  metadata: JsonRecord
}

type Args = {
  apiUrl: string
  authToken: string
  companySlug: string
  captureSessionId: string
  mode: string
  routePath: string
  deviceKind: string
  platform: string
  viewport: string
  consentVersion: string
  source: string
  title: string | null
  summary: string | null
  category: string
  lane: string
  severity: string
  piiLevel: string
  accessPolicy: string
  metadata: JsonRecord
  artifacts: ArtifactRef[]
  uploads: UploadRef[]
  events: EventRef[]
  finalize: boolean
  allowProd: boolean
}

const MODES = new Set(['feedback', 'desktop', 'native', 'manual_upload'])
const LANES = new Set(['triage', 'human', 'agent', 'both', 'done'])
const SEVERITIES = new Set(['low', 'normal', 'high', 'urgent'])
const PII_LEVELS = new Set(['low', 'internal', 'private', 'restricted'])
const ACCESS_POLICIES = new Set(['support_only', 'operator_only', 'tenant_visible'])

function usage() {
  console.log(`Usage:
  SITELAYER_API_URL=http://localhost:3001 \\
  SITELAYER_AUTH_TOKEN=e2e-admin \\
  npm run capture:reference -- \\
    --source steve_browser_bridge \\
    --browser-trace-id operator-trace:... \\
    --recording-uri /tmp/steve-meet.mp4 \\
    --transcript-file /tmp/steve-transcript.txt \\
    --note "Verify Scale did nothing on the takeoff canvas"

Creates a capture session for external/operator evidence that was not recorded
inside the Sitelayer web recorder. It appends URI-only artifacts, uploads local
artifact files when provided, writes operator events, then finalizes into the
same support packet/context work-item pipeline.

Required env:
  SITELAYER_API_URL
  SITELAYER_AUTH_TOKEN or SITELAYER_TOKEN

Common options:
  --capture-session-id UUID         default: random UUID
  --mode manual_upload|desktop|feedback|native
                                  default: manual_upload
  --source TEXT                    default: capture_reference_cli
  --route-path PATH                default: /capture/reference
  --title TEXT
  --summary TEXT
  --category TEXT                  default: capture_reference
  --lane triage|human|agent|both|done
                                  default: triage
  --severity low|normal|high|urgent
                                  default: normal
  --note TEXT                      repeatable; creates operator.note events
  --event TYPE=TEXT                repeatable; creates custom note events
  --artifact KIND=URI_OR_PATH      repeatable; attaches URI-only artifact
  --browser-trace-id ID            attaches browser_bridge_trace reference
  --browser-trace-uri URI          attaches browser_bridge_trace reference
  --recording-uri URI_OR_PATH      attaches video reference
  --audio-uri URI_OR_PATH          attaches audio reference
  --transcript-uri URI_OR_PATH     attaches transcript reference
  --context-uri URI_OR_PATH        attaches context reference
  --recording-file FILE            uploads video bytes as a stored artifact
  --audio-file FILE                uploads audio bytes as a stored artifact
  --transcript-file FILE           uploads transcript bytes as a stored artifact
  --context-file FILE              uploads context bytes as a stored artifact
  --upload-file KIND=FILE          repeatable; uploads local bytes as artifact
  --metadata-json JSON             merged into capture session metadata
  --pii-level low|internal|private|restricted
                                  default: private
  --access-policy support_only|operator_only|tenant_visible
                                  default: support_only
  --no-finalize                    leave session open after attaching evidence
  --allow-prod                     allow production API target

URI options convert local filesystem paths to file:// references and do not
upload bytes. File options upload local bytes through the normal capture artifact
storage path so export/reviewer jobs can inspect them later.`)
}

function parseArgs(argv: string[]): Args {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    process.exit(0)
  }

  const artifacts: ArtifactRef[] = []
  const uploads: UploadRef[] = []
  const events: EventRef[] = []
  const metadata: JsonRecord = {}
  let source = 'capture_reference_cli'
  let piiLevel = 'private'
  let accessPolicy = 'support_only'
  let mode = process.env.CAPTURE_REFERENCE_MODE ?? 'manual_upload'
  let finalize = true
  let allowProd = process.env.ALLOW_PROD_CAPTURE_REFERENCE === '1'

  const args: Args = {
    apiUrl: process.env.SITELAYER_API_URL ?? '',
    authToken: process.env.SITELAYER_AUTH_TOKEN ?? process.env.SITELAYER_TOKEN ?? '',
    companySlug: process.env.SITELAYER_COMPANY_SLUG ?? '',
    captureSessionId: process.env.CAPTURE_SESSION_ID ?? randomUUID(),
    mode,
    routePath: process.env.CAPTURE_REFERENCE_ROUTE_PATH ?? '/capture/reference',
    deviceKind: process.env.CAPTURE_REFERENCE_DEVICE_KIND ?? 'desktop',
    platform: process.env.CAPTURE_REFERENCE_PLATFORM ?? 'capture-reference-cli',
    viewport: process.env.CAPTURE_REFERENCE_VIEWPORT ?? 'external-reference',
    consentVersion: process.env.CAPTURE_REFERENCE_CONSENT_VERSION ?? 'capture-reference-v1',
    source,
    title: process.env.CAPTURE_REFERENCE_TITLE ?? null,
    summary: process.env.CAPTURE_REFERENCE_SUMMARY ?? null,
    category: process.env.CAPTURE_REFERENCE_CATEGORY ?? 'capture_reference',
    lane: process.env.CAPTURE_REFERENCE_LANE ?? 'triage',
    severity: process.env.CAPTURE_REFERENCE_SEVERITY ?? 'normal',
    piiLevel,
    accessPolicy,
    metadata,
    artifacts,
    uploads,
    events,
    finalize,
    allowProd,
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--api-url':
        args.apiUrl = requiredValue(argv, ++i, flag)
        break
      case '--auth-token':
        args.authToken = requiredValue(argv, ++i, flag)
        break
      case '--company-slug':
        args.companySlug = requiredValue(argv, ++i, flag)
        break
      case '--capture-session-id':
        args.captureSessionId = requiredValue(argv, ++i, flag)
        break
      case '--mode':
        mode = requiredValue(argv, ++i, flag)
        args.mode = mode
        break
      case '--route-path':
        args.routePath = requiredValue(argv, ++i, flag)
        break
      case '--device-kind':
        args.deviceKind = requiredValue(argv, ++i, flag)
        break
      case '--platform':
        args.platform = requiredValue(argv, ++i, flag)
        break
      case '--viewport':
        args.viewport = requiredValue(argv, ++i, flag)
        break
      case '--consent-version':
        args.consentVersion = requiredValue(argv, ++i, flag)
        break
      case '--source':
        source = requiredValue(argv, ++i, flag)
        args.source = source
        break
      case '--title':
        args.title = requiredValue(argv, ++i, flag)
        break
      case '--summary':
        args.summary = requiredValue(argv, ++i, flag)
        break
      case '--category':
        args.category = requiredValue(argv, ++i, flag)
        break
      case '--lane':
        args.lane = requiredValue(argv, ++i, flag)
        break
      case '--severity':
        args.severity = requiredValue(argv, ++i, flag)
        break
      case '--pii-level':
        piiLevel = requiredValue(argv, ++i, flag)
        args.piiLevel = piiLevel
        break
      case '--access-policy':
        accessPolicy = requiredValue(argv, ++i, flag)
        args.accessPolicy = accessPolicy
        break
      case '--metadata-json':
        Object.assign(metadata, parseJsonObject(requiredValue(argv, ++i, flag), flag))
        break
      case '--artifact':
        artifacts.push(parseArtifactSpec(requiredValue(argv, ++i, flag), args))
        break
      case '--browser-trace-id':
        artifacts.push(
          buildArtifact(
            'browser_bridge_trace',
            `browser-bridge://trace/${encodeURIComponent(requiredValue(argv, ++i, flag))}`,
            args,
            {
              reference_type: 'browser_bridge_trace_id',
            },
          ),
        )
        break
      case '--browser-trace-uri':
        artifacts.push(
          buildArtifact('browser_bridge_trace', normalizeReferenceUri(requiredValue(argv, ++i, flag)), args, {
            reference_type: 'browser_bridge_trace_uri',
          }),
        )
        break
      case '--recording-uri':
        artifacts.push(
          buildArtifact('video', normalizeReferenceUri(requiredValue(argv, ++i, flag)), args, {
            reference_type: 'external_recording',
          }),
        )
        break
      case '--audio-uri':
        artifacts.push(
          buildArtifact('audio', normalizeReferenceUri(requiredValue(argv, ++i, flag)), args, {
            reference_type: 'external_audio',
          }),
        )
        break
      case '--transcript-uri':
        artifacts.push(
          buildArtifact('transcript', normalizeReferenceUri(requiredValue(argv, ++i, flag)), args, {
            reference_type: 'external_transcript',
          }),
        )
        break
      case '--context-uri':
        artifacts.push(
          buildArtifact('context', normalizeReferenceUri(requiredValue(argv, ++i, flag)), args, {
            reference_type: 'external_context',
          }),
        )
        break
      case '--recording-file':
        uploads.push(
          buildUpload('video', requiredValue(argv, ++i, flag), args, {
            reference_type: 'uploaded_recording',
          }),
        )
        break
      case '--audio-file':
        uploads.push(
          buildUpload('audio', requiredValue(argv, ++i, flag), args, {
            reference_type: 'uploaded_audio',
          }),
        )
        break
      case '--transcript-file':
        uploads.push(
          buildUpload('transcript', requiredValue(argv, ++i, flag), args, {
            reference_type: 'uploaded_transcript',
          }),
        )
        break
      case '--context-file':
        uploads.push(
          buildUpload('context', requiredValue(argv, ++i, flag), args, {
            reference_type: 'uploaded_context',
          }),
        )
        break
      case '--upload-file':
        uploads.push(parseUploadSpec(requiredValue(argv, ++i, flag), args))
        break
      case '--note':
        events.push({ event_type: 'operator.note', note: requiredValue(argv, ++i, flag) })
        break
      case '--event':
        events.push(parseEventSpec(requiredValue(argv, ++i, flag)))
        break
      case '--no-finalize':
        finalize = false
        args.finalize = false
        break
      case '--allow-prod':
        allowProd = true
        args.allowProd = true
        break
      default:
        throw new Error(`Unknown argument: ${flag}`)
    }
  }

  args.mode = mode
  args.source = source
  args.piiLevel = piiLevel
  args.accessPolicy = accessPolicy
  args.finalize = finalize
  args.allowProd = allowProd

  if (!args.apiUrl.trim()) throw new Error('Missing SITELAYER_API_URL or --api-url')
  if (!args.authToken.trim()) throw new Error('Missing SITELAYER_AUTH_TOKEN, SITELAYER_TOKEN, or --auth-token')
  if (!args.companySlug.trim()) {
    args.companySlug = args.authToken.startsWith('e2e-') ? 'e2e-fixtures' : 'la-operations'
  }
  assertAllowed(args.mode, MODES, 'mode')
  assertAllowed(args.lane, LANES, 'lane')
  assertAllowed(args.severity, SEVERITIES, 'severity')
  assertAllowed(args.piiLevel, PII_LEVELS, 'pii-level')
  assertAllowed(args.accessPolicy, ACCESS_POLICIES, 'access-policy')
  if (args.artifacts.length === 0 && args.uploads.length === 0 && args.events.length === 0) {
    throw new Error(
      'Add at least one --artifact/--browser-trace-id/--recording-uri/--transcript-uri/--recording-file/--transcript-file/--note',
    )
  }
  return args
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
  return value
}

function parseJsonObject(value: string, flag: string): JsonRecord {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`)
  }
  return parsed as JsonRecord
}

function parseArtifactSpec(spec: string, args: Args): ArtifactRef {
  const idx = spec.indexOf('=')
  if (idx <= 0) throw new Error(`Invalid --artifact "${spec}"; expected KIND=URI_OR_PATH`)
  const kind = spec.slice(0, idx).trim()
  const uri = spec.slice(idx + 1).trim()
  if (!kind || !uri) throw new Error(`Invalid --artifact "${spec}"; expected KIND=URI_OR_PATH`)
  return buildArtifact(kind, normalizeReferenceUri(uri), args, { reference_type: 'custom_artifact' })
}

function parseUploadSpec(spec: string, args: Args): UploadRef {
  const idx = spec.indexOf('=')
  if (idx <= 0) throw new Error(`Invalid --upload-file "${spec}"; expected KIND=FILE`)
  const kind = spec.slice(0, idx).trim()
  const filePath = spec.slice(idx + 1).trim()
  if (!kind || !filePath) throw new Error(`Invalid --upload-file "${spec}"; expected KIND=FILE`)
  return buildUpload(kind, filePath, args, { reference_type: 'custom_upload' })
}

function parseEventSpec(spec: string): EventRef {
  const idx = spec.indexOf('=')
  if (idx <= 0) throw new Error(`Invalid --event "${spec}"; expected TYPE=TEXT`)
  const eventType = spec.slice(0, idx).trim()
  const note = spec.slice(idx + 1).trim()
  if (!eventType || !note) throw new Error(`Invalid --event "${spec}"; expected TYPE=TEXT`)
  return { event_type: eventType, note }
}

function buildUpload(kind: string, filePath: string, args: Args, metadata: JsonRecord): UploadRef {
  const resolved = path.resolve(filePath)
  return {
    kind,
    file_path: resolved,
    content_type: inferUploadContentType(kind, resolved),
    pii_level: args.piiLevel,
    access_policy: args.accessPolicy,
    metadata: {
      source: args.source,
      created_by: 'scripts/create-capture-reference.ts',
      local_file_name: path.basename(resolved),
      local_file_reference: pathToFileURL(resolved).toString(),
      ...metadata,
    },
  }
}

function buildArtifact(kind: string, uri: string, args: Args, metadata: JsonRecord): ArtifactRef {
  const referenceHash = `sha256:${createHash('sha256').update(`${kind}\n${uri}`).digest('hex')}`
  return {
    kind,
    uri,
    content_type: inferContentType(kind, uri),
    pii_level: args.piiLevel,
    access_policy: args.accessPolicy,
    metadata: {
      source: args.source,
      created_by: 'scripts/create-capture-reference.ts',
      reference_hash: referenceHash,
      ...metadata,
    },
  }
}

function normalizeReferenceUri(value: string): string {
  const trimmed = value.trim()
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return trimmed
  return pathToFileURL(path.resolve(trimmed)).toString()
}

function inferUploadContentType(kind: string, filePath: string): string {
  const normalizedKind = kind.toLowerCase()
  const ext = path.extname(filePath).toLowerCase()
  if (normalizedKind.includes('transcript') || ext === '.txt' || ext === '.log') return 'text/plain'
  if (ext === '.md') return 'text/markdown'
  if (ext === '.json' || normalizedKind.includes('rrweb') || normalizedKind.includes('json')) return 'application/json'
  if (ext === '.mp4' || ext === '.m4v') return normalizedKind.includes('audio') ? 'audio/mp4' : 'video/mp4'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.webm') return normalizedKind.includes('video') ? 'video/webm' : 'audio/webm'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg'
  if (normalizedKind.includes('video')) return 'video/mp4'
  if (normalizedKind.includes('audio')) return 'audio/webm'
  if (normalizedKind.includes('context')) return 'text/plain'
  return 'application/octet-stream'
}

function inferContentType(kind: string, uri: string): string | undefined {
  const normalizedKind = kind.toLowerCase()
  const normalizedUri = uri.toLowerCase()
  if (normalizedKind.includes('browser_bridge_trace')) return 'application/vnd.sitelayer.browser-bridge-trace-ref+json'
  if (normalizedKind.includes('transcript') || normalizedKind.includes('note')) return 'text/plain'
  if (normalizedKind.includes('rrweb') || normalizedKind.includes('json') || normalizedUri.endsWith('.json')) {
    return 'application/json'
  }
  if (normalizedKind.includes('audio') || /\.(wav|mp3|m4a|aac|ogg|webm)(\?|#|$)/.test(normalizedUri)) return 'audio/*'
  if (normalizedKind.includes('video') || /\.(mp4|mov|m4v|webm|mkv)(\?|#|$)/.test(normalizedUri)) return 'video/*'
  if (normalizedKind.includes('context') || normalizedUri.endsWith('.md') || normalizedUri.endsWith('.txt'))
    return 'text/plain'
  return undefined
}

function assertAllowed(value: string, allowed: Set<string>, name: string) {
  if (!allowed.has(value)) throw new Error(`${name} must be one of ${Array.from(allowed).join(', ')}`)
}

function authHeaders(args: Args, json = true): Record<string, string> {
  const headers: Record<string, string> = {
    'x-sitelayer-company-slug': args.companySlug,
  }
  if (json) headers['content-type'] = 'application/json'
  if (args.authToken.startsWith('e2e-') || args.authToken.length < 50) {
    headers['x-sitelayer-act-as'] = args.authToken
  } else {
    headers.authorization = `Bearer ${args.authToken}`
  }
  return headers
}

function safeApiUrl(raw: string, allowProd: boolean): string {
  const url = raw.trim().replace(/\/+$/, '')
  if ((url === 'https://sitelayer.sandolab.xyz' || url === 'http://sitelayer.sandolab.xyz') && !allowProd) {
    throw new Error('Refusing production target without --allow-prod or ALLOW_PROD_CAPTURE_REFERENCE=1')
  }
  return url
}

async function httpJson(args: Args, method: string, pathname: string, body?: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(`${args.apiUrl}${pathname}`, {
    method,
    headers: authHeaders(args),
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let parsed: unknown = {}
  if (text.trim()) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${JSON.stringify(parsed)}`)
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : { value: parsed }
}

async function httpMultipartUpload(args: Args, upload: UploadRef): Promise<JsonRecord> {
  const bytes = await readFile(upload.file_path)
  const form = new FormData()
  form.set('kind', upload.kind)
  form.set('pii_level', upload.pii_level)
  form.set('access_policy', upload.access_policy)
  form.set('metadata', JSON.stringify(upload.metadata))
  form.set('file', new Blob([new Uint8Array(bytes)], { type: upload.content_type }), path.basename(upload.file_path))

  const response = await fetch(`${args.apiUrl}/api/capture-sessions/${args.captureSessionId}/artifacts/upload`, {
    method: 'POST',
    headers: authHeaders(args, false),
    body: form,
  })
  const text = await response.text()
  let parsed: unknown = {}
  if (text.trim()) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
  }
  if (!response.ok) {
    throw new Error(`upload ${upload.kind} returned HTTP ${response.status}: ${JSON.stringify(parsed)}`)
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : { value: parsed }
}

function buildStartBody(args: Args): JsonRecord {
  return {
    capture_session_id: args.captureSessionId,
    mode: args.mode,
    consent_version: args.consentVersion,
    route_path: args.routePath,
    device_kind: args.deviceKind,
    platform: args.platform,
    viewport: args.viewport,
    metadata: {
      ...args.metadata,
      source: args.source,
      created_by: 'scripts/create-capture-reference.ts',
      reference_artifact_count: args.artifacts.length,
      uploaded_artifact_count: args.uploads.length,
      reference_event_count: args.events.length,
    },
    consent_scope: {
      reference_only: true,
      streams: Array.from(
        new Set([...args.artifacts.map((artifact) => artifact.kind), ...args.uploads.map((upload) => upload.kind)]),
      ),
      event_types: Array.from(new Set(args.events.map((event) => event.event_type))),
      route_path: args.routePath,
    },
  }
}

function buildEventsBody(args: Args): JsonRecord {
  const started = {
    event_type: 'operator.reference_session_created',
    event_class: 'operator',
    client_event_id: `capture-reference:${args.captureSessionId}:created`,
    seq: 0,
    route_path: args.routePath,
    workflow_id: 'capture_reference',
    entity_type: 'capture_session',
    entity_id: args.captureSessionId,
    payload: {
      source: args.source,
      artifact_count: args.artifacts.length,
      uploaded_artifact_count: args.uploads.length,
      note_count: args.events.length,
    },
  }
  const notes = args.events.map((event, index) => ({
    event_type: event.event_type,
    event_class: event.event_type.startsWith('operator.') ? 'operator' : 'reference',
    client_event_id: `capture-reference:${args.captureSessionId}:event:${index + 1}:${hashForId(event.note)}`,
    seq: index + 1,
    route_path: args.routePath,
    workflow_id: 'capture_reference',
    entity_type: 'capture_session',
    entity_id: args.captureSessionId,
    payload: {
      source: args.source,
      note: event.note,
    },
  }))
  return { events: [started, ...notes] }
}

function hashForId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function buildArtifactsBody(args: Args): JsonRecord {
  return {
    artifacts: args.artifacts.map((artifact) => ({
      kind: artifact.kind,
      uri: artifact.uri,
      content_type: artifact.content_type,
      pii_level: artifact.pii_level,
      access_policy: artifact.access_policy,
      metadata: artifact.metadata,
    })),
  }
}

function buildFinalizeBody(args: Args): JsonRecord {
  const artifactSummary = args.artifacts.map((artifact) => `${artifact.kind}:${artifact.uri}`).slice(0, 8)
  return {
    title: args.title ?? `Review external capture references from ${args.source}`,
    summary:
      args.summary ??
      [
        `External/operator evidence was attached to capture session ${args.captureSessionId}.`,
        `${args.artifacts.length} reference artifact(s), ${args.uploads.length} stored artifact(s), and ${args.events.length} operator note event(s) were recorded.`,
        artifactSummary.length ? `References: ${artifactSummary.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    lane: args.lane,
    severity: args.severity,
    route_path: args.routePath,
    category: args.category,
    client_request_id: `capture-reference:${args.captureSessionId}`,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  args.apiUrl = safeApiUrl(args.apiUrl, args.allowProd)

  const start = await httpJson(args, 'POST', '/api/capture-sessions', buildStartBody(args))
  const events = await httpJson(
    args,
    'POST',
    `/api/capture-sessions/${args.captureSessionId}/events`,
    buildEventsBody(args),
  )
  const artifacts =
    args.artifacts.length > 0
      ? await httpJson(
          args,
          'POST',
          `/api/capture-sessions/${args.captureSessionId}/artifacts`,
          buildArtifactsBody(args),
        )
      : { accepted: 0 }
  const uploadedArtifacts = []
  for (const upload of args.uploads) {
    uploadedArtifacts.push(await httpMultipartUpload(args, upload))
  }
  const finalized = args.finalize
    ? await httpJson(args, 'POST', `/api/capture-sessions/${args.captureSessionId}/finalize`, buildFinalizeBody(args))
    : null

  console.log(
    JSON.stringify(
      {
        capture_session_id: args.captureSessionId,
        mode: args.mode,
        source: args.source,
        route_path: args.routePath,
        started: Boolean(start.capture_session),
        accepted_events: events.accepted ?? null,
        accepted_artifacts: artifacts.accepted ?? null,
        uploaded_artifacts: uploadedArtifacts.map((result) => result.artifact ?? null).filter(Boolean),
        finalized: Boolean(finalized),
        work_item_id:
          finalized && typeof finalized.work_item === 'object' ? (finalized.work_item as JsonRecord).id : null,
        support_packet_id:
          finalized && typeof finalized.support_packet === 'object'
            ? (finalized.support_packet as JsonRecord).id
            : null,
        artifact_refs: args.artifacts.map((artifact) => ({
          kind: artifact.kind,
          uri: artifact.uri,
          content_type: artifact.content_type ?? null,
          reference_hash: artifact.metadata.reference_hash,
        })),
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
