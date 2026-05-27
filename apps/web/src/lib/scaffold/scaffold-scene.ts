import type { ScaffoldMember, ScaffoldMemberRole, ScaffoldModel } from '@sitelayer/domain'

/**
 * Map a domain ScaffoldModel (members in mm, z-up) into a three.js-ready scene:
 * world points in FEET, centred on the footprint, with z-up converted to the
 * renderer's y-up convention. Pure + framework-free so it can be unit-tested
 * independently of WebGL.
 */

export const MM_PER_FOOT = 304.8

const ROLE_COLORS: Record<ScaffoldMemberRole, string> = {
  standard: '#d9904a',
  ledger: '#4f9f89',
  transom: '#6d7ed7',
  brace: '#c75f75',
  deck: '#8e735b',
  guardrail: '#4b9ed6',
  toeboard: '#9b7bd8',
  base_plate: '#7d9253',
}

export function colorForRole(role: ScaffoldMemberRole): string {
  return ROLE_COLORS[role]
}

export interface ScaffoldScenePoint {
  x: number
  y: number
  z: number
}

export interface ScaffoldSceneSegment {
  id: string
  role: ScaffoldMemberRole
  a: ScaffoldScenePoint
  b: ScaffoldScenePoint
  color: string
}

export interface ScaffoldScene {
  segments: ScaffoldSceneSegment[]
  /** Bounding span in feet for camera framing. */
  spanFt: number
  heightFt: number
}

export function buildScaffoldScene(model: ScaffoldModel): ScaffoldScene {
  const centerXmm = model.bounds.lengthMm / 2
  const centerYmm = model.bounds.widthMm / 2

  // Domain is z-up (x length, y width, z height); three.js is y-up. Map
  // mm(x,y,z) → ft(x, z→y, y→z), centred on the footprint so the model sits
  // around the origin with its base on the ground plane (y = 0).
  const toScene = (p: ScaffoldMember['start']): ScaffoldScenePoint => ({
    x: (p.x - centerXmm) / MM_PER_FOOT,
    y: p.z / MM_PER_FOOT,
    z: (p.y - centerYmm) / MM_PER_FOOT,
  })

  const segments: ScaffoldSceneSegment[] = model.members.map((member) => ({
    id: member.id,
    role: member.role,
    a: toScene(member.start),
    b: toScene(member.end),
    color: colorForRole(member.role),
  }))

  const spanFt = Math.max(model.bounds.lengthMm, model.bounds.widthMm) / MM_PER_FOOT
  const heightFt = model.bounds.heightMm / MM_PER_FOOT
  return { segments, spanFt, heightFt }
}
