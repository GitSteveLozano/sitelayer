import type { BlueprintPage, CapturedGeometry, TakeoffMeasurement } from '@/lib/api'

export interface TakeoffDemoFixture {
  id: string
  name: string
  label: string
  description: string
  referenceTitle: string
  referenceNotes: string[]
  referenceImageUrl: string
  blueprintId: string
  page: BlueprintPage
  measurements: TakeoffMeasurement[]
  /**
   * Optional captured-draft `TakeoffGeometry` (rooms / surfaces / objects) for
   * the public harness. When present, the demo feeds it through the same
   * `buildCapturedGeometryScene` adapter the in-app preview uses, so a captured
   * draft renders in 3D here too — without any committed measurements. The
   * `capturedSource` tags the pipeline so drone lon/lat footprints project at
   * true scale; everything else bounds-normalizes (relative shape only).
   */
  capturedGeometry?: CapturedGeometry
  capturedSource?: string
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
    referenceImageUrl: blueprintSvgDataUrl([
      '<rect x="18" y="24" width="58" height="14" class="room" />',
      '<polyline points="20,70 42,76 66,72 80,62" class="run" />',
      '<circle cx="30" cy="48" r="2.5" class="opening" />',
      '<circle cx="52" cy="48" r="2.5" class="opening" />',
      '<circle cx="74" cy="48" r="2.5" class="opening" />',
    ]),
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
    referenceImageUrl: blueprintSvgDataUrl([
      '<rect x="16" y="18" width="40" height="36" class="room" />',
      '<rect x="56" y="18" width="26" height="26" class="room" />',
      '<rect x="18" y="58" width="28" height="24" class="room" />',
      '<polyline points="16,18 82,18 82,82 18,82 16,18" class="shell" />',
      '<polyline points="56,18 56,54 46,58 46,82" class="run" />',
      '<circle cx="56" cy="33" r="2.5" class="door" />',
      '<circle cx="46" cy="70" r="2.5" class="door" />',
      '<circle cx="82" cy="30" r="2.5" class="opening" />',
      '<circle cx="82" cy="40" r="2.5" class="opening" />',
      '<circle cx="34" cy="82" r="2.5" class="opening" />',
    ]),
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
    referenceImageUrl: blueprintSvgDataUrl([
      '<rect x="18" y="42" width="58" height="16" class="room" />',
      '<rect x="30" y="58" width="28" height="10" class="room" />',
      '<polyline points="24,34 76,34" class="run" />',
      '<polyline points="18,42 47,28 76,42" class="shell" />',
      '<circle cx="26" cy="50" r="2.5" class="opening" />',
      '<circle cx="46" cy="58" r="2.8" class="door" />',
      '<circle cx="72" cy="50" r="2.5" class="opening" />',
    ]),
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
  {
    id: 'captured-room',
    name: 'Captured RoomPlan draft',
    label: 'Captured',
    description:
      'A captured-draft TakeoffGeometry (room floor, walls, a door opening, and a fixture) rendered straight from the capture pipeline — no committed measurements. Source-space coordinates bounds-normalize to a relative span.',
    referenceTitle: 'Captured geometry (pre-promotion)',
    referenceNotes: [
      'Drawn entirely from the captured TakeoffGeometry block — there are zero committed measurements in this fixture.',
      'Surfaces map floor→polygon, wall→lineal, opening→count marker; objects[] become fixture count markers.',
      'Good for asking a model whether the captured shape, wall layout, and opening placement survive the 2.5D extrusion.',
    ],
    referenceImageUrl: blueprintSvgDataUrl([
      '<rect x="20" y="20" width="60" height="50" class="room" />',
      '<polyline points="20,20 80,20 80,70 20,70 20,20" class="shell" />',
      '<polyline points="20,45 50,45" class="run" />',
      '<rect x="44" y="68" width="12" height="4" class="door" />',
      '<circle cx="32" cy="60" r="2.8" class="opening" />',
    ]),
    blueprintId: 'demo-blueprint-captured',
    page: page('demo-page-captured', 'demo-blueprint-captured', '20', '70', '80', '70', '40'),
    measurements: [],
    capturedSource: 'ios.roomplan',
    capturedGeometry: {
      rooms: [{ id: 'cap-room-1', label: 'Studio', floorAreaSqFt: 300, perimeterLf: 70 }],
      surfaces: [
        // 600 x 500 source-space rectangle (largest span normalizes to ~60 ft).
        {
          id: 'cap-floor-1',
          kind: 'floor',
          parentRoomId: 'cap-room-1',
          areaSqFt: 300,
          polygon: [
            [0, 0],
            [600, 0],
            [600, 500],
            [0, 500],
          ],
        },
        {
          id: 'cap-wall-north',
          kind: 'wall',
          parentRoomId: 'cap-room-1',
          polygon: [
            [0, 0],
            [600, 0],
          ],
        },
        {
          id: 'cap-wall-west',
          kind: 'wall',
          parentRoomId: 'cap-room-1',
          polygon: [
            [0, 0],
            [0, 500],
          ],
        },
        {
          id: 'cap-door-1',
          kind: 'opening',
          parentRoomId: 'cap-room-1',
          polygon: [
            [260, 500],
            [340, 500],
            [340, 480],
            [260, 480],
          ],
        },
      ],
      objects: [{ id: 'cap-fixture-1', category: 'sink', bbox: [120, 360, 40, 40] }],
    },
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
    scale_verified_at: null,
    scale_verified_by: null,
    measurement_count: 0,
  }
}

function blueprintSvgDataUrl(elements: string[]): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <style>
      .sheet{fill:#f8fafc}.grid{stroke:#d8dee9;stroke-width:.18}.room{fill:#dceafe;stroke:#334155;stroke-width:.8}.shell{fill:none;stroke:#111827;stroke-width:1.1}.run{fill:none;stroke:#475569;stroke-width:.8;stroke-dasharray:2 1}.opening{fill:#fef3c7;stroke:#92400e;stroke-width:.7}.door{fill:#fee2e2;stroke:#991b1b;stroke-width:.7}
    </style>
    <rect width="100" height="100" class="sheet"/>
    ${Array.from({ length: 11 }, (_, index) => `<line x1="${index * 10}" y1="0" x2="${index * 10}" y2="100" class="grid"/><line x1="0" y1="${index * 10}" x2="100" y2="${index * 10}" class="grid"/>`).join('')}
    ${elements.join('')}
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
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
    page_id: blueprintId.replace('demo-blueprint', 'demo-page'),
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
