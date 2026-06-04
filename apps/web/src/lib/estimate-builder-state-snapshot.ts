import type { CaptureStateProviderSnapshot } from './capture-state-providers'
import type { EstimateLine, ScopeVsBidResponse } from './api/estimate'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export type EstimateBuilderStateSnapshotInput = {
  projectId: string
  routePath?: string | null
  reason: string
  project?: {
    id?: string
    name?: string | null
    status?: string | null
    customer_name?: string | null
    bid_total?: string | number | null
  } | null
  snapshot: ScopeVsBidResponse | null
  pendingEdits: Record<string, unknown>
  selectedCategory: string | null
  activeProfile?: { id?: string | null; name?: string | null } | null
  ui: {
    isLoading: boolean
    isSaving: boolean
    isRecomputing: boolean
    hasDirtyEdits: boolean
    conflict: boolean
    error: string | null
    compactKeystone: boolean
    shareSheetOpen: boolean
    keystoneSheetOpen: boolean
  }
}

export function buildEstimateBuilderStateSnapshot(
  input: EstimateBuilderStateSnapshotInput,
): CaptureStateProviderSnapshot {
  const lineStats = summarizeLines(input.snapshot?.lines ?? [])
  return {
    schema: 'sitelayer.estimate-builder.state.v1',
    kind: 'state_snapshot',
    piiLevel: 'internal',
    metadata: {
      route_state: true,
      surface: 'estimate_builder',
      project_id: input.projectId,
      line_count: lineStats.line_count,
      pending_edit_count: Object.keys(input.pendingEdits).length,
    },
    payload: {
      schema_version: 1,
      surface: 'estimate_builder',
      reason: input.reason,
      route_path: normalizeRoutePath(input.routePath),
      project: input.project
        ? {
            id: input.project.id ?? input.projectId,
            name: input.project.name ?? null,
            status: input.project.status ?? null,
            customer_name: input.project.customer_name ?? null,
            bid_total: normalizeNumber(input.project.bid_total),
          }
        : { id: input.projectId },
      machine: {
        status: input.ui.isLoading
          ? 'loading'
          : input.ui.isSaving
            ? 'saving'
            : input.ui.isRecomputing
              ? 'recomputing'
              : input.ui.conflict
                ? 'conflict'
                : input.ui.error
                  ? 'error'
                  : 'idle',
        has_dirty_edits: input.ui.hasDirtyEdits,
        pending_edit_count: Object.keys(input.pendingEdits).length,
        conflict: input.ui.conflict,
        error: input.ui.error,
      },
      filters: {
        selected_category: input.selectedCategory,
        compact_keystone: input.ui.compactKeystone,
        share_sheet_open: input.ui.shareSheetOpen,
        keystone_sheet_open: input.ui.keystoneSheetOpen,
        active_pricing_profile: input.activeProfile
          ? {
              id: input.activeProfile.id ?? null,
              name: input.activeProfile.name ?? null,
            }
          : null,
      },
      estimate: input.snapshot
        ? {
            bid_total: input.snapshot.bid_total,
            scope_total: input.snapshot.scope_total,
            delta: input.snapshot.delta,
            delta_pct: input.snapshot.delta_pct,
            status: input.snapshot.status,
            draft_id: input.snapshot.draft_id,
            is_stale: input.snapshot.is_stale ?? null,
            recomputed_at: input.snapshot.recomputed_at ?? null,
            source_updated_at: input.snapshot.source_updated_at ?? null,
          }
        : null,
      lines: lineStats,
    },
  }
}

function summarizeLines(lines: readonly EstimateLine[]): JsonObject {
  const byDivision: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const topServiceItems: Array<{ id: string; count: number; amount: number }> = []
  const serviceTotals = new Map<string, { count: number; amount: number }>()
  for (const line of lines) {
    const division = line.division_code || 'uncategorized'
    byDivision[division] = (byDivision[division] ?? 0) + 1
    const kind = line.kind || 'flat'
    byKind[kind] = (byKind[kind] ?? 0) + 1
    const current = serviceTotals.get(line.service_item_code) ?? { count: 0, amount: 0 }
    current.count += 1
    current.amount += normalizeNumber(line.amount) ?? 0
    serviceTotals.set(line.service_item_code, current)
  }
  for (const [id, value] of serviceTotals.entries()) {
    topServiceItems.push({ id, count: value.count, amount: Math.round(value.amount * 100) / 100 })
  }
  topServiceItems.sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id))
  return {
    line_count: lines.length,
    by_division: sortCountMap(byDivision),
    by_kind: sortCountMap(byKind),
    top_service_items: topServiceItems.slice(0, 20),
  }
}

function sortCountMap(map: Record<string, number>): JsonObject[] {
  return Object.entries(map)
    .sort(([aKey, aCount], [bKey, bCount]) => bCount - aCount || aKey.localeCompare(bKey))
    .map(([id, count]) => ({ id, count }))
}

function normalizeNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeRoutePath(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value, 'https://sitelayer.local').pathname
  } catch {
    return value.split('?')[0] || null
  }
}
