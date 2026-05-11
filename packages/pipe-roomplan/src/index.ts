/**
 * pipe-roomplan — Apple RoomPlan CapturedRoom JSON → TakeoffResult.
 *
 * Conversion happens at the seam: input is meters; output is feet/sqft per the
 * data contract (CONTRACT.md rule 6). Per-room aggregate confidence is the
 * minimum over contributing surfaces (CONTRACT.md §Confidence).
 */

import { randomUUID } from 'node:crypto'
import {
  applyReviewFloor,
  derivedConfidence,
  roomplanConfidenceToScore,
  validateTakeoffResult,
  SCHEMA_VERSION,
} from '@sitelayer/capture-schema'
import type {
  RoomplanArtifact,
  TakeoffGeometry,
  TakeoffProvenance,
  TakeoffQuantity,
  TakeoffResult,
} from '@sitelayer/capture-schema'

import { CapturedRoomInput, normalizeToRooms } from './captured-room-types.js'
import type {
  CapturedRoom,
  Door,
  Floor,
  Opening,
  RoomObject,
  RoomplanConfidence,
  Section,
  Wall,
  Window,
} from './captured-room-types.js'

// ─── Constants ──────────────────────────────────────────────────────────────

export const PIPELINE_VERSION = '0.1.0'

const M_PER_FT = 0.3048
const SQM_PER_SQFT = M_PER_FT * M_PER_FT

// ─── Public types ──────────────────────────────────────────────────────────

export interface ParseCapturedRoomOptions {
  capturedRoomJson: unknown
  projectId: string
  capturedAt?: string
  deviceModel?: string
  /** Override version string for the captured-room dump (otherwise uses input.version). */
  capturedRoomVersion?: string
  /** URI to the original CapturedRoom JSON blob (review UI uses this). */
  capturedRoomJsonUri?: string
}

// ─── Conversion helpers ─────────────────────────────────────────────────────

const mToFt = (m: number) => m / M_PER_FT
const sqmToSqft = (sqm: number) => sqm / SQM_PER_SQFT
const round = (x: number, decimals = 4) => {
  const f = 10 ** decimals
  return Math.round(x * f) / f
}

/**
 * Drop keys whose value is undefined so exactOptionalPropertyTypes consumers
 * accept the object. The return type strips `undefined` from each value so the
 * resulting object is assignable to a target with `prop?: T` (which under
 * exactOptionalPropertyTypes does not accept explicit `undefined`).
 */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> }
}

// ─── Per-room arithmetic (kept in meters internally, emit imperial) ────────

interface WallComputed {
  id: string
  lengthM: number
  heightM: number
  grossAreaSqM: number
  netAreaSqM: number
  confidence: RoomplanConfidence
  raw: Wall
}

interface FeatureComputed {
  id: string
  kind: 'door' | 'window' | 'opening'
  widthM: number
  heightM: number
  areaSqM: number
  parentWallId: string
  confidence: RoomplanConfidence
}

interface FixtureComputed {
  id: string
  category: string
  confidence: RoomplanConfidence
  raw: RoomObject
}

interface RoomComputed {
  id: string
  label?: string
  story?: number
  floorAreaSqM: number
  perimeterM: number
  walls: WallComputed[]
  features: FeatureComputed[]
  fixtures: FixtureComputed[]
  /** Whether floor area was measured from a `floors[]` entry vs derived from walls. */
  floorAreaSource: 'floor-surface' | 'wall-bbox'
  floorConfidence: RoomplanConfidence
}

function pickSectionLabel(sections: Section[] | undefined): {
  label: string | undefined
  category: string | undefined
} {
  if (!sections || sections.length === 0) {
    return { label: undefined, category: undefined }
  }
  const first = sections[0]
  return { label: first?.label, category: first?.category }
}

const CONF_RANK: Record<RoomplanConfidence, number> = { high: 3, medium: 2, low: 1 }
function worseConfidence(a: RoomplanConfidence, b: RoomplanConfidence): RoomplanConfidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b
}

/**
 * Floor area derivation:
 *   - If a `floors[]` surface exists, use its X×Z extents (dimensions[0]*dimensions[2]).
 *     dimensions[1] for a floor is its thickness, not Y extent.
 *   - Otherwise, fall back to the axis-aligned bounding box derived from wall
 *     transform translations (transform[3][0] = X, transform[3][2] = Z).
 *     This is a simplification for non-rectangular rooms; documented in NOTES.md.
 */
function computeFloorAreaM(
  floors: Floor[],
  walls: Wall[],
): { areaSqM: number; perimeterM: number; source: 'floor-surface' | 'wall-bbox'; confidence: RoomplanConfidence } {
  if (floors.length > 0) {
    let area = 0
    let worstConf: RoomplanConfidence = 'high'
    for (const f of floors) {
      const w = f.dimensions[0]
      const l = f.dimensions[2]
      area += w * l
      worstConf = worseConfidence(worstConf, f.confidence)
    }
    const perimeter = walls.reduce((s, w) => s + w.dimensions[0], 0)
    return { areaSqM: area, perimeterM: perimeter, source: 'floor-surface', confidence: worstConf }
  }

  // Fallback: bbox over wall translation centers
  let xMin = Infinity,
    xMax = -Infinity,
    zMin = Infinity,
    zMax = -Infinity
  for (const w of walls) {
    const tx = w.transform[3]?.[0] ?? 0
    const tz = w.transform[3]?.[2] ?? 0
    if (tx < xMin) xMin = tx
    if (tx > xMax) xMax = tx
    if (tz < zMin) zMin = tz
    if (tz > zMax) zMax = tz
  }
  const dx = isFinite(xMax - xMin) ? xMax - xMin : 0
  const dz = isFinite(zMax - zMin) ? zMax - zMin : 0
  const area = dx * dz
  const perimeter = walls.reduce((s, w) => s + w.dimensions[0], 0)
  let worstConf: RoomplanConfidence = 'high'
  for (const w of walls) worstConf = worseConfidence(worstConf, w.confidence)
  return { areaSqM: area, perimeterM: perimeter, source: 'wall-bbox', confidence: worstConf }
}

function computeRoom(room: CapturedRoom): RoomComputed {
  const wallComputed: WallComputed[] = room.walls.map((w) => {
    const lengthM = w.dimensions[0]
    const heightM = w.dimensions[1]
    const grossAreaSqM = lengthM * heightM
    return {
      id: w.identifier,
      lengthM,
      heightM,
      grossAreaSqM,
      netAreaSqM: grossAreaSqM, // openings subtracted below
      confidence: w.confidence,
      raw: w,
    }
  })

  const featuresAll: FeatureComputed[] = []
  const pushFeature = (kind: 'door' | 'window' | 'opening', arr: ReadonlyArray<Door | Window | Opening>) => {
    for (const f of arr) {
      const widthM = f.dimensions[0]
      const heightM = f.dimensions[1]
      const parentWallId = f.parent ?? ''
      const fc: FeatureComputed = {
        id: f.identifier,
        kind,
        widthM,
        heightM,
        areaSqM: widthM * heightM,
        parentWallId,
        confidence: f.confidence,
      }
      featuresAll.push(fc)
      if (parentWallId) {
        const parent = wallComputed.find((w) => w.id === parentWallId)
        if (parent) {
          parent.netAreaSqM = Math.max(0, parent.netAreaSqM - fc.areaSqM)
          parent.confidence = worseConfidence(parent.confidence, f.confidence)
        }
      }
    }
  }
  pushFeature('door', room.doors)
  pushFeature('window', room.windows)
  pushFeature('opening', room.openings)

  const floorInfo = computeFloorAreaM(room.floors, room.walls)

  const fixtures: FixtureComputed[] = room.objects.map((o) => ({
    id: o.identifier,
    category: o.category,
    confidence: o.confidence,
    raw: o,
  }))

  const { label, category } = pickSectionLabel(room.sections)

  return compact({
    id: room.identifier ?? randomUUID(),
    label: label ?? category,
    story: room.story,
    floorAreaSqM: floorInfo.areaSqM,
    perimeterM: floorInfo.perimeterM,
    walls: wallComputed,
    features: featuresAll,
    fixtures,
    floorAreaSource: floorInfo.source,
    floorConfidence: floorInfo.confidence,
  })
}

// ─── MasterFormat / fixture mapping ─────────────────────────────────────────

const FIXTURE_CSI: Record<string, { mf?: string; uf?: string; description: string }> = {
  toilet: { mf: '22 40 00', uf: 'D2010', description: 'Toilet (plumbing fixture)' },
  sink: { mf: '22 40 00', uf: 'D2010', description: 'Sink (plumbing fixture)' },
  bathtub: { mf: '22 40 00', uf: 'D2010', description: 'Bathtub (plumbing fixture)' },
  refrigerator: { mf: '11 31 00', uf: 'E1090', description: 'Refrigerator (residential appliance)' },
  stove: { mf: '11 31 00', uf: 'E1090', description: 'Stove (residential appliance)' },
  oven: { mf: '11 31 00', uf: 'E1090', description: 'Oven (residential appliance)' },
  dishwasher: { mf: '11 31 00', uf: 'E1090', description: 'Dishwasher (residential appliance)' },
  washerDryer: { mf: '11 31 00', uf: 'E1090', description: 'Washer/Dryer (residential appliance)' },
  fireplace: { mf: '10 31 00', uf: 'C1030', description: 'Fireplace' },
  // Not priced in v1 — emit with UniFormat only so they don't hit unit-cost lookup
  television: { uf: 'E2010', description: 'Television (FF&E)' },
  storage: { uf: 'E2010', description: 'Storage (FF&E)' },
  sofa: { uf: 'E2010', description: 'Sofa (FF&E)' },
  chair: { uf: 'E2010', description: 'Chair (FF&E)' },
  table: { uf: 'E2010', description: 'Table (FF&E)' },
  bed: { uf: 'E2010', description: 'Bed (FF&E)' },
  stairs: { mf: '06 43 00', uf: 'B1080', description: 'Stairs' },
}

// ─── Quantity emitters ──────────────────────────────────────────────────────

interface ProvenanceCommon {
  capturedRoomId: string
  deviceModel?: string
}

function makeRoomplanProvenance(common: ProvenanceCommon, surfaceId?: string, objectId?: string): TakeoffProvenance {
  const provenance: TakeoffProvenance = {
    kind: 'roomplan',
    capturedRoomId: common.capturedRoomId,
  }
  if (common.deviceModel) provenance.deviceModel = common.deviceModel
  if (surfaceId) provenance.surfaceId = surfaceId
  if (objectId) provenance.objectId = objectId
  return provenance
}

function emitRoomQuantities(
  room: RoomComputed,
  capturedRoomId: string,
  deviceModel?: string,
): { quantities: TakeoffQuantity[]; geometry: TakeoffGeometry } {
  const quantities: TakeoffQuantity[] = []
  const geomRooms: NonNullable<TakeoffGeometry['rooms']> = []
  const geomSurfaces: NonNullable<TakeoffGeometry['surfaces']> = []
  const geomObjects: NonNullable<TakeoffGeometry['objects']> = []

  const roomCommon: ProvenanceCommon = compact({ capturedRoomId, deviceModel })

  // ── Geometry: room
  geomRooms.push({
    id: room.id,
    label: room.label,
    story: room.story,
    floorAreaSqFt: round(sqmToSqft(room.floorAreaSqM), 2),
    perimeterLf: round(mToFt(room.perimeterM), 2),
  })

  // ── Per-wall geometry surfaces
  for (const w of room.walls) {
    geomSurfaces.push({
      id: w.id,
      kind: 'wall',
      parentRoomId: room.id,
      areaSqFt: round(sqmToSqft(w.netAreaSqM), 2),
    })
  }

  // ── Drywall (sum of net wall area). MasterFormat 09 29 00.
  const drywallSqM = room.walls.reduce((s, w) => s + w.netAreaSqM, 0)
  const drywallSqFt = sqmToSqft(drywallSqM)
  const wallConfidences = room.walls.map((w) => roomplanConfidenceToScore(w.confidence))
  const drywallConfidence = wallConfidences.length > 0 ? Math.min(...wallConfidences) : 0.5
  const drywallId = `${room.id}/drywall`
  quantities.push({
    id: drywallId,
    description: `${room.label ?? 'Room'} — drywall (walls)`,
    masterformatCode: '09 29 00',
    ifc: {
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'NetSideArea',
      quantityKind: 'Area',
    },
    unit: 'sqft',
    value: round(drywallSqFt, 2),
    confidence: drywallConfidence,
    provenance: makeRoomplanProvenance(roomCommon),
    geometryRefs: [room.id, ...room.walls.map((w) => w.id)],
  })

  // ── Baseboard LF: perimeter minus door widths.
  const doorWidthSumM = room.features.filter((f) => f.kind === 'door').reduce((s, f) => s + f.widthM, 0)
  const baseboardLfM = Math.max(0, room.perimeterM - doorWidthSumM)
  const baseboardConfidence = drywallConfidence
  quantities.push({
    id: `${room.id}/baseboard`,
    description: `${room.label ?? 'Room'} — baseboard`,
    masterformatCode: '06 22 00',
    ifc: {
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'Length',
      quantityKind: 'Length',
    },
    unit: 'lft',
    value: round(mToFt(baseboardLfM), 2),
    confidence: baseboardConfidence,
    provenance: makeRoomplanProvenance(roomCommon),
    geometryRefs: [room.id],
  })

  // ── Flooring SF (UniFormat-only — pricing tier defaults). UniFormat B3010.
  const floorId = `${room.id}/flooring`
  const floorConfidenceScore = roomplanConfidenceToScore(room.floorConfidence)
  quantities.push({
    id: floorId,
    description: `${room.label ?? 'Room'} — flooring`,
    uniformatCode: 'B3010',
    ifc: {
      qsetName: 'Qto_SlabBaseQuantities',
      quantityName: 'GrossArea',
      quantityKind: 'Area',
    },
    unit: 'sqft',
    value: round(sqmToSqft(room.floorAreaSqM), 2),
    confidence: floorConfidenceScore,
    provenance: makeRoomplanProvenance(roomCommon),
    geometryRefs: [room.id],
  })

  // ── Ceiling area (derived from floor; provenance.kind = "derived").
  quantities.push({
    id: `${room.id}/ceiling`,
    description: `${room.label ?? 'Room'} — ceiling drywall`,
    masterformatCode: '09 29 00',
    ifc: {
      qsetName: 'Qto_CoveringBaseQuantities',
      quantityName: 'GrossArea',
      quantityKind: 'Area',
    },
    unit: 'sqft',
    value: round(sqmToSqft(room.floorAreaSqM), 2),
    confidence: derivedConfidence([floorConfidenceScore]),
    provenance: {
      kind: 'derived',
      from: [floorId],
      rule: 'ceiling = floor',
    },
    geometryRefs: [room.id],
  })

  // ── Door count
  const doorFeatures = room.features.filter((f) => f.kind === 'door')
  if (doorFeatures.length > 0) {
    const doorConfidence = Math.min(...doorFeatures.map((f) => roomplanConfidenceToScore(f.confidence)))
    quantities.push({
      id: `${room.id}/doors`,
      description: `${room.label ?? 'Room'} — door count`,
      masterformatCode: '08 14 00',
      ifc: {
        qsetName: 'Qto_DoorBaseQuantities',
        quantityName: 'Count',
        quantityKind: 'Count',
      },
      unit: 'ea',
      value: doorFeatures.length,
      confidence: doorConfidence,
      provenance: makeRoomplanProvenance(roomCommon),
      geometryRefs: [room.id, ...doorFeatures.map((f) => f.id)],
    })
  }

  // ── Window count
  const windowFeatures = room.features.filter((f) => f.kind === 'window')
  if (windowFeatures.length > 0) {
    const windowConfidence = Math.min(...windowFeatures.map((f) => roomplanConfidenceToScore(f.confidence)))
    quantities.push({
      id: `${room.id}/windows`,
      description: `${room.label ?? 'Room'} — window count`,
      masterformatCode: '08 50 00',
      ifc: {
        qsetName: 'Qto_WindowBaseQuantities',
        quantityName: 'Count',
        quantityKind: 'Count',
      },
      unit: 'ea',
      value: windowFeatures.length,
      confidence: windowConfidence,
      provenance: makeRoomplanProvenance(roomCommon),
      geometryRefs: [room.id, ...windowFeatures.map((f) => f.id)],
    })
  }

  // ── Geometry: openings
  for (const f of room.features) {
    geomObjects.push({
      id: f.id,
      category: f.kind,
    })
    geomSurfaces.push({
      id: `${f.id}/surface`,
      kind: 'opening',
      parentRoomId: room.id,
      areaSqFt: round(sqmToSqft(f.areaSqM), 2),
    })
  }

  // ── Fixtures (per object)
  for (const fx of room.fixtures) {
    geomObjects.push({ id: fx.id, category: fx.category })
    const mapping = FIXTURE_CSI[fx.category]
    if (!mapping) continue
    const q: TakeoffQuantity = {
      id: `${room.id}/fixture/${fx.id}`,
      description: `${room.label ?? 'Room'} — ${mapping.description}`,
      unit: 'ea',
      value: 1,
      confidence: roomplanConfidenceToScore(fx.confidence),
      provenance: makeRoomplanProvenance(roomCommon, undefined, fx.id),
      geometryRefs: [room.id, fx.id],
    }
    if (mapping.mf) q.masterformatCode = mapping.mf
    if (mapping.uf) q.uniformatCode = mapping.uf
    quantities.push(q)
  }

  return {
    quantities,
    geometry: {
      rooms: geomRooms,
      surfaces: geomSurfaces,
      objects: geomObjects,
    },
  }
}

// ─── RoomplanArtifact builder ──────────────────────────────────────────────

function buildRoomplanArtifact(
  rooms: RoomComputed[],
  capturedRoomVersion: string,
  capturedRoomJsonUri: string,
): RoomplanArtifact {
  return {
    capturedRoomVersion,
    capturedRoomJsonUri,
    rooms: rooms.map((r) => ({
      id: r.id,
      sectionLabel: r.label,
      floorAreaSqFt: round(sqmToSqft(r.floorAreaSqM), 2),
      perimeterLf: round(mToFt(r.perimeterM), 2),
      walls: r.walls.map((w) => ({
        id: w.id,
        grossAreaSqFt: round(sqmToSqft(w.grossAreaSqM), 2),
        netAreaSqFt: round(sqmToSqft(w.netAreaSqM), 2),
        lengthLf: round(mToFt(w.lengthM), 2),
        heightFt: round(mToFt(w.heightM), 2),
        confidence: w.confidence,
      })),
      features: r.features.map((f) => ({
        id: f.id,
        kind: f.kind,
        widthFt: round(mToFt(f.widthM), 2),
        heightFt: round(mToFt(f.heightM), 2),
        parentWallId: f.parentWallId,
        confidence: f.confidence,
      })),
      fixtures: r.fixtures.map((fx) => ({
        id: fx.id,
        category: fx.category,
        confidence: fx.confidence,
      })),
    })),
  }
}

// ─── Main entry point ──────────────────────────────────────────────────────

export function parseCapturedRoom(opts: ParseCapturedRoomOptions): TakeoffResult {
  const parsed = CapturedRoomInput.safeParse(opts.capturedRoomJson)
  if (!parsed.success) {
    throw new Error(`pipe-roomplan: CapturedRoom JSON failed schema validation: ${parsed.error.message}`)
  }

  const { topLevelId, rooms: rawRooms } = normalizeToRooms(parsed.data)
  if (rawRooms.length === 0) {
    throw new Error('pipe-roomplan: no rooms in CapturedRoom JSON')
  }

  const computedRooms = rawRooms.map(computeRoom)

  // Aggregate quantities + geometry across rooms
  const allQuantities: TakeoffQuantity[] = []
  const geomRooms: NonNullable<TakeoffGeometry['rooms']> = []
  const geomSurfaces: NonNullable<TakeoffGeometry['surfaces']> = []
  const geomObjects: NonNullable<TakeoffGeometry['objects']> = []

  for (const room of computedRooms) {
    const { quantities, geometry } = emitRoomQuantities(room, topLevelId, opts.deviceModel)
    allQuantities.push(...quantities)
    if (geometry.rooms) geomRooms.push(...geometry.rooms)
    if (geometry.surfaces) geomSurfaces.push(...geometry.surfaces)
    if (geometry.objects) geomObjects.push(...geometry.objects)
  }

  // Determine captured-room version string
  const rawInput = parsed.data as { version?: number | string }
  const capturedRoomVersion =
    opts.capturedRoomVersion ?? (rawInput.version !== undefined ? String(rawInput.version) : '1')

  const sourceArtifact: TakeoffResult['sourceArtifact'] = {
    kind: 'roomplan',
    roomplan: buildRoomplanArtifact(
      computedRooms,
      capturedRoomVersion,
      opts.capturedRoomJsonUri ?? `inline:${topLevelId}`,
    ),
  }

  const now = new Date().toISOString()

  const draft: TakeoffResult = {
    schemaVersion: SCHEMA_VERSION,
    takeoffId: randomUUID(),
    projectId: opts.projectId,
    capturedAt: opts.capturedAt ?? now,
    producedAt: now,
    source: 'ios.roomplan',
    pipelineVersion: PIPELINE_VERSION,
    units: 'imperial',
    quantities: allQuantities,
    geometry: {
      rooms: geomRooms,
      surfaces: geomSurfaces,
      objects: geomObjects,
    },
    sourceArtifact,
  }

  const reviewed = applyReviewFloor(draft)
  return validateTakeoffResult(reviewed)
}
