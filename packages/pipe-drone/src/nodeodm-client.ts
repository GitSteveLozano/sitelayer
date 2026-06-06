// NodeODM REST API client.
//
// Reference: https://github.com/OpenDroneMap/NodeODM/blob/master/docs/swagger.json
//
// Workflow:
//   1. POST /task/new/init      → uuid
//   2. POST /task/new/upload/:uuid (per image, multipart)
//   3. POST /task/new/commit/:uuid
//   4. GET  /task/:uuid/info    → { status: { code, errorMessage }, progress }
//   5. GET  /task/:uuid/download/:asset → binary
//
// Status codes per ODM:
//   10 queued, 20 running, 30 failed, 40 completed, 50 canceled.

import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename } from 'node:path'

export const NODEODM_STATUS = {
  QUEUED: 10,
  RUNNING: 20,
  FAILED: 30,
  COMPLETED: 40,
  CANCELED: 50,
} as const

export type NodeOdmStatusCode = (typeof NODEODM_STATUS)[keyof typeof NODEODM_STATUS]

export interface NodeOdmTaskInfo {
  uuid: string
  status: { code: number; errorMessage?: string }
  progress: number
}

export interface NodeOdmCreateTaskOptions {
  nodeOdmUrl: string
}

export interface NodeOdmUploadImageOptions {
  nodeOdmUrl: string
  uuid: string
  imagePath: string
  filename: string
}

export interface NodeOdmCommitTaskOptions {
  nodeOdmUrl: string
  uuid: string
}

export interface NodeOdmGetInfoOptions {
  nodeOdmUrl: string
  uuid: string
}

export type NodeOdmAsset =
  | 'all'
  | 'orthophoto.tif'
  | 'dsm.tif'
  | 'dtm.tif'
  | 'point_cloud.laz'
  | 'georeferenced_model.laz'

export interface NodeOdmDownloadAssetOptions {
  nodeOdmUrl: string
  uuid: string
  asset: NodeOdmAsset
  outPath: string
}

export interface NodeOdmWaitOptions {
  nodeOdmUrl: string
  uuid: string
  pollIntervalMs?: number
  timeoutMs?: number
}

export type NodeOdmWaitResult =
  | { status: 'completed' }
  | { status: 'failed'; errorMessage?: string }
  | { status: 'timeout' }
  | { status: 'canceled'; errorMessage?: string }

function trimUrl(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u
}

/** POST /task/new/init — returns { uuid }. */
export async function nodeOdmCreateTask(opts: NodeOdmCreateTaskOptions): Promise<{ uuid: string }> {
  const url = `${trimUrl(opts.nodeOdmUrl)}/task/new/init`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`nodeOdmCreateTask failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as { uuid?: string; error?: string }
  if (!json.uuid) {
    throw new Error(`nodeOdmCreateTask: missing uuid in response: ${JSON.stringify(json)}`)
  }
  return { uuid: json.uuid }
}

/** POST /task/new/upload/:uuid — multipart/form-data with `images` field. */
export async function nodeOdmUploadImage(opts: NodeOdmUploadImageOptions): Promise<void> {
  const url = `${trimUrl(opts.nodeOdmUrl)}/task/new/upload/${opts.uuid}`
  const stats = await stat(opts.imagePath)
  if (!stats.isFile()) {
    throw new Error(`nodeOdmUploadImage: ${opts.imagePath} is not a file`)
  }
  const stream = createReadStream(opts.imagePath)
  // Convert Node Readable → Web ReadableStream for fetch body+File.
  // Node's `stream/web.ReadableStream` and the DOM `ReadableStream`
  // global are nominally distinct types even though they share the
  // runtime shape; the single cast bridges the two.
  const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>
  const blob = await new Response(webStream).blob()
  const form = new FormData()
  form.append('images', blob, opts.filename || basename(opts.imagePath))
  const res = await fetch(url, { method: 'POST', body: form })
  if (!res.ok) {
    throw new Error(`nodeOdmUploadImage failed: ${res.status} ${res.statusText}`)
  }
}

/** POST /task/new/commit/:uuid — finalises and queues the task. */
export async function nodeOdmCommitTask(opts: NodeOdmCommitTaskOptions): Promise<void> {
  const url = `${trimUrl(opts.nodeOdmUrl)}/task/new/commit/${opts.uuid}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`nodeOdmCommitTask failed: ${res.status} ${res.statusText}`)
  }
}

/** GET /task/:uuid/info. */
export async function nodeOdmGetInfo(opts: NodeOdmGetInfoOptions): Promise<NodeOdmTaskInfo> {
  const url = `${trimUrl(opts.nodeOdmUrl)}/task/${opts.uuid}/info`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`nodeOdmGetInfo failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const uuid = typeof json.uuid === 'string' ? json.uuid : opts.uuid
  const statusRaw = (json.status ?? {}) as Record<string, unknown>
  const code = typeof statusRaw.code === 'number' ? statusRaw.code : -1
  const errorMessage = typeof statusRaw.errorMessage === 'string' ? statusRaw.errorMessage : undefined
  const progress = typeof json.progress === 'number' ? json.progress : 0
  return {
    uuid,
    status: errorMessage ? { code, errorMessage } : { code },
    progress,
  }
}

/** GET /task/:uuid/download/:asset — streams to outPath. */
export async function nodeOdmDownloadAsset(opts: NodeOdmDownloadAssetOptions): Promise<void> {
  const url = `${trimUrl(opts.nodeOdmUrl)}/task/${opts.uuid}/download/${opts.asset}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`nodeOdmDownloadAsset(${opts.asset}) failed: ${res.status} ${res.statusText}`)
  }
  if (!res.body) {
    throw new Error(`nodeOdmDownloadAsset(${opts.asset}) returned no body`)
  }
  const sink = createWriteStream(opts.outPath)
  // Web ReadableStream → Node Readable. `res.body` is the DOM
  // ReadableStream and `Readable.fromWeb` wants the structurally
  // identical `node:stream/web.ReadableStream`; the single cast bridges
  // the two.
  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
  await pipeline(nodeStream, sink)
}

/** Poll until terminal status or timeout. Default poll 10s, timeout 4 hours. */
export async function nodeOdmWaitForCompletion(opts: NodeOdmWaitOptions): Promise<NodeOdmWaitResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000
  const timeoutMs = opts.timeoutMs ?? 4 * 60 * 60 * 1000
  const startedAt = Date.now()
  while (true) {
    const info = await nodeOdmGetInfo({
      nodeOdmUrl: opts.nodeOdmUrl,
      uuid: opts.uuid,
    })
    const code = info.status.code
    if (code === NODEODM_STATUS.COMPLETED) {
      return { status: 'completed' }
    }
    if (code === NODEODM_STATUS.FAILED) {
      return info.status.errorMessage
        ? { status: 'failed', errorMessage: info.status.errorMessage }
        : { status: 'failed' }
    }
    if (code === NODEODM_STATUS.CANCELED) {
      return info.status.errorMessage
        ? { status: 'canceled', errorMessage: info.status.errorMessage }
        : { status: 'canceled' }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { status: 'timeout' }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}
