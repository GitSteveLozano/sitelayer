import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertKeyInCompany,
  buildBlueprintStorageKey,
  createBlueprintStorage,
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
    expect(buildBlueprintStorageKey('company-1', 'blueprint-1', '../bad plan.pdf')).toBe('company-1/blueprint-1/bad-plan.pdf')
  })

  it('rejects storage paths outside the company scope', () => {
    expect(() => assertKeyInCompany('company-1', 'company-2/blueprint-1/file.pdf')).toThrow(StorageError)
    expect(() => assertKeyInCompany('company-1', 'company-1/../file.pdf')).toThrow(StorageError)
  })

  it('reads legacy absolute local paths as company-scoped keys', () => {
    expect(assertKeyInCompany('company-1', '/app/storage/blueprints/company-1/blueprint-1/file.pdf')).toBe('company-1/blueprint-1/file.pdf')
  })

  it('uses local filesystem storage when Spaces credentials are missing', async () => {
    const root = await makeTempDir()
    const storage = await createBlueprintStorage(readStorageEnv({ BLUEPRINT_STORAGE_ROOT: root }, 'local'))
    await storage.put('company-1/blueprint-1/file.pdf', Buffer.from('blueprint'))
    await storage.copy('company-1/blueprint-1/file.pdf', 'company-1/blueprint-2/file.pdf')

    await expect(storage.get('company-1/blueprint-1/file.pdf')).resolves.toEqual(Buffer.from('blueprint'))
    await expect(storage.get('company-1/blueprint-2/file.pdf')).resolves.toEqual(Buffer.from('blueprint'))
  })

  it('maps common blueprint MIME types', () => {
    expect(getBlueprintMimeType('plan.pdf')).toBe('application/pdf')
    expect(getBlueprintMimeType('plan.png')).toBe('image/png')
    expect(getBlueprintMimeType('plan.jpeg')).toBe('image/jpeg')
  })
})
