import { describe, expect, it } from 'vitest'
import { blueprintReferenceKind, buildBlueprintReference } from './blueprint-reference'
import type { BlueprintDocument, BlueprintPage } from '@/lib/api'

const blueprint = {
  id: 'blueprint-1',
  project_id: 'project-1',
  file_name: 'Plan Set.pdf',
  storage_path: 'co-1/blueprint-1/Plan-Set.pdf',
  preview_type: 'storage_path',
  calibration_length: null,
  calibration_unit: null,
  sheet_scale: null,
  version: 1,
  deleted_at: null,
  replaces_blueprint_document_id: null,
  created_at: '2026-05-20T00:00:00.000Z',
} satisfies BlueprintDocument

const page = {
  id: 'page-1',
  blueprint_document_id: 'blueprint-1',
  page_number: 2,
  storage_path: 'co-1/blueprint-1/pages/page-2.png',
  calibration_world_distance: null,
  calibration_world_unit: null,
  calibration_x1: null,
  calibration_y1: null,
  calibration_x2: null,
  calibration_y2: null,
  calibration_set_at: null,
  measurement_count: 0,
} satisfies BlueprintPage

describe('blueprint reference helpers', () => {
  it('uses a page file route as a texture source when the page storage path is an image', () => {
    expect(buildBlueprintReference(blueprint, page)).toEqual({
      label: 'Plan Set.pdf · page 2',
      filePath: '/api/blueprint-pages/page-1/file',
      texturePath: '/api/blueprint-pages/page-1/file',
      sourceName: 'page-2.png',
      kind: 'image',
    })
  })

  it('falls back to the document file route and does not texture PDFs', () => {
    expect(buildBlueprintReference(blueprint, { ...page, storage_path: null, page_number: 1 })).toEqual({
      label: 'Plan Set.pdf · page 1',
      filePath: '/api/blueprint-pages/page-1/file',
      texturePath: null,
      sourceName: 'Plan Set.pdf',
      kind: 'pdf',
    })
  })

  it('classifies supported image sources only', () => {
    expect(blueprintReferenceKind('sheet.PNG')).toBe('image')
    expect(blueprintReferenceKind('sheet.webp')).toBe('image')
    expect(blueprintReferenceKind('sheet.pdf')).toBe('pdf')
    expect(blueprintReferenceKind('sheet.tiff')).toBe('unsupported')
  })
})
