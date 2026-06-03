import { describe, expect, it } from 'vitest'
import {
  baseLayerScale,
  buildTileGrid,
  DEFAULT_TILE_SIZE_CSS,
  fitsSingleCanvas,
  IOS_MAX_CANVAS_AREA,
  MAX_CANVAS_SIDE,
  maxTilePoints,
  tilesForViewport,
  type PageRect,
  type PageSize,
} from './tiling.js'

// A typical architectural sheet: 34" x 22" = 2448 x 1584 PDF points
// (72 pt/inch). Big enough that a crisp single-canvas raster blows the caps.
const ARCH_SHEET: PageSize = { width: 2448, height: 1584 }
// A normal letter page (8.5" x 11" = 612 x 792 pt) — should never need tiling
// at the scales the callers use.
const LETTER: PageSize = { width: 612, height: 792 }

function totalCoveredArea(rects: PageRect[]): number {
  return rects.reduce((acc, r) => acc + r.width * r.height, 0)
}

describe('fitsSingleCanvas', () => {
  it('passes a letter page at the desktop max scale (6) and dpr 2', () => {
    // 612*6*2 = 7344 px/side — over MAX_SIDE, so even letter needs tiling there.
    expect(fitsSingleCanvas(LETTER, 6, 2)).toBe(false)
    // But at scale 3 / dpr 1 it fits: 612*3 = 1836, 792*3 = 2376, area ≈ 4.36M.
    expect(fitsSingleCanvas(LETTER, 3, 1)).toBe(true)
  })

  it('rejects a large architectural sheet at a crisp scale', () => {
    // 2448*3 = 7344 px/side > MAX_SIDE (4096): does not fit.
    expect(fitsSingleCanvas(ARCH_SHEET, 3, 1)).toBe(false)
  })

  it('rejects on the area cap even when both sides are under the side cap', () => {
    // Both sides 3000 px (< MAX_SIDE 4096) but area 9M > a tighter 8M cap:
    // the area branch must reject independently of the side branch.
    const page: PageSize = { width: 3000, height: 3000 }
    expect(page.width).toBeLessThan(MAX_CANVAS_SIDE)
    expect(page.height).toBeLessThan(MAX_CANVAS_SIDE)
    expect(fitsSingleCanvas(page, 1, 1, MAX_CANVAS_SIDE, 8_000_000)).toBe(false)
    // ...and accepts the same page once the area budget is large enough.
    expect(fitsSingleCanvas(page, 1, 1, MAX_CANVAS_SIDE, 10_000_000)).toBe(true)
  })

  it('accepts a small page', () => {
    expect(fitsSingleCanvas(LETTER, 1, 1)).toBe(true)
  })
})

describe('maxTilePoints', () => {
  it('returns the on-screen target size in points when the area cap is slack', () => {
    // At scale 2, the target tile (768 css px) is 384 page points; the area
    // cap allows much larger, so the target wins.
    expect(maxTilePoints(2, 1, DEFAULT_TILE_SIZE_CSS, IOS_MAX_CANVAS_AREA)).toBeCloseTo(384, 5)
  })

  it('shrinks below the target when the area cap would otherwise be exceeded', () => {
    // The default 768-css target tile always renders to 768*dpr px/side
    // (the scale cancels), which is under the cap for any sane dpr. Force the
    // cap to bite with a very large requested tile size: 6000 css px at scale
    // 1 / dpr 1 would be 6000 px/side → 36M px, over the 16.78M cap, so the
    // returned tile must be smaller than the requested 6000 points.
    const requestedTileCss = 6000
    const bounded = maxTilePoints(1, 1, requestedTileCss, IOS_MAX_CANVAS_AREA)
    expect(bounded).toBeLessThan(requestedTileCss)
    // And the resulting tile bitmap stays under the cap.
    expect((bounded * 1 * 1) ** 2).toBeLessThanOrEqual(IOS_MAX_CANVAS_AREA)
  })
})

describe('buildTileGrid', () => {
  it('covers the whole page with no gaps and no overflow', () => {
    const grid = buildTileGrid(ARCH_SHEET, 4, { dpr: 2 })
    expect(grid.tiles.length).toBe(grid.cols * grid.rows)

    // The union of tile rects exactly tiles the page (uniform grid, partial
    // edges) — total covered area equals the page area.
    const covered = totalCoveredArea(grid.tiles.map((t) => t.rect))
    expect(covered).toBeCloseTo(ARCH_SHEET.width * ARCH_SHEET.height, 1)

    // No tile escapes the page bounds.
    for (const tile of grid.tiles) {
      expect(tile.rect.x).toBeGreaterThanOrEqual(0)
      expect(tile.rect.y).toBeGreaterThanOrEqual(0)
      expect(tile.rect.x + tile.rect.width).toBeLessThanOrEqual(ARCH_SHEET.width + 1e-6)
      expect(tile.rect.y + tile.rect.height).toBeLessThanOrEqual(ARCH_SHEET.height + 1e-6)
      expect(tile.rect.width).toBeGreaterThan(0)
      expect(tile.rect.height).toBeGreaterThan(0)
    }
  })

  it('tiles are contiguous and ordered row-major', () => {
    const grid = buildTileGrid(ARCH_SHEET, 4, { dpr: 2 })
    // First tile anchored at the origin.
    expect(grid.tiles[0]?.rect.x).toBe(0)
    expect(grid.tiles[0]?.rect.y).toBe(0)
    // Row-major ordering: index === row*cols + col.
    grid.tiles.forEach((tile, idx) => {
      expect(idx).toBe(tile.row * grid.cols + tile.col)
    })
    // Adjacent columns abut exactly (no gap/overlap) within a row.
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 1; col < grid.cols; col++) {
        const prev = grid.tiles[row * grid.cols + (col - 1)]
        const cur = grid.tiles[row * grid.cols + col]
        expect(cur?.rect.x).toBeCloseTo((prev?.rect.x ?? 0) + (prev?.rect.width ?? 0), 6)
      }
    }
  })

  it('NEVER produces a tile whose device-pixel area exceeds the iOS cap', () => {
    // Sweep a range of scales and dprs, including extreme ones, over both a
    // huge sheet and a letter page. Every tile must stay under the cap.
    const pages = [ARCH_SHEET, LETTER, { width: 5000, height: 3200 }]
    const scales = [1, 2, 3, 4, 6, 8]
    const dprs = [1, 1.5, 2, 3]
    for (const page of pages) {
      for (const scale of scales) {
        for (const dpr of dprs) {
          const grid = buildTileGrid(page, scale, { dpr })
          for (const tile of grid.tiles) {
            const area = tile.pixelWidth * tile.pixelHeight
            expect(area).toBeLessThanOrEqual(IOS_MAX_CANVAS_AREA)
            // Sanity: pixel dims reflect rect * scale * dpr.
            expect(tile.pixelWidth).toBe(Math.max(1, Math.round(tile.rect.width * grid.scale * grid.dpr)))
            expect(tile.pixelHeight).toBe(Math.max(1, Math.round(tile.rect.height * grid.scale * grid.dpr)))
          }
        }
      }
    }
  })

  it('falls back to a single tile for a tiny page', () => {
    const grid = buildTileGrid({ width: 100, height: 100 }, 1, { dpr: 1 })
    expect(grid.cols).toBe(1)
    expect(grid.rows).toBe(1)
    expect(grid.tiles).toHaveLength(1)
    expect(grid.tiles[0]?.rect).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('honors a custom tile size and a custom area cap', () => {
    const grid = buildTileGrid(ARCH_SHEET, 2, { dpr: 1, tileSizeCss: 256, maxTileArea: 200_000 })
    for (const tile of grid.tiles) {
      expect(tile.pixelWidth * tile.pixelHeight).toBeLessThanOrEqual(200_000)
    }
  })
})

describe('tilesForViewport', () => {
  const grid = buildTileGrid(ARCH_SHEET, 4, { dpr: 2 })

  it('returns every tile for the whole-page viewport', () => {
    const all = tilesForViewport(grid, { x: 0, y: 0, width: ARCH_SHEET.width, height: ARCH_SHEET.height })
    expect(all).toHaveLength(grid.tiles.length)
  })

  it('returns no tiles for a zero-area viewport', () => {
    expect(tilesForViewport(grid, { x: 10, y: 10, width: 0, height: 0 })).toHaveLength(0)
    expect(tilesForViewport(grid, { x: 10, y: 10, width: 100, height: 0 })).toHaveLength(0)
  })

  it('returns only the tiles intersecting a small top-left viewport, and they cover it', () => {
    const viewport: PageRect = { x: 0, y: 0, width: grid.tilePoints * 0.5, height: grid.tilePoints * 0.5 }
    const hits = tilesForViewport(grid, viewport)
    expect(hits.length).toBeGreaterThan(0)
    // Every returned tile must actually intersect the viewport.
    for (const tile of hits) {
      const ix = Math.max(tile.rect.x, viewport.x)
      const iy = Math.max(tile.rect.y, viewport.y)
      const ax = Math.min(tile.rect.x + tile.rect.width, viewport.x + viewport.width)
      const ay = Math.min(tile.rect.y + tile.rect.height, viewport.y + viewport.height)
      expect(ax).toBeGreaterThan(ix)
      expect(ay).toBeGreaterThan(iy)
    }
    // And the returned tiles fully cover the viewport (union spans it).
    const minX = Math.min(...hits.map((t) => t.rect.x))
    const minY = Math.min(...hits.map((t) => t.rect.y))
    const maxX = Math.max(...hits.map((t) => t.rect.x + t.rect.width))
    const maxY = Math.max(...hits.map((t) => t.rect.y + t.rect.height))
    expect(minX).toBeLessThanOrEqual(viewport.x)
    expect(minY).toBeLessThanOrEqual(viewport.y)
    expect(maxX).toBeGreaterThanOrEqual(viewport.x + viewport.width)
    expect(maxY).toBeGreaterThanOrEqual(viewport.y + viewport.height)
  })

  it('returns a single tile for a viewport wholly inside one tile', () => {
    const t = grid.tiles[0]
    expect(t).toBeDefined()
    const viewport: PageRect = {
      x: (t?.rect.width ?? 0) * 0.25,
      y: (t?.rect.height ?? 0) * 0.25,
      width: (t?.rect.width ?? 0) * 0.25,
      height: (t?.rect.height ?? 0) * 0.25,
    }
    const hits = tilesForViewport(grid, viewport)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.col).toBe(0)
    expect(hits[0]?.row).toBe(0)
  })
})

describe('baseLayerScale', () => {
  it('produces a whole-page raster that fits a single canvas under both caps', () => {
    const dpr = 2
    const base = baseLayerScale(ARCH_SHEET, 6, dpr)
    expect(fitsSingleCanvas(ARCH_SHEET, base, dpr)).toBe(true)
    // It is the cap-limited scale, never above the requested scale.
    expect(base).toBeLessThanOrEqual(6)
    expect(base).toBeGreaterThan(0)
  })

  it('never exceeds the requested scale when the page is small', () => {
    // Requested 1 on a letter page: cap allows much more, so we clamp to 1.
    expect(baseLayerScale(LETTER, 1, 1)).toBeCloseTo(1, 5)
  })

  it('keeps a visible floor for an enormous page', () => {
    const giant: PageSize = { width: 20000, height: 20000 }
    const base = baseLayerScale(giant, 6, 3)
    expect(base).toBeGreaterThan(0)
    expect(fitsSingleCanvas(giant, base, 3)).toBe(true)
  })
})
