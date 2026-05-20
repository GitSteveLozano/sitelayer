import type { BlueprintPage, TakeoffMeasurement } from '@/lib/api'

export interface TakeoffDemoFixture {
  id: string
  name: string
  label: string
  description: string
  referenceTitle: string
  referenceNotes: string[]
  blueprintId: string
  page: BlueprintPage
  measurements: TakeoffMeasurement[]
}

const CREATED_AT = '2026-05-20T00:00:00.000Z'

export const TAKEOFF_DEMO_FIXTURES: TakeoffDemoFixture[] = [
  {
    id: 'simple-house',
    name: 'Simple house plan',
    label: 'House plan',
    description: 'Small mixed takeoff with wall area, insulation run, window counts, and footing volume.',
    referenceTitle: 'Synthetic house takeoff',
    referenceNotes: [
      'Uses reviewed-style measurement rows only.',
      'Good baseline for checking selection, scale, and service item color mapping.',
    ],
    blueprintId: 'demo-blueprint-simple',
    page: page('demo-page-simple', 'demo-blueprint-simple', '18', '82', '82', '82', '48'),
    measurements: [
      polygon('demo-wall-south', 'demo-blueprint-simple', '09 29 00', '240.00', 'sqft', 'south wall area', 'south', [
        [20, 24],
        [76, 24],
        [76, 38],
        [20, 38],
      ]),
      lineal('demo-insulation-east', 'demo-blueprint-simple', '07 21 00', '52.00', 'lf', null, 'east', [
        [20, 70],
        [42, 76],
        [66, 72],
        [80, 62],
      ]),
      count('demo-windows-north', 'demo-blueprint-simple', '08 50 00', '3.00', 'ea', null, 'north', [
        [30, 48],
        [52, 48],
        [74, 48],
      ]),
      volume('demo-footing', 'demo-blueprint-simple', '03 30 00', '18.00', 'cy', null, null, 8, 6, 4),
    ],
  },
  {
    id: 'floor-plan',
    name: 'Blueprint-style floor plan',
    label: 'Floor plan',
    description: 'Room-shaped polygons and opening counts that are closer to a public floor-plan extraction test.',
    referenceTitle: 'Public-fixture style plan',
    referenceNotes: [
      'Synthetic coordinates, shaped like the public-domain blueprint fixtures documented for model tests.',
      'Good for asking Gemini or Claude whether the extrusion preserves room adjacency and openings.',
    ],
    blueprintId: 'demo-blueprint-floor',
    page: page('demo-page-floor', 'demo-blueprint-floor', '10', '88', '90', '88', '64'),
    measurements: [
      polygon('demo-great-room', 'demo-blueprint-floor', '06 20 00', '512.00', 'sqft', 'great room footprint', null, [
        [16, 18],
        [56, 18],
        [56, 54],
        [16, 54],
      ]),
      polygon('demo-kitchen', 'demo-blueprint-floor', '12 30 00', '168.00', 'sqft', 'kitchen footprint', null, [
        [56, 18],
        [82, 18],
        [82, 44],
        [56, 44],
      ]),
      polygon('demo-bedroom', 'demo-blueprint-floor', '09 29 00', '196.00', 'sqft', 'bedroom wall area proxy', null, [
        [18, 58],
        [46, 58],
        [46, 82],
        [18, 82],
      ]),
      lineal('demo-interior-walls', 'demo-blueprint-floor', '09 22 16', '92.00', 'lf', 'interior partition run', null, [
        [56, 18],
        [56, 54],
        [46, 58],
        [46, 82],
      ]),
      lineal(
        'demo-exterior-trim',
        'demo-blueprint-floor',
        '06 46 00',
        '188.00',
        'lf',
        'exterior trim perimeter',
        null,
        [
          [16, 18],
          [82, 18],
          [82, 82],
          [18, 82],
          [16, 18],
        ],
      ),
      count('demo-doors', 'demo-blueprint-floor', '08 14 00', '5.00', 'ea', 'door openings', null, [
        [56, 33],
        [46, 70],
        [30, 58],
        [70, 44],
        [22, 18],
      ]),
      count('demo-windows', 'demo-blueprint-floor', '08 50 00', '8.00', 'ea', 'window openings', null, [
        [24, 18],
        [40, 18],
        [68, 18],
        [82, 30],
        [82, 40],
        [34, 82],
        [18, 66],
        [16, 36],
      ]),
    ],
  },
  {
    id: 'exterior-reference',
    name: 'Exterior reference massing',
    label: 'Exterior',
    description:
      'Simple volume and elevation tags for checking whether a photo/reference-driven massing pass is legible.',
    referenceTitle: 'Photo-reference style massing',
    referenceNotes: [
      'Represents what a model might propose after seeing a house photo plus a minimal plan.',
      'Useful for checking whether roof, openings, facade, and foundation cues need a richer schema.',
    ],
    blueprintId: 'demo-blueprint-exterior',
    page: page('demo-page-exterior', 'demo-blueprint-exterior', '14', '86', '86', '86', '56'),
    measurements: [
      volume(
        'demo-main-mass',
        'demo-blueprint-exterior',
        '06 10 00',
        '1.00',
        'ea',
        'main house mass',
        null,
        44,
        28,
        14,
      ),
      volume('demo-garage-mass', 'demo-blueprint-exterior', '06 10 00', '1.00', 'ea', 'garage mass', null, 24, 24, 10),
      polygon(
        'demo-front-facade',
        'demo-blueprint-exterior',
        '09 29 00',
        '392.00',
        'sqft',
        'front facade area',
        'front',
        [
          [16, 42],
          [78, 42],
          [78, 58],
          [16, 58],
        ],
      ),
      lineal('demo-roof-ridge', 'demo-blueprint-exterior', '07 31 00', '48.00', 'lf', 'roof ridge line', 'roof', [
        [24, 34],
        [76, 34],
      ]),
      lineal(
        'demo-front-porch-rail',
        'demo-blueprint-exterior',
        '06 46 00',
        '32.00',
        'lf',
        'front porch rail',
        'front',
        [
          [28, 64],
          [60, 64],
        ],
      ),
      count(
        'demo-front-openings',
        'demo-blueprint-exterior',
        '08 50 00',
        '6.00',
        'ea',
        'visible window and door openings',
        'front',
        [
          [26, 50],
          [38, 50],
          [50, 50],
          [62, 50],
          [72, 50],
          [46, 58],
        ],
      ),
    ],
  },
]

function page(
  id: string,
  blueprintId: string,
  x1: string,
  y1: string,
  x2: string,
  y2: string,
  distance: string,
): BlueprintPage {
  return {
    id,
    blueprint_document_id: blueprintId,
    page_number: 1,
    storage_path: null,
    calibration_x1: x1,
    calibration_y1: y1,
    calibration_x2: x2,
    calibration_y2: y2,
    calibration_world_distance: distance,
    calibration_world_unit: 'ft',
    calibration_set_at: CREATED_AT,
    measurement_count: 0,
  }
}

function polygon(
  id: string,
  blueprintId: string,
  serviceItemCode: string,
  quantity: string,
  unit: string,
  notes: string | null,
  elevation: string | null,
  points: Array<[number, number]>,
): TakeoffMeasurement {
  return measurement(id, blueprintId, serviceItemCode, quantity, unit, notes, elevation, {
    kind: 'polygon',
    points: points.map(([x, y]) => ({ x, y })),
  })
}

function lineal(
  id: string,
  blueprintId: string,
  serviceItemCode: string,
  quantity: string,
  unit: string,
  notes: string | null,
  elevation: string | null,
  points: Array<[number, number]>,
): TakeoffMeasurement {
  return measurement(id, blueprintId, serviceItemCode, quantity, unit, notes, elevation, {
    kind: 'lineal',
    points: points.map(([x, y]) => ({ x, y })),
  })
}

function count(
  id: string,
  blueprintId: string,
  serviceItemCode: string,
  quantity: string,
  unit: string,
  notes: string | null,
  elevation: string | null,
  points: Array<[number, number]>,
): TakeoffMeasurement {
  return measurement(id, blueprintId, serviceItemCode, quantity, unit, notes, elevation, {
    kind: 'count',
    points: points.map(([x, y]) => ({ x, y })),
  })
}

function volume(
  id: string,
  blueprintId: string,
  serviceItemCode: string,
  quantity: string,
  unit: string,
  notes: string | null,
  elevation: string | null,
  length: number,
  width: number,
  height: number,
): TakeoffMeasurement {
  return measurement(id, blueprintId, serviceItemCode, quantity, unit, notes, elevation, {
    kind: 'volume',
    length,
    width,
    height,
  })
}

function measurement(
  id: string,
  blueprintId: string,
  serviceItemCode: string,
  quantity: string,
  unit: string,
  notes: string | null,
  elevation: string | null,
  geometry: TakeoffMeasurement['geometry'],
): TakeoffMeasurement {
  return {
    id,
    project_id: 'demo-project',
    blueprint_document_id: blueprintId,
    service_item_code: serviceItemCode,
    quantity,
    unit,
    notes,
    elevation,
    image_thumbnail: null,
    geometry,
    version: 1,
    created_at: CREATED_AT,
  }
}
