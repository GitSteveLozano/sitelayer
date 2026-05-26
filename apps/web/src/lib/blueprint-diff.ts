/**
 * Client-side raster diff for blueprint revisions.
 *
 * This module implements approach #2 (live, the default path used by the
 * revision-compare surface): it loads the "before" + "after" page images
 * onto an offscreen canvas, computes a per-pixel difference, and produces
 * a red/blue highlight overlay the estimator can render over the page.
 *
 * Approach #1 (server-side stored diffs from `blueprint_page_diffs`,
 * migration 037) is the optional, not-yet-wired alternative: the migration
 * and table exist, but no API route serves those rows yet, so nothing reads
 * the stored diffs today. Wiring that endpoint is a follow-on; until then
 * the client-side raster diff below is the shipped behavior.
 *
 * Color convention (matches the design handoff for the picker):
 *   - RED   = content that exists in BEFORE but is gone/faded in AFTER
 *             (removed / lightened).
 *   - BLUE  = content that exists in AFTER but was not in BEFORE
 *             (added / darkened).
 *
 * Blueprints are predominantly white sheets with dark linework, so we use
 * perceived luminance as the comparison signal: a pixel that got darker
 * between revisions gained ink (added → blue); a pixel that got lighter
 * lost ink (removed → red). This is robust to the slight antialiasing
 * noise that a naive RGB delta would flag everywhere.
 */

export type DiffMode = 'overlay' | 'side-by-side' | 'difference'

export interface DiffResult {
  /** Composited overlay (transparent except changed pixels) as a data URL. */
  overlayDataUrl: string
  /** Pure difference view (changes on a neutral backdrop) as a data URL. */
  differenceDataUrl: string
  width: number
  height: number
  /** Fraction of compared pixels flagged as changed (0..1). */
  changedFraction: number
  addedPixels: number
  removedPixels: number
}

/** Max working dimension; large blueprint rasters are downsampled to cap CPU/memory. */
const MAX_DIM = 1400
/** Luminance delta (0..255) below which a pixel is treated as unchanged. */
const DEFAULT_THRESHOLD = 28

function perceivedLuminance(r: number, g: number, b: number): number {
  // Rec. 601 luma — cheap and adequate for ink-on-white linework.
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Object URLs are same-origin; crossOrigin keeps canvas untainted if a
    // future caller passes a remote URL.
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load revision image'))
    img.src = url
  })
}

function fitDimensions(w: number, h: number): { width: number; height: number } {
  const longest = Math.max(w, h)
  if (longest <= MAX_DIM) return { width: w, height: h }
  const scale = MAX_DIM / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

function drawToCanvas(img: HTMLImageElement, width: number, height: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  // White backdrop so transparent PNG/source regions read as "sheet", not black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height)
}

export interface ComputeDiffOptions {
  /** Luminance delta threshold (0..255). Lower = more sensitive. */
  threshold?: number
}

/**
 * Compute a raster diff between two already-loaded image URLs (object URLs
 * from `useAuthenticatedObjectUrl` work directly). Both images are scaled
 * to a shared working canvas sized to the *after* image's aspect; the
 * before image is stretched to match so per-pixel comparison aligns even
 * when revisions were re-exported at slightly different resolutions.
 */
export async function computeRasterDiff(
  beforeUrl: string,
  afterUrl: string,
  opts: ComputeDiffOptions = {},
): Promise<DiffResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const [beforeImg, afterImg] = await Promise.all([loadImage(beforeUrl), loadImage(afterUrl)])

  const { width, height } = fitDimensions(
    afterImg.naturalWidth || afterImg.width,
    afterImg.naturalHeight || afterImg.height,
  )
  if (width === 0 || height === 0) {
    throw new Error('Revision image has zero dimension')
  }

  const beforeData = drawToCanvas(beforeImg, width, height)
  const afterData = drawToCanvas(afterImg, width, height)

  const bPix = beforeData.data
  const aPix = afterData.data
  const total = width * height

  // Build output buffers into real ImageData objects so they can be
  // putImageData'd back without re-constructing (avoids the
  // SharedArrayBuffer-vs-ArrayBuffer constructor type mismatch).
  const overlayCanvas = makeCanvas(width, height)
  const differenceCanvas = makeCanvas(width, height)
  // Overlay: transparent everywhere except changed pixels.
  const overlayImage = overlayCanvas.ctx.createImageData(width, height)
  // Difference: changed pixels colored, unchanged shown as dim grayscale of after.
  const differenceImage = differenceCanvas.ctx.createImageData(width, height)
  const overlay = overlayImage.data
  const difference = differenceImage.data

  let added = 0
  let removed = 0

  for (let i = 0; i < total; i++) {
    const o = i * 4
    const beforeLum = perceivedLuminance(bPix[o] ?? 255, bPix[o + 1] ?? 255, bPix[o + 2] ?? 255)
    const afterLum = perceivedLuminance(aPix[o] ?? 255, aPix[o + 1] ?? 255, aPix[o + 2] ?? 255)
    const delta = afterLum - beforeLum

    if (Math.abs(delta) >= threshold) {
      // delta < 0 → after is darker → ink added → BLUE.
      // delta > 0 → after is lighter → ink removed → RED.
      const isAdded = delta < 0
      if (isAdded) added++
      else removed++

      const r = isAdded ? 37 : 220
      const g = isAdded ? 99 : 38
      const b = isAdded ? 235 : 38

      overlay[o] = r
      overlay[o + 1] = g
      overlay[o + 2] = b
      overlay[o + 3] = 255

      difference[o] = r
      difference[o + 1] = g
      difference[o + 2] = b
      difference[o + 3] = 255
    } else {
      // overlay: leave fully transparent (alpha already 0).
      // difference: faint grayscale of the after sheet for context.
      const lum = Math.round(220 + (afterLum / 255) * 35)
      difference[o] = lum
      difference[o + 1] = lum
      difference[o + 2] = lum
      difference[o + 3] = 255
    }
  }

  overlayCanvas.ctx.putImageData(overlayImage, 0, 0)
  differenceCanvas.ctx.putImageData(differenceImage, 0, 0)

  return {
    overlayDataUrl: overlayCanvas.canvas.toDataURL('image/png'),
    differenceDataUrl: differenceCanvas.canvas.toDataURL('image/png'),
    width,
    height,
    changedFraction: total > 0 ? (added + removed) / total : 0,
    addedPixels: added,
    removedPixels: removed,
  }
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  return { canvas, ctx }
}
