import type { BlueprintPage } from '@/lib/api'

export interface WorldScale {
  /** Real-world distance per board-x unit (board 0–100 spans the page width). */
  wx: number
  /** Real-world distance per board-y unit (board 0–100 spans the page height). */
  wy: number
  /** Calibration world unit, e.g. 'ft' / 'in' / 'm'. */
  unit: string
}

/**
 * Solve the per-axis real-world scale for a calibrated blueprint page.
 *
 * The drawing surface is a 0–100 board space stretched to the page's aspect
 * ratio (anisotropic): board-x covers the full page width, board-y the full
 * height, so a board unit is a different real distance on each axis. Given the
 * page's true size in PDF points (isotropic) and a two-point calibration line
 * of known world length, we solve:
 *
 *   wx / wy = pageWidth / pageHeight              (points→world is uniform)
 *   worldDistance² = (Δbx·wx)² + (Δby·wy)²        (length of the drawn line)
 *
 * ⇒ wy = worldDistance / √((Δbx·aspect)² + Δby²),  wx = aspect · wy
 *
 * Returns null when the page is uncalibrated or the page size is unknown, in
 * which case the caller leaves the measurement in board space (legacy).
 */
export function solveWorldScale(
  page: BlueprintPage | null | undefined,
  pageWidth: number | null | undefined,
  pageHeight: number | null | undefined,
): WorldScale | null {
  if (!page) return null
  const w = num(pageWidth)
  const h = num(pageHeight)
  if (w === null || h === null || w <= 0 || h <= 0) return null

  const x1 = num(page.calibration_x1)
  const y1 = num(page.calibration_y1)
  const x2 = num(page.calibration_x2)
  const y2 = num(page.calibration_y2)
  const dist = num(page.calibration_world_distance)
  if (x1 === null || y1 === null || x2 === null || y2 === null || dist === null || dist <= 0) {
    return null
  }

  const aspect = w / h
  const dbx = x2 - x1
  const dby = y2 - y1
  const denom = Math.sqrt(dbx * aspect * (dbx * aspect) + dby * dby)
  if (!Number.isFinite(denom) || denom <= 0) return null

  const wy = dist / denom
  const wx = aspect * wy
  if (!Number.isFinite(wx) || !Number.isFinite(wy) || wx <= 0 || wy <= 0) return null

  const unit = (page.calibration_world_unit ?? 'ft').trim() || 'ft'
  return { wx, wy, unit }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
