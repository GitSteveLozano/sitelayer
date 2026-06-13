import { z } from 'zod'

// ─── Versioning ────────────────────────────────────────────────────────────
export const SCHEMA_VERSION = '1.0.0' as const
export const SchemaVersion = z.literal(SCHEMA_VERSION)

export const CaptureSource = z.enum([
  'ios.roomplan',
  'photogrammetry',
  'drone.photogrammetry',
  'blueprint.vision',
  'manual',
])
export type CaptureSource = z.infer<typeof CaptureSource>

// ─── Units ────────────────────────────────────────────────────────────────
// Pipelines emit imperial by default. RoomPlan converts SI→imperial on emit.
export const Unit = z.enum(['sqft', 'sqm', 'lft', 'lm', 'cy', 'cm', 'ea', 'lb', 'kg', 'gal', 'hr'])
export type Unit = z.infer<typeof Unit>

export const IfcQuantityKind = z.enum(['Length', 'Area', 'Volume', 'Count', 'Weight', 'Time'])
export type IfcQuantityKind = z.infer<typeof IfcQuantityKind>

// ─── Provenance discriminator ─────────────────────────────────────────────
const ProvenanceRoomplan = z.object({
  kind: z.literal('roomplan'),
  capturedRoomId: z.string(),
  surfaceId: z.string().optional(),
  objectId: z.string().optional(),
  deviceModel: z.string().optional(),
})

const ProvenancePhotogrammetry = z.object({
  kind: z.literal('photogrammetry'),
  meshId: z.string(),
  faceIds: z.array(z.string()).optional(),
  planeId: z.string().optional(),
  vendorJobId: z.string().optional(),
})

const ProvenanceDrone = z.object({
  kind: z.literal('drone'),
  orthomosaicId: z.string(),
  polygonId: z.string().optional(),
  altitudeM: z.number().optional(),
})

export const DimensionSourceType = z.enum(['measured', 'annotated', 'inferred'])
export type DimensionSourceType = z.infer<typeof DimensionSourceType>

const ProvenanceBlueprint = z.object({
  kind: z.literal('blueprint'),
  pdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageIndex: z.number().int().min(0),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  scaleFt: z.number().optional(),
  detector: z.string(),
  detectorVersion: z.string(),
  dimensionSourceType: DimensionSourceType.optional(),
})

const ProvenanceManual = z.object({
  kind: z.literal('manual'),
  userId: z.string(),
  note: z.string().optional(),
})

const ProvenanceDerived = z.object({
  kind: z.literal('derived'),
  from: z.array(z.string()),
  rule: z.string(),
})

export const TakeoffProvenance = z.discriminatedUnion('kind', [
  ProvenanceRoomplan,
  ProvenancePhotogrammetry,
  ProvenanceDrone,
  ProvenanceBlueprint,
  ProvenanceManual,
  ProvenanceDerived,
])
export type TakeoffProvenance = z.infer<typeof TakeoffProvenance>

// ─── IFC binding (optional) ───────────────────────────────────────────────
export const IfcBinding = z.object({
  qsetName: z.string().regex(/^Qto_/),
  quantityName: z.string(),
  quantityKind: IfcQuantityKind,
  bsddClassUri: z.string().url().optional(),
})
export type IfcBinding = z.infer<typeof IfcBinding>

// ─── Uniform quantity (the load-bearing record) ──────────────────────────
const masterformatPattern = /^\d{2} \d{2} \d{2}(\.\d{2})?$/
const uniformatPattern = /^[A-G]\d{4}([A-Z]\d{2})?$/
const omniclassPattern = /^\d{2}-\d{2} \d{2} \d{2}( \d{2})?$/

export const TakeoffQuantity = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    masterformatCode: z.string().regex(masterformatPattern).optional(),
    uniformatCode: z.string().regex(uniformatPattern).optional(),
    omniclassCode: z.string().regex(omniclassPattern).optional(),
    ifc: IfcBinding.optional(),
    unit: Unit,
    value: z.number().min(0),
    confidence: z.number().min(0).max(1),
    provenance: TakeoffProvenance,
    geometryRefs: z.array(z.string()).optional(),
  })
  .refine((q) => q.masterformatCode != null || q.uniformatCode != null, {
    message: 'TakeoffQuantity requires masterformatCode or uniformatCode',
  })
export type TakeoffQuantity = z.infer<typeof TakeoffQuantity>

// ─── Lean cross-pipeline geometry ────────────────────────────────────────
export const TakeoffGeometry = z.object({
  rooms: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        story: z.number().int().optional(),
        floorAreaSqFt: z.number().optional(),
        perimeterLf: z.number().optional(),
      }),
    )
    .optional(),
  surfaces: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['wall', 'floor', 'ceiling', 'roof', 'facade', 'opening']),
        parentRoomId: z.string().optional(),
        areaSqFt: z.number().optional(),
        polygon: z.array(z.array(z.number())).optional(),
      }),
    )
    .optional(),
  // Captured wall lines (plan-view start/end + height). Unlike `surfaces[].polygon`
  // (a flat footprint), a wall is a vertical plane: the renderer extrudes the
  // start→end run up by `heightFt`. Coordinates share the surface-polygon convention
  // (`[x, y]` = plan-view east/south, feet for RoomPlan). RoomPlan emits these from
  // each captured wall so wall geometry — not just metrics — reaches the 3D scene.
  walls: z
    .array(
      z.object({
        id: z.string(),
        parentRoomId: z.string().optional(),
        start: z.tuple([z.number(), z.number()]),
        end: z.tuple([z.number(), z.number()]),
        heightFt: z.number(),
        thicknessFt: z.number().optional(),
      }),
    )
    .optional(),
  objects: z
    .array(
      z.object({
        id: z.string(),
        category: z.string(),
        bbox: z.array(z.number()).optional(),
      }),
    )
    .optional(),
  rasterRefs: z
    .array(
      z.object({
        id: z.string(),
        uri: z.string(),
        pageIndex: z.number().int().optional(),
        mime: z.string(),
      }),
    )
    .optional(),
})
export type TakeoffGeometry = z.infer<typeof TakeoffGeometry>

// ─── Pipeline-native artifact (optional rich data) ───────────────────────
const RoomplanConfidenceEnum = z.enum(['high', 'medium', 'low'])

const RoomplanArtifact = z.object({
  capturedRoomVersion: z.string(),
  capturedRoomJsonUri: z.string(),
  rooms: z.array(
    z.object({
      id: z.string(),
      sectionLabel: z.string().optional(),
      floorAreaSqFt: z.number(),
      perimeterLf: z.number(),
      walls: z.array(
        z.object({
          id: z.string(),
          grossAreaSqFt: z.number(),
          netAreaSqFt: z.number(),
          lengthLf: z.number(),
          heightFt: z.number(),
          confidence: RoomplanConfidenceEnum,
        }),
      ),
      features: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(['door', 'window', 'opening']),
          widthFt: z.number(),
          heightFt: z.number(),
          parentWallId: z.string(),
          confidence: RoomplanConfidenceEnum,
        }),
      ),
      fixtures: z.array(
        z.object({
          id: z.string(),
          category: z.string(),
          confidence: RoomplanConfidenceEnum,
        }),
      ),
    }),
  ),
})

const PhotogrammetryArtifact = z.object({
  vendor: z.enum(['luma', 'polycam', 'kiri', 'colmap-self-hosted', 'apple-object-capture']),
  vendorJobId: z.string(),
  meshUrl: z.string(),
  meshFormat: z.enum(['obj', 'glb', 'usdz']),
  pointCloudUrl: z.string().optional(),
  textureAtlasUrl: z.string().optional(),
  previewImageUrl: z.string().optional(),
  scale: z.object({
    method: z.enum([
      'vendor-arkit-depth',
      'vendor-arcore-depth',
      'fiducial-marker',
      'known-object',
      'manual-two-point',
      'unscaled',
    ]),
    metersPerUnit: z.number(),
    confidence: z.enum(['high', 'medium', 'low', 'unknown']),
  }),
  qa: z.object({
    coveragePct: z.number().min(0).max(100),
    blindSpots: z.array(z.string()),
    reconstructionMeanErrorM: z.number().optional(),
  }),
})

const GeoJSONPolygon = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.array(z.number()))),
})
export type GeoJSONPolygon = z.infer<typeof GeoJSONPolygon>

const DroneArtifact = z.object({
  siteCenter: z.object({ lat: z.number(), lon: z.number() }),
  crs: z.string(),
  reconstruction: z.object({
    engine: z.enum(['ODM', 'DroneDeploy', 'Pix4D', 'EagleView', 'Hover']),
    imageCount: z.number().int().min(0),
    gsdCm: z.number(),
    rmseHorizontalM: z.number().optional(),
    rmseVerticalM: z.number().optional(),
  }),
  artifacts: z.object({
    orthoUrl: z.string(),
    dsmUrl: z.string().optional(),
    dtmUrl: z.string().optional(),
    pointCloudUrl: z.string().optional(),
    meshUrl: z.string().optional(),
  }),
  buildings: z.array(
    z.object({
      id: z.string(),
      footprint: GeoJSONPolygon,
      footprintAreaSqft: z.number(),
      eaveHeightFt: z.number(),
      ridgeHeightFt: z.number(),
      exteriorWallAreaSqft: z.number(),
      roofPlanes: z.array(
        z.object({
          id: z.string(),
          polygon: GeoJSONPolygon,
          areaSqft: z.number(),
          projectedAreaSqft: z.number(),
          pitchDegrees: z.number(),
          pitchRatio: z.string(),
          azimuthDegrees: z.number(),
          materialGuess: z.enum(['asphalt-shingle', 'metal', 'tile', 'membrane', 'unknown']).optional(),
          materialConfidence: z.number().min(0).max(1).optional(),
        }),
      ),
    }),
  ),
  sitework: z
    .object({
      targetGrade: z
        .union([
          z.object({ type: z.literal('constant'), elevationM: z.number() }),
          z.object({
            type: z.literal('plane'),
            equation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          }),
          z.object({ type: z.literal('dtmDeltaUrl'), url: z.string() }),
        ])
        .optional(),
      cutCubicYards: z.number(),
      fillCubicYards: z.number(),
      netCubicYards: z.number(),
      boundary: GeoJSONPolygon,
    })
    .optional(),
  surfacing: z
    .array(
      z.object({
        id: z.string(),
        material: z.enum(['asphalt', 'concrete', 'gravel', 'pavers', 'vegetation', 'bare-soil', 'other']),
        polygon: GeoJSONPolygon,
        areaSqft: z.number(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .optional(),
})

const blueprintDimension = z.object({
  value: z.number(),
  sourceType: DimensionSourceType,
  confidence: z.number().min(0).max(1),
})

const BlueprintArtifact = z.object({
  sourcePdfPath: z.string(),
  pdfSha256: z.string(),
  pdfMeta: z.object({
    pages: z.number().int().min(0),
    pageSizesPts: z.array(z.object({ w: z.number(), h: z.number() })),
  }),
  modelVersion: z.string(),
  promptVersion: z.string(),
  pages: z.array(
    z.object({
      pageIndex: z.number().int().min(0),
      imageSize: z.object({
        widthPx: z.number().int(),
        heightPx: z.number().int(),
      }),
      classification: z.object({
        kind: z.enum([
          'floor_plan',
          'elevation',
          'section',
          'site_plan',
          'detail',
          'schedule',
          'titleblock_only',
          'non_drawing',
        ]),
        confidence: z.number().min(0).max(1),
      }),
      titleblock: z
        .object({
          projectName: z.string().optional(),
          sheetNumber: z.string().optional(),
          sheetTitle: z.string().optional(),
          scaleText: z.string().optional(),
          northArrowDeg: z.number().optional(),
          drawingDate: z.string().optional(),
        })
        .optional(),
      scale: z
        .object({
          pixelsPerFoot: z.number(),
          source: z.enum(['titleblock_text', 'scale_bar', 'user_known_dimension', 'inferred']),
          confidence: z.number().min(0).max(1),
        })
        .optional(),
      scaleConfidence: z.number().min(0).max(1),
      rooms: z.array(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          polygon: z.array(z.object({ x: z.number(), y: z.number() })),
          areaSqFt: blueprintDimension.optional(),
          perimeterFt: blueprintDimension.optional(),
          openings: z.array(
            z.object({
              kind: z.enum(['door', 'window', 'opening']),
              position: z.object({ x: z.number(), y: z.number() }),
              widthFt: blueprintDimension.optional(),
              swing: z.enum(['left', 'right', 'none']).optional(),
              hostWallId: z.string().optional(),
            }),
          ),
        }),
      ),
      walls: z.array(
        z.object({
          id: z.string(),
          start: z.object({ x: z.number(), y: z.number() }),
          end: z.object({ x: z.number(), y: z.number() }),
          thicknessIn: z.number().optional(),
          lengthFt: blueprintDimension.optional(),
        }),
      ),
      notes: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
  ),
})

export const SourceArtifact = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('roomplan'), roomplan: RoomplanArtifact }),
  z.object({
    kind: z.literal('photogrammetry'),
    photogrammetry: PhotogrammetryArtifact,
  }),
  z.object({ kind: z.literal('drone'), drone: DroneArtifact }),
  z.object({ kind: z.literal('blueprint'), blueprint: BlueprintArtifact }),
])
export type SourceArtifact = z.infer<typeof SourceArtifact>

export type RoomplanArtifact = z.infer<typeof RoomplanArtifact>
export type PhotogrammetryArtifact = z.infer<typeof PhotogrammetryArtifact>
export type DroneArtifact = z.infer<typeof DroneArtifact>
export type BlueprintArtifact = z.infer<typeof BlueprintArtifact>

// ─── Warnings ────────────────────────────────────────────────────────────
export const TakeoffWarning = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  geometryRefs: z.array(z.string()).optional(),
})
export type TakeoffWarning = z.infer<typeof TakeoffWarning>

// ─── Top-level result ─────────────────────────────────────────────────────
export const TakeoffResult = z.object({
  schemaVersion: SchemaVersion,
  takeoffId: z.string().uuid(),
  projectId: z.string().min(1),
  capturedAt: z.string().datetime({ offset: true }),
  producedAt: z.string().datetime({ offset: true }),
  source: CaptureSource,
  pipelineVersion: z.string().regex(/^\d+\.\d+\.\d+/),
  units: z.enum(['imperial', 'metric']),
  quantities: z.array(TakeoffQuantity).min(1),
  geometry: TakeoffGeometry.optional(),
  sourceArtifact: SourceArtifact.optional(),
  warnings: z.array(TakeoffWarning).optional(),
  reviewRequired: z.boolean().optional(),
})
export type TakeoffResult = z.infer<typeof TakeoffResult>

// ─── Confidence floor ─────────────────────────────────────────────────────
export const REVIEW_REQUIRED_CONFIDENCE_FLOOR = 0.7

/** Set `reviewRequired` and emit a warning if any quantity is below the floor. */
export function applyReviewFloor(result: TakeoffResult): TakeoffResult {
  const lowConf = result.quantities.filter((q) => q.confidence < REVIEW_REQUIRED_CONFIDENCE_FLOOR)
  if (lowConf.length === 0) return result
  const warnings = result.warnings ? [...result.warnings] : []
  warnings.push({
    code: 'low_confidence_quantities',
    severity: 'warn',
    message: `${lowConf.length} quantity(ies) below confidence floor ${REVIEW_REQUIRED_CONFIDENCE_FLOOR}`,
  })
  return { ...result, reviewRequired: true, warnings }
}

// ─── Confidence helpers per source ───────────────────────────────────────
const ROOMPLAN_CONF_BUCKETS = { high: 0.95, medium: 0.75, low: 0.45 } as const

export function roomplanConfidenceToScore(bucket: 'high' | 'medium' | 'low'): number {
  return ROOMPLAN_CONF_BUCKETS[bucket]
}

export function droneConfidenceFromGsd(reconstructorConfidence: number, gsdCm: number): number {
  return reconstructorConfidence * Math.min(1, 2 / Math.max(gsdCm, 0.01))
}

export function derivedConfidence(parentConfidences: number[]): number {
  if (parentConfidences.length === 0) return 0.5
  return Math.min(...parentConfidences) * 0.9
}
