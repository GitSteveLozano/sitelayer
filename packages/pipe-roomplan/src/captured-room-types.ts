/**
 * Zod schemas for the CapturedRoom JSON dump produced by Apple's RoomPlan.
 *
 * NOTE: This is OUR schema for the JSON-encoded payload, not necessarily a 1:1
 * mirror of Apple's `CapturedRoom` Swift struct. Apple's `Codable` encoder may
 * emit additional/renamed fields in future iOS versions; we keep the schema
 * permissive (`.passthrough()` on container shapes) and only validate the
 * fields we actually consume. See NOTES.md for the field-by-field provenance.
 *
 * Coordinate convention from research/01-roomplan.md:
 *   - dimensions: [width(X), height(Y), length(Z)] in meters
 *     (for floors, dimensions[1] is thickness, dimensions[0] and [2] are X and Z extents)
 *   - transform: column-major 4x4 matrix in meters; we accept it as 4 rows of 4 numbers
 *   - confidence: "high" | "medium" | "low"
 *
 * Multi-room handling: Apple's stock CapturedRoom is single-room. iOS 17's
 * StructureBuilder emits a CapturedStructure that we approximate with a top-level
 * `rooms[]` array — see NOTES.md.
 */

import { z } from 'zod'

export const RoomplanConfidence = z.enum(['high', 'medium', 'low'])
export type RoomplanConfidence = z.infer<typeof RoomplanConfidence>

// 4x4 transform: array of 4 rows of 4 numbers. We don't currently use it for
// math (we read dimensions directly), but we keep it in the schema so the
// review UI can position highlights.
const Transform4x4 = z.array(z.array(z.number()).length(4)).length(4)

const Vec3 = z.tuple([z.number(), z.number(), z.number()])

/**
 * Curved wall metadata (iOS 16+). When present indicates the wall is an arc.
 */
const CurveSpec = z
  .object({
    radius: z.number().optional(),
    startAngle: z.number().optional(),
    endAngle: z.number().optional(),
  })
  .passthrough()

/**
 * Slanted/non-rectangular wall corners (iOS 17+). Each corner is a 3-vector
 * in the wall's local coordinate frame.
 */
const PolygonCorners = z.array(Vec3)

const SurfaceBase = z
  .object({
    identifier: z.string(),
    category: z.string(), // "wall" | "door" | "window" | "opening" | "floor"
    confidence: RoomplanConfidence,
    dimensions: Vec3,
    transform: Transform4x4,
    // openings (door/window/opening) carry `parent` = host wall UUID
    parent: z.string().nullable().optional(),
    curve: CurveSpec.nullable().optional(),
    polygonCorners: PolygonCorners.nullable().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

export const Wall = SurfaceBase.extend({
  category: z.literal('wall').optional(), // tolerate missing or wrong; we trust array slot
})
export type Wall = z.infer<typeof Wall>

export const Door = SurfaceBase.extend({
  category: z.literal('door').optional(),
})
export type Door = z.infer<typeof Door>

export const Window = SurfaceBase.extend({
  category: z.literal('window').optional(),
})
export type Window = z.infer<typeof Window>

export const Opening = SurfaceBase.extend({
  category: z.literal('opening').optional(),
})
export type Opening = z.infer<typeof Opening>

export const Floor = SurfaceBase.extend({
  category: z.literal('floor').optional(),
})
export type Floor = z.infer<typeof Floor>

/**
 * RoomPlan Object — the 16 furniture/fixture categories. We accept any string
 * to be forward-compatible; consumer maps known categories to MasterFormat.
 */
export const RoomObject = z
  .object({
    identifier: z.string(),
    category: z.string(),
    confidence: RoomplanConfidence,
    dimensions: Vec3,
    transform: Transform4x4,
    parent: z.string().nullable().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
export type RoomObject = z.infer<typeof RoomObject>

/**
 * iOS 17+ `Section` — labels a sub-region of a CapturedRoom (e.g. open-concept
 * kitchen + dining). Optional.
 */
export const Section = z
  .object({
    category: z.string().optional(), // "bedroom" | "bathroom" | "kitchen" | ...
    label: z.string().optional(),
    center: Vec3.optional(),
  })
  .passthrough()
export type Section = z.infer<typeof Section>

/**
 * A single CapturedRoom JSON dump.
 */
export const CapturedRoom = z
  .object({
    version: z.union([z.number(), z.string()]).optional(),
    identifier: z.string().optional(),
    story: z.number().optional(),
    walls: z.array(Wall).default([]),
    doors: z.array(Door).default([]),
    windows: z.array(Window).default([]),
    openings: z.array(Opening).default([]),
    floors: z.array(Floor).default([]),
    objects: z.array(RoomObject).default([]),
    sections: z.array(Section).optional(),
  })
  .passthrough()
export type CapturedRoom = z.infer<typeof CapturedRoom>

/**
 * A CapturedStructure-style top-level dump (iOS 17+ StructureBuilder).
 * Apple's API returns a `CapturedStructure` which we approximate as a wrapper
 * with `rooms[]`. See NOTES.md.
 */
export const CapturedStructure = z
  .object({
    version: z.union([z.number(), z.string()]).optional(),
    identifier: z.string().optional(),
    rooms: z.array(CapturedRoom).min(1),
  })
  .passthrough()
export type CapturedStructure = z.infer<typeof CapturedStructure>

/**
 * Top-level input — either a single CapturedRoom or a CapturedStructure.
 * We disambiguate by looking for `rooms[]` at the top level.
 */
export const CapturedRoomInput = z.union([CapturedStructure, CapturedRoom])
export type CapturedRoomInput = z.infer<typeof CapturedRoomInput>

/**
 * Normalize any input into an array of CapturedRoom records, plus the
 * top-level structure id (or the single room id).
 */
export function normalizeToRooms(input: CapturedRoomInput): {
  topLevelId: string
  rooms: CapturedRoom[]
} {
  if ('rooms' in input && Array.isArray((input as CapturedStructure).rooms)) {
    const struct = input as CapturedStructure
    return {
      topLevelId: struct.identifier ?? 'captured-structure',
      rooms: struct.rooms,
    }
  }
  const single = input as CapturedRoom
  return {
    topLevelId: single.identifier ?? 'captured-room',
    rooms: [single],
  }
}
