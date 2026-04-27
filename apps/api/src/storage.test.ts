import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertKeyInCompany,
  buildBlueprintStorageKey,
  createBlueprintStorage,
  formatS3CopySource,
  getBlueprintMimeType,
  readStorageEnv,
  StorageError,
} from './storage.js'

const tempDirs: string[] = []

async function makeTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sitelayer-storage-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('blueprint storage', () => {
  it('builds company-scoped keys with sanitized filenames', () => {
    expect(buildBlueprintStorageKey('company-1', 'blueprint-1', '../bad plan.pdf')).toBe(
      'company-1/blueprint-1/bad-plan.pdf',
    )
  })

  it('rejects storage paths outside the company scope', () => {
    expect(() => assertKeyInCompany('company-1', 'company-2/blueprint-1/file.pdf')).toThrow(StorageError)
    expect(() => assertKeyInCompany('company-1', 'company-1/../file.pdf')).toThrow(StorageError)
  })

  it('reads legacy absolute local paths as company-scoped keys', () => {
    expect(assertKeyInCompany('company-1', '/app/storage/blueprints/company-1/blueprint-1/file.pdf')).toBe(
      'company-1/blueprint-1/file.pdf',
    )
  })

  it('uses local filesystem storage when Spaces credentials are missing', async () => {
    const root = await makeTempDir()
    const storage = await createBlueprintStorage(readStorageEnv({ BLUEPRINT_STORAGE_ROOT: root }, 'local'))
    await storage.put('company-1/blueprint-1/file.pdf', Buffer.from('blueprint'))
    await storage.copy('company-1/blueprint-1/file.pdf', 'company-1/blueprint-2/file.pdf')

    await expect(storage.get('company-1/blueprint-1/file.pdf')).resolves.toEqual(Buffer.from('blueprint'))
    await expect(storage.get('company-1/blueprint-2/file.pdf')).resolves.toEqual(Buffer.from('blueprint'))
  })

  it('blocks local filesystem writes outside the storage root', async () => {
    const root = await makeTempDir()
    const storage = await createBlueprintStorage(readStorageEnv({ BLUEPRINT_STORAGE_ROOT: root }, 'local'))
    await expect(storage.put('../escape.pdf', Buffer.from('bad'))).rejects.toThrow(StorageError)
  })

  it('streams multipart-style writes to the local filesystem', async () => {
    const root = await makeTempDir()
    const storage = await createBlueprintStorage(readStorageEnv({ BLUEPRINT_STORAGE_ROOT: root }, 'local'))
    const chunks = ['chunk-one ', 'chunk-two ', 'chunk-three']
    const stream = Readable.from(chunks.map((c) => Buffer.from(c)))
    await storage.putStream('company-1/blueprint-1/streamed.pdf', stream)
    await expect(storage.get('company-1/blueprint-1/streamed.pdf')).resolves.toEqual(Buffer.from(chunks.join('')))
  })

  it('returns null download urls for the local backend so the API streams bytes itself', async () => {
    const root = await makeTempDir()
    const storage = await createBlueprintStorage(readStorageEnv({ BLUEPRINT_STORAGE_ROOT: root }, 'local'))
    await expect(storage.getDownloadUrl('company-1/blueprint-1/file.pdf')).resolves.toBeNull()
  })

  it('defaults Spaces endpoint to Toronto and formats S3 copy source keys safely', () => {
    expect(readStorageEnv({}, 'prod').spacesEndpoint).toBe('https://tor1.digitaloceanspaces.com')
    expect(formatS3CopySource('bucket', 'company id/blueprint 1/file #1.pdf')).toBe(
      'bucket/company%20id/blueprint%201/file%20%231.pdf',
    )
  })

  it('requires an explicit escape hatch for local filesystem storage in prod', async () => {
    await expect(createBlueprintStorage(readStorageEnv({}, 'prod'))).rejects.toThrow(StorageError)
    await expect(
      createBlueprintStorage(readStorageEnv({ ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD: '1' }, 'prod')),
    ).resolves.toMatchObject({ backend: 'local-fs' })
  })

  it('maps common blueprint MIME types', () => {
    expect(getBlueprintMimeType('plan.pdf')).toBe('application/pdf')
    expect(getBlueprintMimeType('plan.png')).toBe('image/png')
    expect(getBlueprintMimeType('plan.jpeg')).toBe('image/jpeg')
  })
})
