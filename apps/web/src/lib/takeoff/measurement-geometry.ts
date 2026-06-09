import type { PitchDriver } from '@sitelayer/domain'
import type { WorldScale } from './world-scale'

/**
 * Optional JSONB stamps the server reads to compute true-world, pitch-corrected
 * measurement quantities. Both are spread into a saved measurement `geometry`.
 *
 * The server write path (`apps/api/src/routes/takeoff-write.ts` →
 * `@sitelayer/domain` `calculateGeometryQuantity`) recomputes the persisted
 * quantity from the geometry: it resolves `world_per_board_x` / `world_per_board_y`
 * (per-axis page scale, so a board-space polygon becomes true sqft/lf) and an
 * optional `pitch` (rise:run → slope factor for sloped surfaces). Absent ⇒
 * board-space, flat — the legacy/uncalibrated behavior.
 *
 * Shared by the desktop and mobile takeoff bodies so the two stamp identical
 * geometry instead of drifting (the mobile body historically stamped neither,
 * silently persisting board-space quantities on calibrated/pitched sheets).
 */

/**
 * Per-axis world-scale stamp. Emitted only when the page is calibrated
 * (`worldScale` non-null) AND the tool measures a scaled surface
 * (`appliesToTool` — area / lineal, never count). Otherwise an empty object so
 * the spread is a no-op and the server falls back to board space.
 */
export function worldScaleStamp(
  worldScale: WorldScale | null,
  appliesToTool: boolean,
): { world_per_board_x: number; world_per_board_y: number } | Record<string, never> {
  return worldScale && appliesToTool
    ? { world_per_board_x: worldScale.wx, world_per_board_y: worldScale.wy }
    : {}
}

/**
 * Pitch (rise:run) stamp. Emitted only for a sloped-surface tool
 * (`appliesToTool`) when a valid pitch is set. Flat / count ⇒ empty object.
 */
export function pitchStamp(
  pitch: PitchDriver | null,
  appliesToTool: boolean,
): { pitch: PitchDriver } | Record<string, never> {
  return pitch && appliesToTool ? { pitch } : {}
}
