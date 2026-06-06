import { z } from 'zod'

/**
 * Hand-authored "labeled-mesh" JSON describing a photogrammetry capture that
 * has already been semantically segmented (typically via the manual-labeling
 * stub UI from research/02-photogrammetry.md §6 day 2).
 *
 * This is the **input contract** for Path B (labeled-mesh → TakeoffResult)
 * and is metric throughout. The pipeline converts to imperial at the seam.
 */

export const LabeledMeshScale = z.object({
  method: z.enum([
    'vendor-arkit-depth',
    'vendor-arcore-depth',
    'fiducial-marker',
    'known-object',
    'manual-two-point',
    'unscaled',
  ]),
  metersPerUnit: z.number().positive(),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
})
export type LabeledMeshScale = z.infer<typeof LabeledMeshScale>

export const LabeledRoom = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  floorAreaM2: z.number().nonnegative(),
  perimeterM: z.number().nonnegative(),
  ceilingHeightM: z.number().positive().optional(),
})
export type LabeledRoom = z.infer<typeof LabeledRoom>

export const LabeledSurfaceKind = z.enum(['wall', 'floor', 'ceiling', 'door', 'window', 'opening'])
export type LabeledSurfaceKind = z.infer<typeof LabeledSurfaceKind>

export const LabeledSurfaceSource = z.enum([
  'vendor-auto',
  'ransac-planes',
  'reprojected-2d-segmentation',
  'human-labeled',
])
export type LabeledSurfaceSource = z.infer<typeof LabeledSurfaceSource>

export const LabeledSurface = z.object({
  id: z.string().min(1),
  kind: LabeledSurfaceKind,
  areaM2: z.number().nonnegative(),
  parentRoomId: z.string().min(1).optional(),
  source: LabeledSurfaceSource,
  confidence: z.number().min(0).max(1),
})
export type LabeledSurface = z.infer<typeof LabeledSurface>

export const LabeledMeshQA = z.object({
  coveragePct: z.number().min(0).max(100),
  blindSpots: z.array(z.string()),
  reconstructionMeanErrorM: z.number().nonnegative().optional(),
})
export type LabeledMeshQA = z.infer<typeof LabeledMeshQA>

export const LabeledMesh = z.object({
  meshUrl: z.string().min(1),
  meshFormat: z.enum(['obj', 'glb', 'usdz']),
  captureId: z.string().min(1),
  capturedAt: z.string().datetime({ offset: true }),
  vendor: z.enum(['luma', 'polycam', 'kiri', 'colmap-self-hosted', 'apple-object-capture']).optional(),
  vendorJobId: z.string().optional(),
  pointCloudUrl: z.string().optional(),
  textureAtlasUrl: z.string().optional(),
  previewImageUrl: z.string().optional(),
  scale: LabeledMeshScale,
  rooms: z.array(LabeledRoom),
  surfaces: z.array(LabeledSurface),
  qa: LabeledMeshQA,
})
export type LabeledMesh = z.infer<typeof LabeledMesh>

export class LabeledMeshValidationError extends Error {
  constructor(
    message: string,
    public issues: z.ZodIssue[],
  ) {
    super(message)
    this.name = 'LabeledMeshValidationError'
  }
}

export function parseLabeledMesh(input: unknown): LabeledMesh {
  const parsed = LabeledMesh.safeParse(input)
  if (!parsed.success) {
    throw new LabeledMeshValidationError('LabeledMesh validation failed', parsed.error.issues)
  }
  return parsed.data
}
