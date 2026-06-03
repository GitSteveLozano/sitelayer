import {
  takeoffSessionSeedActor,
  type TakeoffSessionMachine,
  type TakeoffSessionActor,
  type TakeoffSessionSeed,
  type BuildTakeoffSessionContextInput,
} from './takeoff-session'

/**
 * Named takeoff-canvas state catalog — the "jump into any state" seam.
 *
 * Each entry is a {@link TakeoffSessionSeed}: the machine state value to boot
 * into + the context slices that make it meaningful. Two consumers:
 *   - unit/component tests: `takeoffSessionSeedActor(machine, seed)` lands the
 *     canvas in e.g. mid-polygon-draw with no clicks.
 *   - the dev `?seed=<name>` affordance: a tester opens the canvas straight in a
 *     given UI state on top of whatever DB scenario is seeded (works under the
 *     act-as bypass, tier!=='prod').
 *
 * These cover CLIENT (UI) states. Data states (drawn measurements, calibrated
 * pages, AI result_json) come from the DB via @sitelayer/scenario
 * (scenarios/takeoff-canvas-states.yaml) — the two compose: seed the DB, then
 * `?seed=` the UI posture.
 */

export type TakeoffSeedName =
  | 'empty'
  | 'drawing-empty'
  | 'drawing-polygon'
  | 'drawing-lineal'
  | 'drawing-count'
  | 'calibrating'
  | 'calibrating-ready'
  | 'calibrated-idle'
  | 'selecting'
  | 'editing-vertex'
  | 'ai-configuring'
  | 'ai-reviewing'

export const TAKEOFF_SEED_NAMES: readonly TakeoffSeedName[] = [
  'empty',
  'drawing-empty',
  'drawing-polygon',
  'drawing-lineal',
  'drawing-count',
  'calibrating',
  'calibrating-ready',
  'calibrated-idle',
  'selecting',
  'editing-vertex',
  'ai-configuring',
  'ai-reviewing',
]

/** Base identifiers a seed is grafted onto — the real route's project/company
 *  (+ optional active blueprint/page/draft) so the seeded UI points at real DB rows. */
export type TakeoffSeedBase = Pick<
  BuildTakeoffSessionContextInput,
  'projectId' | 'companySlug' | 'blueprintId' | 'pageId' | 'draftId'
>

const TRI = [
  { x: 20, y: 20 },
  { x: 80, y: 20 },
  { x: 50, y: 70 },
]

/** Build the seed for `name`, grafting the route's real ids over the template. */
export function resolveTakeoffSeed(name: string, base: TakeoffSeedBase): TakeoffSessionSeed | null {
  const ctx = (extra: Partial<BuildTakeoffSessionContextInput> = {}): BuildTakeoffSessionContextInput => ({
    ...base,
    ...extra,
  })

  switch (name as TakeoffSeedName) {
    case 'empty':
      return { value: 'idle', context: ctx() }

    case 'drawing-empty':
      return { value: { drawing: 'placing' }, context: ctx({ draft: { tool: 'polygon' } }) }

    case 'drawing-polygon':
      // Mid-polygon, scope set → COMMIT is enabled (canCommit true).
      return {
        value: { drawing: 'placing' },
        context: ctx({ draft: { tool: 'polygon', serviceItemCode: 'EPS', points: TRI } }),
      }

    case 'drawing-lineal':
      return {
        value: { drawing: 'placing' },
        context: ctx({
          draft: {
            tool: 'lineal',
            serviceItemCode: 'Basecoat',
            points: [
              { x: 20, y: 60 },
              { x: 80, y: 60 },
            ],
          },
        }),
      }

    case 'drawing-count':
      return {
        value: { drawing: 'placing' },
        context: ctx({
          draft: {
            tool: 'count',
            serviceItemCode: 'Finish Coat',
            points: [
              { x: 30, y: 30 },
              { x: 50, y: 30 },
            ],
          },
        }),
      }

    case 'calibrating':
      // One reference point placed — not yet ready to apply.
      return { value: { calibrating: 'placing' }, context: ctx({ calibration: { points: [{ x: 10, y: 50 }] } }) }

    case 'calibrating-ready':
      // Two points + a typed length → APPLY_CALIBRATION is enabled.
      return {
        value: { calibrating: 'placing' },
        context: ctx({
          calibration: {
            points: [
              { x: 10, y: 50 },
              { x: 34, y: 50 },
            ],
            lengthText: '24',
            unit: 'ft',
          },
        }),
      }

    case 'calibrated-idle':
      // Idle on a verified-scale page (quantities read true sqft/lf downstream).
      return {
        value: 'idle',
        context: ctx({
          calibration: {
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
            lengthText: '24',
            unit: 'ft',
          },
        }),
      }

    case 'selecting':
      return { value: { selecting: 'browsing' }, context: ctx({ selection: { selectedId: 'seed-measurement-1' } }) }

    case 'editing-vertex':
      return {
        value: { selecting: 'editingVertex' },
        context: ctx({ selection: { editGeomId: 'seed-measurement-1', editPoints: TRI } }),
      }

    case 'ai-configuring':
      return {
        value: { capturing: 'configuring' },
        context: ctx({ capture: { kind: 'blueprint_vision', mode: 'dry-run' } }),
      }

    case 'ai-reviewing':
      // AI proposals loaded, awaiting accept/reject/promote.
      return {
        value: { capturing: 'reviewing' },
        context: ctx({
          capture: {
            kind: 'blueprint_vision',
            mode: 'live',
            result: {
              quantities: [
                { id: 'q1', service_item_code: 'EPS', quantity: 2400, unit: 'sqft', confidence: 0.93 },
                { id: 'q2', service_item_code: 'Basecoat', quantity: 320, unit: 'lf', confidence: 0.71 },
                { id: 'q3', service_item_code: 'Finish Coat', quantity: 6, unit: 'ea', confidence: 0.42 },
              ],
            },
          },
        }),
      }

    default:
      return null
  }
}

/** Boot an actor straight into the named state (test + dev-jump convenience). */
export function seedTakeoffSessionActor(
  machine: TakeoffSessionMachine,
  name: string,
  base: TakeoffSeedBase,
): TakeoffSessionActor | null {
  const seed = resolveTakeoffSeed(name, base)
  return seed ? takeoffSessionSeedActor(machine, seed) : null
}
