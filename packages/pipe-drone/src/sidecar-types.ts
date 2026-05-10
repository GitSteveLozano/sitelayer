// Path B sidecar JSON: precomputed reconstruction metadata.
//
// In the spike we don't parse GeoTIFFs in TypeScript. Instead we accept a
// JSON sidecar that mirrors `DroneArtifact` from @sitelayer-capture/schema
// plus enough context for buildDroneTakeoff to emit a TakeoffResult.
//
// The schema package only exports the TypeScript type for `DroneArtifact`
// (the runtime zod is module-local), so we redeclare the zod here. Keep
// shape parity — when the schema is bumped, update this file too.

import { z } from 'zod'

const GeoJSONPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.array(z.number()))),
})

export const DroneSidecarSchema = z.object({
  siteCenter: z.object({ lat: z.number(), lon: z.number() }),
  crs: z.string(),
  reconstruction: z.object({
    engine: z.enum(['ODM', 'DroneDeploy', 'Pix4D', 'EagleView', 'Hover']),
    imageCount: z.number().int().min(0),
    gsdCm: z.number().positive(),
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
      footprint: GeoJSONPolygonSchema,
      footprintAreaSqft: z.number().nonnegative(),
      eaveHeightFt: z.number().nonnegative(),
      ridgeHeightFt: z.number().nonnegative(),
      exteriorWallAreaSqft: z.number().nonnegative(),
      roofPlanes: z.array(
        z.object({
          id: z.string(),
          polygon: GeoJSONPolygonSchema,
          areaSqft: z.number().nonnegative(),
          projectedAreaSqft: z.number().nonnegative(),
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
      cutCubicYards: z.number().nonnegative(),
      fillCubicYards: z.number().nonnegative(),
      netCubicYards: z.number(),
      boundary: GeoJSONPolygonSchema,
    })
    .optional(),
  surfacing: z
    .array(
      z.object({
        id: z.string(),
        material: z.enum(['asphalt', 'concrete', 'gravel', 'pavers', 'vegetation', 'bare-soil', 'other']),
        polygon: GeoJSONPolygonSchema,
        areaSqft: z.number().nonnegative(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .optional(),
})

export type DroneSidecar = z.infer<typeof DroneSidecarSchema>
