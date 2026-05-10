/**
 * Thin Luma 3D Capture API client.
 *
 * Notes on endpoint shape: the Luma 3D Capture API is sparsely documented
 * publicly (the Python SDK was archived 2024-09-18; docs.lumalabs.ai now
 * focuses on Dream Machine). The shape below is reverse-engineered from the
 * archived `lumaapi-python` README and what the REST docs do hint at:
 *
 *   - Auth header: `Authorization: luma-api-key=<key>` (per the Python client docs).
 *   - Submit:  POST `/api/v1/capture`            multipart with `file` + `title`.
 *              → returns `{ slug }`.
 *   - Status:  GET  `/api/v1/capture/{slug}`     → returns `{ slug, status, artifacts: [{type,url}] }`.
 *
 * If the real shape diverges, only this module needs to change. The unit test
 * mocks `fetch` so we don't depend on the real API at test time.
 *
 * See packages/pipe-photogrammetry/NOTES.md for full assumption log.
 */

const LUMA_API_BASE = 'https://webapp.lumalabs.ai'

export interface LumaSubmission {
  jobId: string
  status: 'queued' | 'processing' | 'succeeded' | 'failed'
  meshUrl?: string
  previewImageUrl?: string
}

export interface SubmitVideoToLumaOpts {
  videoPath: string
  apiKey: string
  title?: string
  /** Override the API base URL (test injection). */
  baseUrl?: string
  /** Override the fetch implementation (test injection). */
  fetchImpl?: typeof fetch
  /** Override File construction so tests don't need to read the disk. */
  fileLoader?: (path: string) => Promise<Blob | File>
}

export interface PollLumaJobOpts {
  jobId: string
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

interface LumaCaptureSubmitResponse {
  slug?: string
  status?: string
}

interface LumaCaptureArtifact {
  type: string
  url: string
}

interface LumaCaptureStatusResponse {
  slug?: string
  status?: string
  artifacts?: LumaCaptureArtifact[]
}

function authHeaders(apiKey: string): Record<string, string> {
  // Per the archived lumaapi-python client docs, auth is:
  // `Authorization: luma-api-key=<key>`
  return {
    Authorization: `luma-api-key=${apiKey}`,
  }
}

function mapLumaStatus(raw: string | undefined): LumaSubmission['status'] {
  // The archived Python client documents two enums, depending on object kind:
  //   capture.status: NEW | UPLOADING | COMPLETE
  //   run.status:     NEW | DISPATCHED | FAILED | FINISHED
  // We collapse both to our 4-state shape.
  switch ((raw ?? '').toUpperCase()) {
    case 'FINISHED':
    case 'COMPLETE':
    case 'SUCCEEDED':
      return 'succeeded'
    case 'FAILED':
    case 'ERROR':
      return 'failed'
    case 'DISPATCHED':
    case 'PROCESSING':
    case 'UPLOADING':
      return 'processing'
    case 'NEW':
    case 'QUEUED':
    default:
      return 'queued'
  }
}

function pickArtifactUrls(artifacts: LumaCaptureArtifact[] | undefined): {
  meshUrl?: string
  previewImageUrl?: string
} {
  if (!artifacts || artifacts.length === 0) return {}
  const meshTypes = new Set(['mesh', 'obj', 'glb', 'gltf', 'usdz', 'textured_mesh'])
  const previewTypes = new Set(['preview', 'thumbnail', 'preview_image', 'image'])
  let meshUrl: string | undefined
  let previewImageUrl: string | undefined
  for (const a of artifacts) {
    const t = (a.type ?? '').toLowerCase()
    if (!meshUrl && meshTypes.has(t)) meshUrl = a.url
    if (!previewImageUrl && previewTypes.has(t)) previewImageUrl = a.url
  }
  // Fallback: if no preview but the mesh is a .glb/.usdz/.obj URL, leave it.
  return { meshUrl, previewImageUrl }
}

async function defaultFileLoader(videoPath: string): Promise<Blob> {
  const { readFile } = await import('node:fs/promises')
  const buf = await readFile(videoPath)
  return new Blob([buf], { type: 'video/mp4' })
}

export async function submitVideoToLuma(opts: SubmitVideoToLumaOpts): Promise<LumaSubmission> {
  const baseUrl = opts.baseUrl ?? LUMA_API_BASE
  const doFetch = opts.fetchImpl ?? fetch
  const loader = opts.fileLoader ?? defaultFileLoader

  const body = new FormData()
  const blob = await loader(opts.videoPath)
  // Some File implementations require a name; provide one.
  const filename = opts.videoPath.split('/').pop() ?? 'video.mp4'
  body.append('file', blob, filename)
  body.append('title', opts.title ?? filename)

  const res = await doFetch(`${baseUrl}/api/v1/capture`, {
    method: 'POST',
    headers: authHeaders(opts.apiKey),
    body,
  })
  if (!res.ok) {
    throw new Error(`Luma submit failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as LumaCaptureSubmitResponse
  if (!json.slug) {
    throw new Error("Luma submit response missing 'slug'")
  }
  return {
    jobId: json.slug,
    status: mapLumaStatus(json.status),
  }
}

export async function pollLumaJob(opts: PollLumaJobOpts): Promise<LumaSubmission> {
  const baseUrl = opts.baseUrl ?? LUMA_API_BASE
  const doFetch = opts.fetchImpl ?? fetch

  const res = await doFetch(`${baseUrl}/api/v1/capture/${encodeURIComponent(opts.jobId)}`, {
    method: 'GET',
    headers: authHeaders(opts.apiKey),
  })
  if (!res.ok) {
    throw new Error(`Luma poll failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as LumaCaptureStatusResponse
  const { meshUrl, previewImageUrl } = pickArtifactUrls(json.artifacts)
  return {
    jobId: json.slug ?? opts.jobId,
    status: mapLumaStatus(json.status),
    ...(meshUrl !== undefined ? { meshUrl } : {}),
    ...(previewImageUrl !== undefined ? { previewImageUrl } : {}),
  }
}
