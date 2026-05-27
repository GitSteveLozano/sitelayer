/**
 * Scaffold designer — parametric model generator (pure, deterministic).
 *
 * The #1 Avontus-parity gap: turn a scaffold *design* (a rectangular run of
 * bays × lifts) into (a) a 3D member list the takeoff three.js engine can
 * render, and (b) an aggregated part demand that maps onto `catalog_parts` →
 * `bom_lines` (the schema already reserves `boms.source = 'scaffold_design'`).
 *
 * This module is the load-bearing core: no DB, no I/O, no three.js. The API
 * layer resolves part demand → real `catalog_part_id`s (by system + role +
 * dimension) and persists a BOM; the web layer maps members → three.js. Both
 * are thin shells over this function.
 *
 * Coordinate space: millimetres. x runs along the scaffold length, y across
 * its width, z up. The origin is the first base node.
 */

export type ScaffoldMemberRole =
  | 'base_plate' // adjustable base jack / plate at each ground node
  | 'standard' // vertical post segment (one per lift)
  | 'ledger' // horizontal tube along the LENGTH (bay) direction
  | 'transom' // horizontal tube across the WIDTH direction (carries decks)
  | 'brace' // diagonal face brace
  | 'deck' // platform board/batten spanning a bay
  | 'guardrail' // perimeter guardrail at the top working lift
  | 'toeboard' // perimeter toeboard at the top working lift

export interface Vec3Mm {
  x: number
  y: number
  z: number
}

export interface ScaffoldMember {
  id: string
  role: ScaffoldMemberRole
  start: Vec3Mm
  end: Vec3Mm
  /** Nominal member length in mm (0 for point items such as base plates). */
  lengthMm: number
}

export interface ScaffoldDesignSpec {
  /** Informational system family label (e.g. "cuplock", "ringlock"). */
  systemLabel?: string
  /** Bays along the length (x). >= 1. */
  baysAlongLength: number
  /** Bays across the width (y). >= 1. */
  baysAlongWidth: number
  /** Standard bay length in mm (along x). */
  bayLengthMm: number
  /** Standard bay width in mm (along y). */
  bayWidthMm: number
  /** Lift (level) height in mm. */
  liftHeightMm: number
  /** Number of lifts (vertical levels). >= 1. */
  lifts: number
  options?: ScaffoldDesignOptions
}

export interface ScaffoldDesignOptions {
  /** Base plate/jack at every ground node. Default true. */
  basePlates?: boolean
  /** Perimeter guardrails at the top working lift. Default true. */
  guardrails?: boolean
  /** Perimeter toeboards at the top working lift. Default false. */
  toeboards?: boolean
  /** Lift levels (1..lifts) that get a working deck. Default: [lifts] (top). */
  deckLifts?: number[]
  /** Face brace cadence in bays on the two long faces. Default 1 (every bay). */
  braceEveryNBays?: number
}

/** One aggregated line of part demand, keyed by (role, lengthMm). */
export interface ScaffoldPartDemandLine {
  role: ScaffoldMemberRole
  lengthMm: number
  quantity: number
}

export interface ScaffoldModel {
  members: ScaffoldMember[]
  /** Members aggregated by (role, lengthMm) — the catalog-independent BOM. */
  partDemand: ScaffoldPartDemandLine[]
  bounds: { lengthMm: number; widthMm: number; heightMm: number }
  warnings: string[]
}

function intOrThrow(value: number, name: string, min: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`generateScaffoldModel: ${name} must be an integer >= ${min} (got ${value})`)
  }
  return value
}

function positiveOrThrow(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`generateScaffoldModel: ${name} must be a positive number (got ${value})`)
  }
  return value
}

/**
 * Generate the scaffold member list + aggregated part demand for a rectangular
 * bay×lift scaffold. Deterministic: identical spec ⇒ identical output (stable
 * member ids), so it can back a golden test and an idempotent BOM rebuild.
 */
export function generateScaffoldModel(spec: ScaffoldDesignSpec): ScaffoldModel {
  const nL = intOrThrow(spec.baysAlongLength, 'baysAlongLength', 1)
  const nW = intOrThrow(spec.baysAlongWidth, 'baysAlongWidth', 1)
  const lifts = intOrThrow(spec.lifts, 'lifts', 1)
  const bayLengthMm = positiveOrThrow(spec.bayLengthMm, 'bayLengthMm')
  const bayWidthMm = positiveOrThrow(spec.bayWidthMm, 'bayWidthMm')
  const liftHeightMm = positiveOrThrow(spec.liftHeightMm, 'liftHeightMm')

  const opts = spec.options ?? {}
  const basePlates = opts.basePlates ?? true
  const guardrails = opts.guardrails ?? true
  const toeboards = opts.toeboards ?? false
  const braceEveryNBays = opts.braceEveryNBays ?? 1
  const deckLifts = normalizeDeckLifts(opts.deckLifts, lifts)

  const warnings: string[] = []
  const members: ScaffoldMember[] = []
  const xAt = (i: number) => i * bayLengthMm
  const yAt = (j: number) => j * bayWidthMm
  const zAt = (k: number) => k * liftHeightMm
  const topZ = zAt(lifts)
  let seq = 0
  const push = (role: ScaffoldMemberRole, start: Vec3Mm, end: Vec3Mm, lengthMm: number) => {
    members.push({ id: `${role}-${seq++}`, role, start, end, lengthMm })
  }

  // Ground nodes: (nL+1) × (nW+1).
  for (let i = 0; i <= nL; i++) {
    for (let j = 0; j <= nW; j++) {
      const x = xAt(i)
      const y = yAt(j)
      // Base plates.
      if (basePlates) push('base_plate', { x, y, z: 0 }, { x, y, z: 0 }, 0)
      // Standards: one segment per lift.
      for (let k = 0; k < lifts; k++) {
        push('standard', { x, y, z: zAt(k) }, { x, y, z: zAt(k + 1) }, liftHeightMm)
      }
    }
  }

  // Horizontals at each lift level (top of each lift; skip the ground plane).
  for (let k = 1; k <= lifts; k++) {
    const z = zAt(k)
    // Ledgers along length (x): one per bay, per width line.
    for (let j = 0; j <= nW; j++) {
      const y = yAt(j)
      for (let i = 0; i < nL; i++) {
        push('ledger', { x: xAt(i), y, z }, { x: xAt(i + 1), y, z }, bayLengthMm)
      }
    }
    // Transoms across width (y): one per bay, per length line.
    for (let i = 0; i <= nL; i++) {
      const x = xAt(i)
      for (let j = 0; j < nW; j++) {
        push('transom', { x, y: yAt(j), z }, { x, y: yAt(j + 1), z }, bayWidthMm)
      }
    }
  }

  // Face braces on the two long faces (y=0 and y=max), diagonal across a bay
  // over one lift, every `braceEveryNBays` bays.
  const braceLen = Math.round(Math.hypot(bayLengthMm, liftHeightMm))
  const cadence = braceEveryNBays >= 1 ? braceEveryNBays : 1
  for (const y of [yAt(0), yAt(nW)]) {
    for (let k = 0; k < lifts; k++) {
      for (let i = 0; i < nL; i += cadence) {
        push('brace', { x: xAt(i), y, z: zAt(k) }, { x: xAt(i + 1), y, z: zAt(k + 1) }, braceLen)
      }
    }
  }

  // Decks: one deck unit per bay, per decked lift.
  for (const k of deckLifts) {
    const z = zAt(k)
    for (let i = 0; i < nL; i++) {
      for (let j = 0; j < nW; j++) {
        push('deck', { x: xAt(i), y: yAt(j), z }, { x: xAt(i + 1), y: yAt(j + 1), z }, bayLengthMm)
      }
    }
  }

  // Perimeter guardrails + toeboards at the top working lift.
  const perimeter = (role: ScaffoldMemberRole) => {
    for (let i = 0; i < nL; i++) {
      push(role, { x: xAt(i), y: yAt(0), z: topZ }, { x: xAt(i + 1), y: yAt(0), z: topZ }, bayLengthMm)
      push(role, { x: xAt(i), y: yAt(nW), z: topZ }, { x: xAt(i + 1), y: yAt(nW), z: topZ }, bayLengthMm)
    }
    for (let j = 0; j < nW; j++) {
      push(role, { x: xAt(0), y: yAt(j), z: topZ }, { x: xAt(0), y: yAt(j + 1), z: topZ }, bayWidthMm)
      push(role, { x: xAt(nL), y: yAt(j), z: topZ }, { x: xAt(nL), y: yAt(j + 1), z: topZ }, bayWidthMm)
    }
  }
  if (guardrails) perimeter('guardrail')
  if (toeboards) perimeter('toeboard')

  if (deckLifts.length === 0) warnings.push('No decked lifts — the scaffold has no working platform.')
  if (lifts >= 4 && braceEveryNBays > 1) {
    warnings.push('Tall scaffold with sparse bracing — verify the bracing pattern against the design code.')
  }

  return {
    members,
    partDemand: aggregatePartDemand(members),
    bounds: { lengthMm: nL * bayLengthMm, widthMm: nW * bayWidthMm, heightMm: topZ },
    warnings,
  }
}

function normalizeDeckLifts(deckLifts: number[] | undefined, lifts: number): number[] {
  if (!deckLifts) return [lifts]
  const valid = Array.from(new Set(deckLifts.filter((k) => Number.isInteger(k) && k >= 1 && k <= lifts)))
  valid.sort((a, b) => a - b)
  return valid
}

/** Aggregate members into (role, lengthMm) demand lines, sorted stably. */
export function aggregatePartDemand(members: readonly ScaffoldMember[]): ScaffoldPartDemandLine[] {
  const byKey = new Map<string, ScaffoldPartDemandLine>()
  for (const member of members) {
    const key = `${member.role}:${member.lengthMm}`
    const existing = byKey.get(key)
    if (existing) existing.quantity += 1
    else byKey.set(key, { role: member.role, lengthMm: member.lengthMm, quantity: 1 })
  }
  return [...byKey.values()].sort((a, b) => (a.role === b.role ? a.lengthMm - b.lengthMm : a.role < b.role ? -1 : 1))
}
