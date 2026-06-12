// Elevation tags — the building-face axis exterior takeoff is organized by
// (N/S/E/W walls, roof, other). Relocated out of the (since-retired,
// 2026-06-12) v1 screens/projects/takeoff-canvas.tsx so the est-canvas editor
// and the projects/* summary cluster share ONE definition — which is exactly
// what let the v1 canvas be deleted without these helpers going with it.
//
// `ElevationTag` includes 'none' — the untagged sentinel the pickers + summary
// rollup use. The machine's `TakeoffElevation` (machines/takeoff-session) is the
// same set minus 'none'; it uses `null` for untagged. So `none ↔ null` at the
// persistence edge: a picker emits `null` for 'none', and `readElevation` maps a
// null/empty stored value back to 'none'.

export const ELEVATION_TAGS = ['none', 'east', 'south', 'west', 'north', 'roof', 'other'] as const
export type ElevationTag = (typeof ELEVATION_TAGS)[number]

/**
 * Resolve a measurement's elevation tag from its persisted `elevation` column,
 * falling back to a legacy `elev:<tag>` notes prefix for rows that escaped the
 * 042 backfill (e.g. offline mutations queued by an older client).
 */
export function readElevation(measurement: { elevation: string | null; notes: string | null }): ElevationTag {
  if (measurement.elevation) {
    const t = measurement.elevation.toLowerCase()
    return ELEVATION_TAGS.includes(t as ElevationTag) ? (t as ElevationTag) : 'other'
  }
  if (!measurement.notes) return 'none'
  const match = /^elev:(\w+)/i.exec(measurement.notes.trim())
  if (!match) return 'none'
  const t = match[1]?.toLowerCase()
  return ELEVATION_TAGS.includes(t as ElevationTag) ? (t as ElevationTag) : 'other'
}

/** Human label for an elevation tag (used by the summary rollup). */
export function prettyElevation(t: ElevationTag): string {
  if (t === 'east') return 'East elevation'
  if (t === 'south') return 'South elevation'
  if (t === 'west') return 'West elevation'
  if (t === 'north') return 'North elevation'
  if (t === 'roof') return 'Roof'
  if (t === 'other') return 'Other'
  return 'Untagged'
}
