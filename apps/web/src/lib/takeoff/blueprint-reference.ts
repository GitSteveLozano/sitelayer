import type { BlueprintDocument, BlueprintPage } from '@/lib/api'

export interface BlueprintReference {
  label: string
  filePath: string
  texturePath: string | null
  sourceName: string
  kind: 'image' | 'pdf' | 'unsupported'
}

export function buildBlueprintReference(
  blueprint: BlueprintDocument | null | undefined,
  page: BlueprintPage | null | undefined,
): BlueprintReference | null {
  if (!blueprint) return null

  const pageNumber = page?.page_number ?? 1
  const pageStoragePath = normalizePath(page?.storage_path)
  const sourceName = pageStoragePath ? fileNameFromPath(pageStoragePath) : blueprint.file_name
  const filePath = page?.id
    ? `/api/blueprint-pages/${encodeURIComponent(page.id)}/file`
    : `/api/blueprints/${encodeURIComponent(blueprint.id)}/file`
  const kind = blueprintReferenceKind(sourceName)

  return {
    label: `${blueprint.file_name} · page ${pageNumber}`,
    filePath,
    texturePath: kind === 'image' ? filePath : null,
    sourceName,
    kind,
  }
}

export function blueprintReferenceKind(sourceName: string): BlueprintReference['kind'] {
  const lower = sourceName.toLowerCase()
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) {
    return 'image'
  }
  if (lower.endsWith('.pdf')) return 'pdf'
  return 'unsupported'
}

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}
