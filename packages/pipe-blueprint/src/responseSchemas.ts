import { z } from 'zod'

// ─── Classify response ────────────────────────────────────────────────────

export const ClassifyKind = z.enum([
  'floor_plan',
  'elevation',
  'section',
  'site_plan',
  'detail',
  'schedule',
  'titleblock_only',
  'non_drawing',
])
export type ClassifyKind = z.infer<typeof ClassifyKind>

export const ClassifyPage = z.object({
  pageIndex: z.number().int().min(0),
  kind: ClassifyKind,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().default(''),
})
export type ClassifyPage = z.infer<typeof ClassifyPage>

export const ClassifyResponse = z.object({
  pages: z.array(ClassifyPage).min(1),
})
export type ClassifyResponse = z.infer<typeof ClassifyResponse>

// ─── Extract response ─────────────────────────────────────────────────────

const Pt = z.object({ x: z.number(), y: z.number() })

export const ExtractOpening = z.object({
  kind: z.enum(['door', 'window', 'opening']),
  position: Pt,
  annotatedWidthText: z.string().nullable().optional(),
  swing: z.enum(['left', 'right', 'none']).nullable().optional(),
  hostWallId: z.string().nullable().optional(),
})
export type ExtractOpening = z.infer<typeof ExtractOpening>

export const ExtractRoom = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  polygon: z.array(Pt).min(3),
  annotatedAreaText: z.string().nullable().optional(),
  annotatedPerimeterText: z.string().nullable().optional(),
  openings: z.array(ExtractOpening).default([]),
})
export type ExtractRoom = z.infer<typeof ExtractRoom>

export const ExtractWall = z.object({
  id: z.string().min(1),
  start: Pt,
  end: Pt,
  thicknessIn: z.number().nullable().optional(),
  annotatedLengthText: z.string().nullable().optional(),
})
export type ExtractWall = z.infer<typeof ExtractWall>

export const ExtractTitleblock = z
  .object({
    projectName: z.string().nullable().optional(),
    sheetNumber: z.string().nullable().optional(),
    sheetTitle: z.string().nullable().optional(),
    scaleText: z.string().nullable().optional(),
    northArrowDeg: z.number().nullable().optional(),
    drawingDate: z.string().nullable().optional(),
  })
  .nullable()
export type ExtractTitleblock = z.infer<typeof ExtractTitleblock>

export const ExtractResponse = z.object({
  imageSize: z.object({
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
  }),
  titleblock: ExtractTitleblock.optional(),
  dimensionStrings: z.array(z.string()).default([]),
  rooms: z.array(ExtractRoom).default([]),
  walls: z.array(ExtractWall).default([]),
  notes: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
})
export type ExtractResponse = z.infer<typeof ExtractResponse>
