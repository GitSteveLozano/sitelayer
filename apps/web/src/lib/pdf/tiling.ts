// Tile-grid math for PDFium page rendering. Pure, dependency-free, and unit
// tested (./tiling.test.ts) — no DOM, no engine handles. The renderer
// (./pdf-page-canvas.tsx) feeds these rects to renderPageRect so a large
// architectural sheet never rasterizes to a single oversized canvas.
//
// Two failure modes this exists to dodge:
//   1. iOS/Safari caps a canvas at ~16.78M px of AREA (4096x4096 ≈ 16.78M);
//      a 34x22" sheet at a crisp scale blows past that and renders all-white
//      or kills the tab. Each tile here is sized so tileW*tileH (in device
//      pixels, dpr included) stays under that cap.
//   2. A whole page rasterized to one 4096px/side canvas goes blurry on deep
//      zoom. Tiles let the page be rendered at full scale across many small
//      canvases whose aggregate resolution far exceeds 4096px/side.
//
// Coordinate space: PDF page-space points, origin top-left — the same space
// renderPageRect's `rect` consumes and the text layer maps with `origin * s`.
// A tile covering a page-space rect of W×H points at `scale` css-px/point and
// device-pixel-ratio `dpr` produces a bitmap of round(W*scale*dpr) ×
// round(H*scale*dpr) device pixels (confirmed against the engine's
// renderRectEncoded: wDev = round(rect.size.width * scaleFactor * dpr)).

/** iOS/Safari maximum canvas AREA in device pixels (4096 * 4096). */
export const IOS_MAX_CANVAS_AREA = 16_777_216

/** Per-side dimension cap for the single-canvas fast path (matches the
 * historical MAX_SIDE in pdf-page-canvas). A page whose raster fits under both
 * this side cap and the area cap can skip tiling entirely. */
export const MAX_CANVAS_SIDE = 4096

/** Target on-screen tile size, in CSS px per side, before dpr. ~768 keeps each
 * tile bitmap comfortably under the area cap even at dpr 3 (768*3 = 2304/side,
 * 2304^2 ≈ 5.3M < 16.78M) while keeping the tile count reasonable. */
export const DEFAULT_TILE_SIZE_CSS = 768

export interface PageSize {
  /** Page width in PDF points. */
  width: number
  /** Page height in PDF points. */
  height: number
}

/** Page-space rectangle, origin top-left, units = PDF points. */
export interface PageRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Tile {
  /** Tile column index (0-based, left→right). */
  col: number
  /** Tile row index (0-based, top→bottom). */
  row: number
  /** The sub-rect of the page this tile covers, in PDF points. */
  rect: PageRect
  /** Device-pixel width of the tile bitmap at the grid's scale/dpr. */
  pixelWidth: number
  /** Device-pixel height of the tile bitmap at the grid's scale/dpr. */
  pixelHeight: number
}

export interface TileGrid {
  /** css-px per PDF point this grid renders at. */
  scale: number
  /** device-pixel-ratio baked into each tile's pixel dimensions. */
  dpr: number
  /** Tile edge length in PDF points (square in page space). */
  tilePoints: number
  /** Number of tile columns. */
  cols: number
  /** Number of tile rows. */
  rows: number
  /** Every tile covering the page, row-major. */
  tiles: Tile[]
}

export interface TileGridOptions {
  /** Target on-screen tile edge in CSS px (before dpr). */
  tileSizeCss?: number
  /** Device pixel ratio. Defaults to 1. */
  dpr?: number
  /** Max device-pixel canvas area per tile. Defaults to the iOS cap. */
  maxTileArea?: number
}

function clampPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The largest tile edge (in PDF points) that keeps a single tile's bitmap
 * under `maxArea` device pixels at the given scale*dpr, capped at the target
 * on-screen tile size. A square tile of `p` points renders to
 * (p*scale*dpr)^2 device px; the area cap bounds `p` from above.
 */
export function maxTilePoints(scale: number, dpr: number, tileSizeCss: number, maxArea: number): number {
  const s = clampPositive(scale, 1)
  const d = clampPositive(dpr, 1)
  const area = clampPositive(maxArea, IOS_MAX_CANVAS_AREA)
  // Largest square tile (device px/side) allowed by the area cap, converted
  // back into page points. Shave a hair off so post-round() pixel dims can't
  // tip a tile over the cap at the boundary.
  const areaBoundPoints = (Math.sqrt(area) - 1) / (s * d)
  // The target tile size, also in page points.
  const targetPoints = clampPositive(tileSizeCss, DEFAULT_TILE_SIZE_CSS) / s
  return Math.max(1, Math.min(targetPoints, areaBoundPoints))
}

/**
 * Whether the whole page rasterized to a single canvas at `scale`/`dpr` stays
 * within both the per-side and area caps — i.e. the single-canvas fast path is
 * safe and tiling is unnecessary.
 */
export function fitsSingleCanvas(
  page: PageSize,
  scale: number,
  dpr: number,
  maxSide = MAX_CANVAS_SIDE,
  maxArea = IOS_MAX_CANVAS_AREA,
): boolean {
  const s = clampPositive(scale, 1)
  const d = clampPositive(dpr, 1)
  const w = page.width * s * d
  const h = page.height * s * d
  if (w > maxSide || h > maxSide) return false
  return w * h <= maxArea
}

/**
 * Build a uniform tile grid covering the whole page at `scale`/`dpr`. Tile
 * edge is the target on-screen size shrunk as needed so no tile bitmap exceeds
 * the area cap. The last column/row are partial (clipped to the page bounds)
 * and therefore never larger than a full tile, so the area invariant holds for
 * every tile.
 */
export function buildTileGrid(page: PageSize, scale: number, options: TileGridOptions = {}): TileGrid {
  const s = clampPositive(scale, 1)
  const dpr = clampPositive(options.dpr ?? 1, 1)
  const tileSizeCss = clampPositive(options.tileSizeCss ?? DEFAULT_TILE_SIZE_CSS, DEFAULT_TILE_SIZE_CSS)
  const maxArea = clampPositive(options.maxTileArea ?? IOS_MAX_CANVAS_AREA, IOS_MAX_CANVAS_AREA)

  const pageW = clampPositive(page.width, 1)
  const pageH = clampPositive(page.height, 1)

  const tilePoints = maxTilePoints(s, dpr, tileSizeCss, maxArea)
  const cols = Math.max(1, Math.ceil(pageW / tilePoints))
  const rows = Math.max(1, Math.ceil(pageH / tilePoints))

  const tiles: Tile[] = []
  for (let row = 0; row < rows; row++) {
    const y = row * tilePoints
    const height = Math.min(tilePoints, pageH - y)
    for (let col = 0; col < cols; col++) {
      const x = col * tilePoints
      const width = Math.min(tilePoints, pageW - x)
      tiles.push({
        col,
        row,
        rect: { x, y, width, height },
        pixelWidth: Math.max(1, Math.round(width * s * dpr)),
        pixelHeight: Math.max(1, Math.round(height * s * dpr)),
      })
    }
  }

  return { scale: s, dpr, tilePoints, cols, rows, tiles }
}

/** Axis-aligned overlap test between two page-space rects (touching edges do
 * not count as overlap). */
function rectsOverlap(a: PageRect, b: PageRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * The subset of a grid's tiles that intersect `viewport` (a page-space rect),
 * row-major. An empty/zero-area viewport returns no tiles. Pass the whole-page
 * rect to get every tile back.
 */
export function tilesForViewport(grid: TileGrid, viewport: PageRect): Tile[] {
  if (viewport.width <= 0 || viewport.height <= 0) return []
  return grid.tiles.filter((tile) => rectsOverlap(tile.rect, viewport))
}

/**
 * The base-layer (whole-page) render scale: the highest scale at which the
 * entire page still fits a single canvas under both caps, clamped to at most
 * the requested scale. This is the quick low-res layer drawn immediately under
 * the hi-res tiles. The returned scale always keeps the whole-page raster
 * under both caps — even for a pathologically large page it just gets coarse,
 * never oversized (so it can't itself trip the iOS cap).
 */
export function baseLayerScale(
  page: PageSize,
  requestedScale: number,
  dpr: number,
  maxSide = MAX_CANVAS_SIDE,
  maxArea = IOS_MAX_CANVAS_AREA,
): number {
  const d = clampPositive(dpr, 1)
  const pageW = clampPositive(page.width, 1)
  const pageH = clampPositive(page.height, 1)
  const longestSide = Math.max(pageW, pageH)
  // Side-cap-limited scale (shave a hair so post-arithmetic rounding can't
  // tip the raster over the cap at the exact boundary).
  const sideScale = (maxSide - 1) / (longestSide * d)
  // Area-cap-limited scale (sqrt because both dims grow with scale).
  const areaScale = Math.sqrt((maxArea - 1) / (pageW * pageH * d * d))
  const capScale = Math.min(sideScale, areaScale)
  const requested = clampPositive(requestedScale, 1)
  // Never exceed the requested scale; otherwise take whatever the caps allow.
  // No artificial floor — a floor could itself violate the cap on a giant page.
  return Math.max(0, Math.min(requested, capScale))
}
