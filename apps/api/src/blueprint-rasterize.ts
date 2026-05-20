import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const rasterizeWaiters: Array<() => void> = []
let activeRasterizers = 0

export type PdfPageRasterizer = (pdfBytes: Buffer, options?: PdfPageRasterizeOptions) => Promise<Buffer>

export interface PdfPageRasterizeOptions {
  pageNumber?: number
  dpi?: number
  timeoutMs?: number
}

export class BlueprintRasterizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlueprintRasterizeError'
  }
}

async function acquireRasterizeSlot(): Promise<() => void> {
  const rawLimit = Number(process.env.BLUEPRINT_RASTERIZE_CONCURRENCY ?? '1')
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 1
  if (activeRasterizers < limit) {
    activeRasterizers += 1
    return releaseRasterizeSlot
  }
  await new Promise<void>((resolve) => rasterizeWaiters.push(resolve))
  activeRasterizers += 1
  return releaseRasterizeSlot
}

function releaseRasterizeSlot(): void {
  activeRasterizers = Math.max(0, activeRasterizers - 1)
  rasterizeWaiters.shift()?.()
}

export async function rasterizePdfPageToPng(
  pdfBytes: Buffer,
  { pageNumber = 1, dpi = 144, timeoutMs = 20_000 }: PdfPageRasterizeOptions = {},
): Promise<Buffer> {
  if (!pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new BlueprintRasterizeError('blueprint file is not a PDF')
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new BlueprintRasterizeError('pageNumber must be an integer >= 1')
  }
  if (!Number.isFinite(dpi) || dpi < 36 || dpi > 300) {
    throw new BlueprintRasterizeError('dpi must be between 36 and 300')
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'sitelayer-blueprint-raster-'))
  const inputPath = path.join(dir, 'source.pdf')
  const outputPrefix = path.join(dir, 'page')
  const outputPath = `${outputPrefix}.png`
  const releaseSlot = await acquireRasterizeSlot()
  try {
    await writeFile(inputPath, pdfBytes)
    await execFileAsync(
      'pdftoppm',
      [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
        '-png',
        '-r',
        String(dpi),
        inputPath,
        outputPrefix,
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    )
    return await readFile(outputPath)
  } catch (err) {
    if (err instanceof BlueprintRasterizeError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new BlueprintRasterizeError(`failed to rasterize blueprint PDF page ${pageNumber}: ${message}`)
  } finally {
    releaseSlot()
    await rm(dir, { recursive: true, force: true })
  }
}
